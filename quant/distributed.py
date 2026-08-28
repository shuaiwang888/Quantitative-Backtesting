"""可选 Redis 协调层。

不配 ``REDIS_URL`` 或 Redis 暂时不可用时，调用方继续使用进程内
限流/锁，不让可选基础设施变成单点故障。
"""

from __future__ import annotations

import hashlib
import secrets
import threading
import time
from typing import Optional, Tuple

from quant.config import get_settings
from quant.logging_setup import get_logger


_LOG = get_logger("distributed")
_coordinator: Optional["RedisCoordinator"] = None
_coordinator_url = ""
_coordinator_lock = threading.Lock()


class RedisCoordinator:
    def __init__(self, url: str, prefix: str, socket_timeout: float) -> None:
        import redis

        self.client = redis.Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=socket_timeout,
            socket_timeout=socket_timeout,
            health_check_interval=30,
        )
        self.prefix = prefix.strip(":") or "quant-backtest"
        self._disabled_until = 0.0

    def _available(self) -> bool:
        return time.monotonic() >= self._disabled_until

    def _failed(self, exc: Exception) -> None:
        if self._available():
            _LOG.warning("Redis 暂不可用，30 秒内回退到本地保护: %s", exc.__class__.__name__)
        self._disabled_until = time.monotonic() + 30.0

    def rate_limit(
        self, key: str, limit: int, window_seconds: int
    ) -> Optional[Tuple[bool, int]]:
        """返回 ``(allowed, retry_after)``；None 表示 Redis 不可用。"""
        if not self._available():
            return None
        digest = hashlib.sha256(key.encode("utf-8", errors="replace")).hexdigest()
        bucket = int(time.time() // window_seconds)
        redis_key = f"{self.prefix}:rate:{bucket}:{digest}"
        script = """
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        local ttl = redis.call('TTL', KEYS[1])
        return {current, ttl}
        """
        try:
            current, ttl = self.client.eval(script, 1, redis_key, window_seconds + 1)
            return int(current) <= limit, max(1, int(ttl))
        except Exception as exc:  # noqa: BLE001
            self._failed(exc)
            return None

    def acquire_lock(self, name: str, ttl_seconds: int) -> Tuple[bool, Optional[str]]:
        """返回 ``(can_continue, token)``；token=None 代表回退本地锁。"""
        if not self._available():
            return True, None
        token = secrets.token_urlsafe(24)
        try:
            acquired = self.client.set(
                f"{self.prefix}:lock:{name}", token, nx=True, ex=max(1, ttl_seconds)
            )
            return bool(acquired), token if acquired else None
        except Exception as exc:  # noqa: BLE001
            self._failed(exc)
            return True, None

    def release_lock(self, name: str, token: Optional[str]) -> None:
        if not token or not self._available():
            return
        script = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
        """
        try:
            self.client.eval(script, 1, f"{self.prefix}:lock:{name}", token)
        except Exception as exc:  # noqa: BLE001
            self._failed(exc)


def get_redis_coordinator() -> Optional[RedisCoordinator]:
    global _coordinator, _coordinator_url
    settings = get_settings()
    url = settings.redis_url.strip()
    if not url:
        return None
    if _coordinator is None or _coordinator_url != url:
        with _coordinator_lock:
            if _coordinator is None or _coordinator_url != url:
                try:
                    _coordinator = RedisCoordinator(
                        url, settings.redis_prefix, settings.redis_socket_timeout
                    )
                    _coordinator_url = url
                except Exception as exc:  # ImportError 也要优雅降级
                    _LOG.warning("Redis 协调层未启用: %s", exc.__class__.__name__)
                    return None
    return _coordinator


def reset_redis_coordinator() -> None:
    """测试/重载配置时清理连接引用。"""
    global _coordinator, _coordinator_url
    with _coordinator_lock:
        if _coordinator is not None:
            try:
                _coordinator.client.close()
            except Exception:  # noqa: BLE001
                pass
        _coordinator = None
        _coordinator_url = ""


__all__ = ["RedisCoordinator", "get_redis_coordinator", "reset_redis_coordinator"]
