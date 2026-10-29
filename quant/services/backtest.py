"""单标的/指数回测服务。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.iwencai import IwencaiError, fetch_all
from quant.data.normalization import build_history_query, normalize_bars
from quant.errors import UpstreamError, ValidationError
from quant.logging_setup import get_logger
from quant.persistence import persist_bars
from quant.strategies import SPECS, min_bars, run_backtest
from quant.services.validation import (
    validate_date_range,
    validate_strategy_params,
    validate_execution_inputs,
    validate_financial_inputs,
    validate_paging,
    validate_query_text,
    validate_single_series,
    validate_symbol,
)


_LOG = get_logger("backtest_service")

INDEX_SYMBOLS: Dict[str, str] = {
    "sse": "000001.SH",
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
    slippage_rate: float = 0.0005
    min_commission: float = 5.0
    stamp_duty_rate: float = 0.0005
    transfer_fee_rate: float = 0.00001
    lot_size: int = 100
    max_pending_bars: int = 5
    price_limit_pct: Optional[float] = None
    persist: bool = False
    api_key: Optional[str] = None
    limit: int = 100
    max_pages: int = 10
    strategy_params: Optional[Dict[str, Any]] = None


def run_single_backtest(req: BacktestRequest) -> Dict[str, Any]:
    """单标的 / 指数回测全流程。"""
    validate_financial_inputs(req.initial_cash, req.fee_rate)
    validate_execution_inputs(
        slippage_rate=req.slippage_rate,
        min_commission=req.min_commission,
        stamp_duty_rate=req.stamp_duty_rate,
        transfer_fee_rate=req.transfer_fee_rate,
        lot_size=req.lot_size,
        max_pending_bars=req.max_pending_bars,
        price_limit_pct=req.price_limit_pct,
    )
    validate_paging(req.limit, req.max_pages)
    validate_date_range(req.start_date, req.end_date)
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

    # 先验证策略参数，避免错误输入仍然消耗上游额度。
    req.strategy_params = validate_strategy_params(req.strategy, req.initial_cash, req.fee_rate, req.strategy_params)
    symbol = validate_symbol(req.symbol)
    if req.backtest_mode == "index":
        symbol = INDEX_SYMBOLS.get(req.index_symbol)
        if not symbol:
            raise ValidationError(
                f"未知指数: {req.index_symbol}",
                details={"field": "index_symbol", "available": list(INDEX_SYMBOLS)},
            )

    query_text = validate_query_text(req.query)
    if not query_text:
        if not symbol or not req.start_date or not req.end_date:
            raise ValidationError(
                "请填写股票代码/名称、开始日期和结束日期，或直接填写数据查询语句",
                details={"field": "query"},
            )
        query_text = build_history_query(symbol, req.start_date, req.end_date)

    evaluation_start = None
    warmup_start = None
    try:
        if req.strategy == "sse_monthly_trend" and not req.query and req.start_date and req.end_date:
            begin, end = date.fromisoformat(req.start_date), date.fromisoformat(req.end_date)
            if begin.year < 1991 or end.year - begin.year > 25:
                raise ValidationError("指数研究开始日期不得早于 1991 年，区间最多 25 年")
            warmup_start = (begin - timedelta(days=420)).isoformat()
            response = _fetch_history_by_year(symbol, warmup_start, req.end_date, req.api_key)
            evaluation_start = req.start_date
        else:
            response = fetch_all(
                query_text, api_key=req.api_key, limit=min(req.limit, 100),
                max_pages=max(1, min(req.max_pages, 20)),
            )
    except IwencaiError as exc:
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc

    bars = normalize_bars(response.get("datas", []))
    if warmup_start:
        bars = [bar for bar in bars if warmup_start <= bar.date <= req.end_date]
    validate_single_series(bars)
    if evaluation_start and not any(bar.date >= evaluation_start for bar in bars):
        raise ValidationError("评估区间没有可用 K 线，请检查日期及上游数据")
    if len(bars) < min_bars(req.strategy, req.strategy_params):
        raise ValidationError(
            f"可用K线不足，至少需要 {min_bars(req.strategy, req.strategy_params)} 条",
            details={"got": len(bars), "strategy": req.strategy},
        )

    persistence = _safe_persist_bars(bars, query_text, req.start_date, req.end_date, req.persist)
    params = req.strategy_params or {}
    result = run_backtest(
        req.strategy,
        bars,
        initial_cash=req.initial_cash,
        fee_rate=req.fee_rate,
        slippage_rate=req.slippage_rate,
        min_commission=req.min_commission,
        stamp_duty_rate=req.stamp_duty_rate,
        transfer_fee_rate=req.transfer_fee_rate,
        lot_size=1 if req.backtest_mode == "index" else req.lot_size,
        max_pending_bars=req.max_pending_bars,
        price_limit_pct=req.price_limit_pct,
        evaluation_start=evaluation_start,
        **params,
    )
    if req.backtest_mode == "index":
        result["summary"]["instrument_type"] = "synthetic_index"
        result["summary"]["research_note"] = "指数单位模拟，最小单位为 1；指数本身不能直接交易，结果不代表 ETF 实盘收益。"
    result["warmup_start"] = warmup_start
    result["evaluation_start"] = evaluation_start
    result["success"] = True
    result["query"] = query_text
    result["symbol"] = symbol or ""
    result["trace_ids"] = response.get("trace_ids", [])
    result["persistence"] = persistence
    return result


def _fetch_history_by_year(symbol: str, start: str, end: str, api_key: Optional[str]) -> Dict[str, Any]:
    """按年取数避免长区间静默截断；只缓存到本次请求，不持有访客密钥。"""
    rows = []
    traces = []
    for year in range(int(start[:4]), int(end[:4]) + 1):
        first, last = max(start, f"{year}-01-01"), min(end, f"{year}-12-31")
        response = fetch_all(build_history_query(symbol, first, last), api_key=api_key, limit=100, max_pages=4)
        rows.extend(response.get("datas", []))
        traces.extend(response.get("trace_ids", []))
    return {"datas": rows, "trace_ids": traces}


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
