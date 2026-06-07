"""批量回测服务：股票池 / 自定义列表。"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from quant.config import get_settings
from quant.data.iwencai import IwencaiError, fetch_all
from quant.data.normalization import (
    Bar,
    build_history_query,
    normalize_bars,
    pick_text,
)
from quant.errors import UpstreamError, ValidationError
from quant.logging_setup import get_logger
from quant.services.backtest import UNIVERSE_QUERIES, _safe_persist_bars
from quant.strategies import SPECS, min_bars, run_backtest


_LOG = get_logger("batch_service")

# 进程级信号量：限制同时进行的问财请求总数，避免触发上游 QPS 限制
_request_semaphore: Optional[threading.Semaphore] = None
_semaphore_lock = threading.Lock()


def _get_semaphore() -> threading.Semaphore:
    global _request_semaphore
    if _request_semaphore is None:
        with _semaphore_lock:
            if _request_semaphore is None:
                _request_semaphore = threading.Semaphore(5)
    return _request_semaphore


@dataclass
class BatchRequest:
    strategy: str
    start_date: str
    end_date: str
    max_symbols: int = 20
    max_workers: int = 10
    universe: Optional[str] = None
    custom_symbols: Optional[str] = None
    initial_cash: float = 100000.0
    fee_rate: float = 0.0003
    persist: bool = False
    api_key: Optional[str] = None
    limit: int = 100
    max_pages: int = 10
    universe_limit: int = 100
    universe_pages: int = 5
    strategy_params: Dict[str, Any] = field(default_factory=dict)


def run_batch_backtest(req: BatchRequest) -> Dict[str, Any]:
    """批量回测入口。返回每只标的的 summary + 总体汇总。"""
    if req.strategy not in SPECS:
        raise ValidationError(
            f"未知策略: {req.strategy}",
            details={"field": "strategy", "available": list(SPECS)},
        )
    if not req.start_date or not req.end_date:
        raise ValidationError(
            "批量回测请填写开始日期和结束日期",
            details={"field": "start_date/end_date"},
        )

    settings = get_settings()
    max_symbols = max(1, min(req.max_symbols, settings.batch_max_symbols))
    max_workers = max(1, min(req.max_workers, settings.batch_max_workers))

    symbols = _resolve_symbols(req)[:max_symbols]
    if not symbols:
        raise ValidationError(
            "没有可回测的标的",
            details={"field": "universe/symbols"},
        )

    rows: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    semaphore = _get_semaphore()

    def run_one(code: str, name: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, str]]]:
        try:
            with semaphore:
                query_text = build_history_query(code, req.start_date, req.end_date)
                response = fetch_all(
                    query_text,
                    api_key=req.api_key,
                    limit=min(req.limit, 100),
                    max_pages=max(1, min(req.max_pages, 20)),
                )
            bars = normalize_bars(response.get("datas", []))
            if len(bars) < min_bars(req.strategy):
                return (
                    None,
                    {"symbol": code, "name": name, "error": f"K线不足（{len(bars)}<{min_bars(req.strategy)}）"},
                )
            persistence = _safe_persist_bars(bars, query_text, req.start_date, req.end_date, req.persist)
            result = run_backtest(
                req.strategy,
                bars,
                initial_cash=req.initial_cash,
                fee_rate=req.fee_rate,
                **(req.strategy_params or {}),
            )
            summary = result["summary"]
            return (
                {
                    "symbol": code,
                    "name": name or _bar_name(result.get("bars", [])),
                    "total_return": summary.get("total_return"),
                    "benchmark_return": summary.get("benchmark_return"),
                    "excess_return": summary.get("excess_return"),
                    "max_drawdown": summary.get("max_drawdown"),
                    "trade_count": summary.get("trade_count"),
                    "win_rate": summary.get("win_rate"),
                    "bar_count": summary.get("bar_count"),
                    "persistence": persistence,
                },
                None,
            )
        except IwencaiError as exc:
            return (None, {"symbol": code, "name": name, "error": f"问财错误: {exc.message}"})
        except Exception as exc:  # noqa: BLE001
            _LOG.exception("批量回测 %s 失败", code)
            return (None, {"symbol": code, "name": name, "error": f"{exc.__class__.__name__}: {exc}"})

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(run_one, code, name): (code, name) for code, name in symbols}
        for future in as_completed(futures):
            row, err = future.result()
            if err:
                errors.append(err)
            elif row:
                rows.append(row)

    return {
        "success": True,
        "mode": "batch",
        "universe": req.universe or "custom",
        "strategy": req.strategy,
        "summary": summarize_batch(rows, errors),
        "results": rows,
        "errors": errors,
    }


def _resolve_symbols(req: BatchRequest) -> List[Tuple[str, str]]:
    """先看 custom，再看 universe。"""
    if req.custom_symbols:
        return _parse_custom_symbols(req.custom_symbols)
    if not req.universe:
        raise ValidationError("需要填写 universe 或 custom_symbols", details={"field": "universe"})
    query_text = UNIVERSE_QUERIES.get(req.universe)
    if not query_text:
        raise ValidationError(
            f"未知股票池: {req.universe}",
            details={"field": "universe", "available": list(UNIVERSE_QUERIES)},
        )
    settings = get_settings()
    try:
        response = fetch_all(
            query_text,
            api_key=req.api_key,
            limit=min(req.universe_limit, 100),
            max_pages=max(1, min(req.universe_pages, 10)),
        )
    except IwencaiError as exc:
        raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc
    return _parse_universe_rows(response.get("datas", []))


def _parse_custom_symbols(raw: str) -> List[Tuple[str, str]]:
    result: List[Tuple[str, str]] = []
    seen = set()
    for token in raw.replace("\n", ",").replace("，", ",").split(","):
        value = token.strip()
        if value and value not in seen:
            seen.add(value)
            result.append((value, ""))
    return result


def _parse_universe_rows(rows: Any) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    if not isinstance(rows, list):
        return out
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = pick_text(
            row, ("股票代码", "代码", "证券代码", "code"), ("股票代码", "证券代码")
        )
        name = pick_text(
            row, ("股票简称", "股票名称", "名称", "name"), ("股票简称", "股票名称")
        )
        if code and code not in seen:
            seen.add(code)
            out.append((code, name))
    return out


def _bar_name(bars: Any) -> str:
    if isinstance(bars, list) and bars:
        first = bars[0]
        if isinstance(first, dict):
            return str(first.get("name") or "")
    return ""


def summarize_batch(rows: List[Dict[str, Any]], errors: List[Dict[str, str]]) -> Dict[str, Any]:
    """汇总所有标的的回测结果。"""
    returns = [
        float(row["total_return"])
        for row in rows
        if row.get("total_return") is not None
    ]
    drawdowns = [
        float(row["max_drawdown"])
        for row in rows
        if row.get("max_drawdown") is not None
    ]
    wins = [v for v in returns if v > 0]
    sorted_returns = sorted(returns)
    median = sorted_returns[len(sorted_returns) // 2] if sorted_returns else None
    return {
        "tested_count": len(rows),
        "error_count": len(errors),
        "avg_return": round(sum(returns) / len(returns), 6) if returns else None,
        "median_return": round(median, 6) if median is not None else None,
        "win_symbol_rate": round(len(wins) / len(returns), 6) if returns else None,
        "avg_max_drawdown": round(sum(drawdowns) / len(drawdowns), 6) if drawdowns else None,
        "best": _pick_extreme(rows, key="total_return", reverse=True),
        "worst": _pick_extreme(rows, key="total_return", reverse=False),
    }


def _pick_extreme(rows: List[Dict[str, Any]], key: str, reverse: bool) -> Optional[Dict[str, Any]]:
    candidates = [r for r in rows if r.get(key) is not None]
    if not candidates:
        return None
    return max(candidates, key=lambda r: r[key]) if reverse else min(candidates, key=lambda r: r[key])


__all__ = ["BatchRequest", "run_batch_backtest", "summarize_batch"]
