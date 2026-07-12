"""数据写入层：把 Bar 和指标快照落库。

修复历史 bug：
- 原 indicator_snapshots 的 query_hash 仅哈希 query_text，不含分页 → 第二页覆盖第一页。
  现在把 page 也纳入 hash 范围。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Iterable, List, Optional, Sequence

from quant.config import get_settings
from quant.data.normalization import (
    Bar,
    infer_asset_type,
    infer_snapshot_date,
    normalize_bar_for_persist,
    pick_text,
)
from quant.errors import PersistenceError
from quant.logging_setup import get_logger
from quant.persistence.pool import get_manager


_LOG = get_logger("persistence")
_PERSISTENCE_DISABLED = {"enabled": False, "saved": 0, "type": ""}


def _query_hash(query_text: str, page: int = 0, limit: int = 0) -> str:
    """对 (query, page, limit) 一起做 hash，避免分页之间互相覆盖。"""
    raw = f"{query_text}\x1fpage={page}\x1flimit={limit}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def persistence_enabled() -> bool:
    """持久化是否启用。

    - ``MYSQL_PERSIST_ENABLED=1`` → 全局启用（无论 auto_persist）
    - ``MYSQL_AUTO_PERSIST=1``    → 显式自动写库（兼容旧配置）
    - 两者都没开 → 关闭（写库入口直接 short-circuit 返回 disabled 元数据）

    历史上 ``persistence_enabled`` 只看 ``mysql_persist_enabled``，会让用户
    配了 ``MYSQL_AUTO_PERSIST=1`` 却发现没写库的踩坑。两者取 OR 才是正确语义。
    """
    settings = get_settings()
    return settings.mysql_persist_enabled or settings.mysql_auto_persist


def persist_bars(
    bars: Iterable[Bar],
    query_text: str = "",
    *,
    page: int = 0,
    limit: int = 0,
) -> Dict[str, Any]:
    """把 K 线批量 upsert 到 daily_bars。失败抛 PersistenceError。"""
    if not persistence_enabled():
        return {**_PERSISTENCE_DISABLED, "type": "daily_bars"}
    bar_rows = [normalize_bar_for_persist(b) for b in bars]
    if not bar_rows:
        return {"enabled": True, "saved": 0, "type": "daily_bars"}

    conn = get_manager().connect()
    saved = 0
    try:
        with conn.cursor() as cursor:
            for row in bar_rows:
                _upsert_security(cursor, row["symbol"], row["name"], infer_asset_type(row["symbol"]))
                cursor.execute(
                    """
                    INSERT INTO daily_bars
                      (symbol, trade_date, name, open, high, low, close, volume, amount, source, query_text, raw_json)
                    VALUES
                      (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'iwencai', %s, %s)
                    ON DUPLICATE KEY UPDATE
                      name=VALUES(name),
                      open=VALUES(open),
                      high=VALUES(high),
                      low=VALUES(low),
                      close=VALUES(close),
                      volume=VALUES(volume),
                      amount=VALUES(amount),
                      query_text=VALUES(query_text),
                      raw_json=VALUES(raw_json),
                      updated_at=CURRENT_TIMESTAMP
                    """,
                    (
                        row["symbol"],
                        row["trade_date"],
                        row["name"],
                        row["open"],
                        row["high"],
                        row["low"],
                        row["close"],
                        row["volume"],
                        row["amount"],
                        query_text,
                        json.dumps(row["raw"], ensure_ascii=False),
                    ),
                )
                saved += 1
        conn.commit()
        return {"enabled": True, "saved": saved, "type": "daily_bars"}
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        _LOG.exception("persist_bars 失败: %s", exc)
        raise PersistenceError(f"持久化 K 线失败: {exc.__class__.__name__}") from exc
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def persist_indicator_rows(
    rows: Iterable[Dict[str, Any]],
    query_text: str = "",
    *,
    page: int = 0,
    limit: int = 0,
) -> Dict[str, Any]:
    """把选股/指标结果落库到 indicator_snapshots。

    query_hash 包含分页信息（page, limit），避免多页之间互相覆盖。
    """
    if not persistence_enabled():
        return {**_PERSISTENCE_DISABLED, "type": "indicator_snapshots"}
    indicator_rows = [row for row in rows if isinstance(row, dict)]
    if not indicator_rows:
        return {"enabled": True, "saved": 0, "type": "indicator_snapshots"}

    qhash = _query_hash(query_text, page, limit)
    conn = get_manager().connect()
    saved = 0
    try:
        with conn.cursor() as cursor:
            for row in indicator_rows:
                symbol = pick_text(
                    row, ("股票代码", "代码", "证券代码", "code"), ("股票代码", "证券代码")
                )
                if not symbol:
                    continue
                name = pick_text(
                    row, ("股票简称", "股票名称", "名称", "name"), ("股票简称", "股票名称")
                )
                snapshot_date = infer_snapshot_date(row)
                _upsert_security(cursor, symbol, name, infer_asset_type(symbol))
                cursor.execute(
                    """
                    INSERT INTO indicator_snapshots
                      (symbol, snapshot_date, name, query_hash, query_text, metrics_json, source)
                    VALUES
                      (%s, %s, %s, %s, %s, %s, 'iwencai')
                    ON DUPLICATE KEY UPDATE
                      name=VALUES(name),
                      metrics_json=VALUES(metrics_json),
                      updated_at=CURRENT_TIMESTAMP
                    """,
                    (
                        symbol,
                        snapshot_date,
                        name,
                        qhash,
                        query_text,
                        json.dumps(row, ensure_ascii=False),
                    ),
                )
                saved += 1
        conn.commit()
        return {"enabled": True, "saved": saved, "type": "indicator_snapshots"}
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        _LOG.exception("persist_indicator_rows 失败: %s", exc)
        raise PersistenceError(f"持久化指标失败: {exc.__class__.__name__}") from exc
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _upsert_security(cursor: Any, symbol: str, name: str, asset_type: str) -> None:
    exchange = symbol.split(".")[-1] if "." in symbol else ""
    cursor.execute(
        """
        INSERT INTO securities (symbol, name, asset_type, exchange)
        VALUES (%s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
          name=IF(VALUES(name)='', name, VALUES(name)),
          asset_type=VALUES(asset_type),
          exchange=VALUES(exchange),
          updated_at=CURRENT_TIMESTAMP
        """,
        (symbol, name or "", asset_type, exchange),
    )


__all__ = [
    "persistence_enabled",
    "persist_bars",
    "persist_indicator_rows",
]
