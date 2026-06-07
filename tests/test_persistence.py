"""持久化层测试（不需要真实 MySQL）。"""

from __future__ import annotations

import os

import pytest

from quant.config import reset_settings_cache
from quant.data.normalization import Bar
from quant.persistence import (
    init_persistence,
    persist_bars,
    persist_indicator_rows,
    persistence_enabled,
)
from quant.persistence.pool import reset_manager


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("IWENCAI_API_KEY", "test")
    monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
    reset_settings_cache()
    reset_manager()
    init_persistence()
    yield
    reset_manager()


class TestDisabled:
    def test_persistence_disabled_returns_disabled(self):
        assert persistence_enabled() is False
        result = persist_bars([Bar(date="2024-01-01", close=10.0, code="300033.SZ")])
        assert result["enabled"] is False
        assert result["saved"] == 0

    def test_indicator_persist_disabled(self):
        result = persist_indicator_rows([{"股票代码": "300033"}])
        assert result["enabled"] is False


class TestQueryHash:
    def test_hash_differs_by_page(self):
        from quant.persistence.repository import _query_hash
        h1 = _query_hash("test", page=1, limit=10)
        h2 = _query_hash("test", page=2, limit=10)
        assert h1 != h2

    def test_hash_differs_by_limit(self):
        from quant.persistence.repository import _query_hash
        h1 = _query_hash("test", page=1, limit=10)
        h2 = _query_hash("test", page=1, limit=20)
        assert h1 != h2

    def test_hash_stable_for_same_args(self):
        from quant.persistence.repository import _query_hash
        h1 = _query_hash("test", page=1, limit=10)
        h2 = _query_hash("test", page=1, limit=10)
        assert h1 == h2


class TestNormalizeForPersist:
    def test_missing_symbol_raises(self):
        from quant.data.normalization import normalize_bar_for_persist

        with pytest.raises(ValueError, match="缺少证券代码"):
            normalize_bar_for_persist(Bar(date="2024-01-01", close=10.0))


class TestPoolStates:
    """测试连接管理器的状态转换（不连真实 MySQL）。"""

    def test_disabled_state(self, monkeypatch):
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        reset_settings_cache()
        reset_manager()
        from quant.persistence.pool import get_manager

        init_persistence()
        manager = get_manager()
        assert manager.state == "disabled"

    def test_unavailable_state_when_no_pymysql(self, monkeypatch):
        """模拟 PyMySQL 不可用时进入 unavailable 状态。

        通过 sys.modules 注入会抛 ImportError 的伪模块。
        """
        import sys
        import types

        from quant.persistence.pool import get_manager

        class _RaisingModule(types.ModuleType):
            def __getattr__(self, name):
                raise ImportError(f"mocked: {self.__name__}.{name} not available")

        # 用 raising module 替换，让 `from dbutils.pooled_db import PooledDB` 在 import 阶段就抛 ImportError
        monkeypatch.setitem(sys.modules, "pymysql", _RaisingModule("pymysql"))
        monkeypatch.setitem(sys.modules, "dbutils", _RaisingModule("dbutils"))
        monkeypatch.setitem(sys.modules, "dbutils.pooled_db", _RaisingModule("dbutils.pooled_db"))

        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "1")
        reset_settings_cache()
        reset_manager()
        init_persistence()
        manager = get_manager()
        # DBUtils 缺失 / PyMySQL 缺失时进入 unavailable
        assert manager.state == "unavailable"
        with pytest.raises(Exception, match="缺少 PyMySQL"):
            manager.connect()
