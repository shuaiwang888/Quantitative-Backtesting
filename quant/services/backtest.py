"""单标的/指数回测服务。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.iwencai import IwencaiError, fetch_all
from quant.data.normalization import build_history_query, normalize_bars
from quant.errors import UpstreamError, ValidationError
from quant.logging_setup import get_logger
from quant.persistence import persist_bars
from quant.strategies import SPECS, get_spec, min_bars, run_backtest


_LOG = get_logger("backtest_service")

INDEX_SYMBOLS: Dict[str, str] = {
    "hs300": "000300.SH",
    "zz500": "000905.SH",
    "zz1000": "000852.SH",
}

UNIVERSE_QUERIES: Dict[str, str] = {
    "hs300": "沪深300成分股 股票代码 股票简称",
    "zz500": "中证500成分股 股票代码 股票简称",
    "zz1000": "中证1000成分股 股票代码 股票简称",
}


@dataclass
class BacktestRequest:
    strategy: str
    backtest_mode: str = "single"  # single / index
    symbol: str = ""
    index_symbol: str = "hs300"
    start_date: str = ""
    end_date: str = ""
    query: str = ""
    initial_cash: float = 100000.0
    fee_rate: float = 0.0003
    persist: bool = False
    api_key: Optional[str] = None
    limit: int = 100
    max_pages: int = 10
    strategy_params: Optional[Dict[str, Any]] = None


def run_single_backtest(req: BacktestRequest) -> Dict[str, Any]:
    """单标的 / 指数回测全流程。"""
    if req.strategy not in SPECS:
        raise ValidationError(
            f"未知策略: {req.strategy}",
            details={"field": "strategy", "available": list(SPECS)},
        )
    if req.backtest_mode not in ("single", "index"):
        raise ValidationError(
            f"未知 backtest_mode: {req.backtest_mode}",
            details={"field": "backtest_mode"},
        )

    symbol = req.symbol.strip()
    if req.backtest_mode == "index":
        symbol = INDEX_SYMBOLS.get(req.index_symbol)
        if not symbol:
            raise ValidationError(
                f"未知指数: {req.index_symbol}",
                details={"field": "index_symbol", "available": list(INDEX_SYMBOLS)},
            )

    query_text = req.query.strip()
    if not query_text:
        if not symbol or not req.start_date or not req.end_date:
            raise ValidationError(
                "请填写股票代码/名称、开始日期和结束日期，或直接填写数据查询语句",
                details={"field": "query"},
            )
        query_text = build_history_query(symbol, req.start_date, req.end_date)

    try:
        response = fetch_all(
            query_text,
            api_key=req.api_key,
            limit=min(req.limit, 100),
            max_pages=max(1, min(req.max_pages, 20)),
        )
    except IwencaiError as exc:
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc

    bars = normalize_bars(response.get("datas", []))
    if len(bars) < min_bars(req.strategy):
        raise ValidationError(
            f"可用K线不足，至少需要 {min_bars(req.strategy)} 条",
            details={"got": len(bars), "strategy": req.strategy},
        )

    persistence = _safe_persist_bars(bars, query_text, req.start_date, req.end_date, req.persist)
    params = req.strategy_params or {}
    result = run_backtest(
        req.strategy,
        bars,
        initial_cash=req.initial_cash,
        fee_rate=req.fee_rate,
        **params,
    )
    result["success"] = True
    result["query"] = query_text
    result["symbol"] = symbol or ""
    result["trace_ids"] = response.get("trace_ids", [])
    result["persistence"] = persistence
    return result


def _safe_persist_bars(
    bars: Any,
    query_text: str,
    start_date: str,
    end_date: str,
    request_persist: bool,
) -> Dict[str, Any]:
    auto = get_settings().mysql_auto_persist
    if not (auto or request_persist):
        return {"enabled": False, "saved": 0, "type": "daily_bars"}
    try:
        return persist_bars(bars, query_text)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("持久化 K 线失败（已忽略）: %s", exc)
        return {
            "enabled": True,
            "saved": 0,
            "type": "daily_bars",
            "error": str(exc.__class__.__name__),
        }


__all__ = ["BacktestRequest", "run_single_backtest", "INDEX_SYMBOLS", "UNIVERSE_QUERIES"]
