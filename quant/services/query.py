"""查询服务：自然语言问财 + 可选持久化。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.iwencai import IwencaiError, fetch_all, normalize_response, query
from quant.data.normalization import normalize_bars
from quant.errors import UpstreamError, ValidationError
from quant.logging_setup import get_logger
from quant.persistence import persist_indicator_rows


_LOG = get_logger("query_service")


@dataclass(frozen=True)
class QueryRequest:
    query: str
    page: int = 1
    limit: int = 50
    parser_logic: bool = False
    persist: bool = False
    api_key: Optional[str] = None


def natural_language_query(req: QueryRequest) -> Dict[str, Any]:
    """单页查询问财。强制 limit 上限避免单次响应过大。"""
    if not req.query.strip():
        raise ValidationError("查询语句不能为空", details={"field": "query"})
    if req.limit < 1 or req.limit > 100:
        raise ValidationError(
            "limit 必须在 1-100 之间",
            details={"field": "limit", "got": req.limit},
        )
    if req.page < 1:
        raise ValidationError("page 必须 >= 1", details={"field": "page", "got": req.page})
    try:
        result = query(
            req.query,
            page=req.page,
            limit=req.limit,
            api_key=req.api_key,
            parser_logic=req.parser_logic,
        )
    except IwencaiError as exc:
        _LOG.warning("问财查询失败: %s", exc.message)
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc
    payload = normalize_response(req.query, result)
    payload["persistence"] = _safe_persist_indicators(
        payload.get("datas", []), req.query, req.page, req.limit, req.persist
    )
    return payload


def natural_language_query_all(
    query_text: str,
    *,
    api_key: Optional[str] = None,
    limit: int = 100,
    max_pages: int = 10,
) -> Dict[str, Any]:
    """翻页拉取全部数据。"""
    if not query_text.strip():
        raise ValidationError("查询语句不能为空", details={"field": "query"})
    try:
        return fetch_all(
            query_text,
            api_key=api_key,
            limit=min(limit, 100),
            max_pages=max(1, min(max_pages, 20)),
        )
    except IwencaiError as exc:
        _LOG.warning("问财翻页失败: %s", exc.message)
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc


def _safe_persist_indicators(
    rows: Any,
    query_text: str,
    page: int,
    limit: int,
    request_persist: bool,
) -> Dict[str, Any]:
    """根据配置 + 请求标志决定是否持久化，失败不抛异常。"""
    auto = get_settings().mysql_auto_persist
    if not (auto or request_persist):
        return {"enabled": False, "saved": 0, "type": "indicator_snapshots"}
    try:
        return persist_indicator_rows(rows, query_text, page=page, limit=limit)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("持久化指标失败（已忽略）: %s", exc)
        return {
            "enabled": True,
            "saved": 0,
            "type": "indicator_snapshots",
            "error": str(exc.__class__.__name__),
        }


__all__ = ["QueryRequest", "natural_language_query", "natural_language_query_all", "fetch_bars"]


def fetch_bars(
    query_text: str,
    *,
    api_key: Optional[str] = None,
    max_pages: int = 3,
    limit: int = 100,
) -> Dict[str, Any]:
    """拉近一年日 K 专用：翻页 + 归一化 + 元信息抽取。

    Returns:
        {symbol, name, bars: [{date, open, high, low, close, volume, ...}], source_count}
        失败时 raise UpstreamError。
    """
    if not query_text.strip():
        raise ValidationError("查询语句不能为空", details={"field": "query"})
    safe_limit = min(max(int(limit), 1), 100)
    safe_pages = max(1, min(int(max_pages), 20))
    try:
        response = fetch_all(
            query_text,
            api_key=api_key,
            limit=safe_limit,
            max_pages=safe_pages,
        )
    except IwencaiError as exc:
        _LOG.warning("问财 K 线拉取失败: %s", exc.message)
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc

    datas = response.get("datas", []) if isinstance(response, dict) else []
    if not datas:
        raise UpstreamError("问财未返回 K 线数据", details={"query": query_text})

    bars = normalize_bars(datas)
    if not bars:
        raise UpstreamError("K 线数据归一化失败（无有效 OHLC）", details={"query": query_text})

    first = bars[0]
    return {
        "symbol": getattr(first, "code", "") or "",
        "name": getattr(first, "name", "") or "",
        "bars": [b.to_dict() for b in bars],
        "source_count": len(datas),
    }
