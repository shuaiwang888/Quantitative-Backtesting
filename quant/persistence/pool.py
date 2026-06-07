"""MySQL 连接池（线程安全 + 失败降级）。

修复历史 bug：
- 原 _get_pool() 在多线程首次调用时会并发创建多个 PooledDB 实例。
- 缺 DBUtils 时没有正确缓存"不可用"状态，每次都重新尝试 import。
- 缺 PyMySQL 时应当抛清晰错误而不是用 None 静默绕过。

设计：
- 用 threading.Lock 保护首次初始化的竞态；成功后置位 `_initialized`。
- 区分三种状态：disabled / pool / direct / unavailable。
- 任何 connect() 调用都返回一个新连接（pool 用 pool.connection()，direct 用 pymysql.connect）。
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any, Optional

from quant.config import Settings
from quant.errors import PersistenceError


@dataclass(frozen=True)
class _MySQLConfig:
    host: str
    port: int
    unix_socket: str
    user: str
    password: str
    database: str
    charset: str = "utf8mb4"


def _build_config(settings: Settings) -> _MySQLConfig:
    return _MySQLConfig(
        host=settings.mysql_host,
        port=settings.mysql_port,
        unix_socket=settings.mysql_socket,
        user=settings.mysql_user,
        password=settings.mysql_password,
        database=settings.mysql_database,
    )


# 状态机：
#   disabled  - 持久化未启用
#   pool      - 使用 PooledDB
#   direct    - 使用 pymysql 直连（无池）
#   unavailable - PyMySQL 缺失
class _State:
    DISABLED = "disabled"
    POOL = "pool"
    DIRECT = "direct"
    UNAVAILABLE = "unavailable"


class ConnectionManager:
    """线程安全的连接管理器。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: str = _State.DISABLED
        self._pool: Optional[Any] = None
        self._config: Optional[_MySQLConfig] = None

    def configure(self, settings: Settings) -> None:
        """根据 Settings 决定持久化模式。仅在状态变更时操作。"""
        with self._lock:
            if not settings.mysql_persist_enabled:
                self._state = _State.DISABLED
                self._pool = None
                self._config = None
                return
            self._config = _build_config(settings)
            # 只在尚未初始化时尝试创建池
            if self._state in (_State.DISABLED, _State.UNAVAILABLE):
                self._try_initialize_locked()

    def _try_initialize_locked(self) -> None:
        if self._config is None:
            return
        try:
            from dbutils.pooled_db import PooledDB  # type: ignore
            import pymysql  # type: ignore
        except ImportError:
            self._state = _State.UNAVAILABLE
            self._pool = None
            return

        common = {
            "creator": pymysql,
            "user": self._config.user,
            "password": self._config.password,
            "database": self._config.database,
            "charset": self._config.charset,
        }
        if self._config.unix_socket:
            self._pool = PooledDB(
                unix_socket=self._config.unix_socket,
                maxconnections=20,
                mincached=2,
                maxcached=10,
                blocking=True,
                **common,
            )
        else:
            self._pool = PooledDB(
                host=self._config.host,
                port=self._config.port,
                maxconnections=20,
                mincached=2,
                maxcached=10,
                blocking=True,
                **common,
            )
        self._state = _State.POOL

    def connect(self) -> Any:
        """获取一个新连接。返回的对象支持 .cursor() / .commit() / .rollback() / .close()。"""
        with self._lock:
            state = self._state
            pool = self._pool
            config = self._config
        if state == _State.DISABLED:
            raise PersistenceError("MySQL 持久化未启用")
        if state == _State.UNAVAILABLE:
            raise PersistenceError("缺少 PyMySQL，请先执行 pip install PyMySQL")
        if state == _State.POOL and pool is not None:
            return pool.connection()
        if state == _State.DIRECT and config is not None:
            return self._direct_connect(config)
        raise PersistenceError(f"连接管理器处于未初始化状态: {state}")

    def fallback_to_direct(self) -> None:
        """在池化连接首次失败时调用：降级为直连模式。"""
        with self._lock:
            if self._state in (_State.POOL,):
                self._state = _State.DIRECT
                self._pool = None  # 释放池

    @staticmethod
    def _direct_connect(config: _MySQLConfig) -> Any:
        try:
            import pymysql  # type: ignore
        except ImportError as exc:
            raise PersistenceError("缺少 PyMySQL，请先执行 pip install PyMySQL") from exc
        kwargs: dict[str, Any] = {
            "user": config.user,
            "password": config.password,
            "database": config.database,
            "charset": config.charset,
        }
        if config.unix_socket:
            kwargs["unix_socket"] = config.unix_socket
        else:
            kwargs["host"] = config.host
            kwargs["port"] = config.port
        return pymysql.connect(**kwargs)

    @property
    def state(self) -> str:
        return self._state


_manager = ConnectionManager()


def get_manager() -> ConnectionManager:
    return _manager


def reset_manager() -> None:
    """测试辅助：清空 manager 状态。"""
    global _manager
    _manager = ConnectionManager()


__all__ = ["ConnectionManager", "get_manager", "reset_manager"]
