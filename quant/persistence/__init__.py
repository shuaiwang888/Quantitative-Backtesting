"""持久化层：连接池管理 + 仓库写入。"""

from quant.persistence.pool import ConnectionManager, get_manager, reset_manager
from quant.persistence.repository import (
    persist_bars,
    persist_indicator_rows,
    persistence_enabled,
)


def init_persistence() -> None:
    """应用启动时调用一次，根据 Settings 配置连接管理器。"""
    from quant.config import get_settings

    get_manager().configure(get_settings())


__all__ = [
    "ConnectionManager",
    "get_manager",
    "reset_manager",
    "init_persistence",
    "persist_bars",
    "persist_indicator_rows",
    "persistence_enabled",
]
