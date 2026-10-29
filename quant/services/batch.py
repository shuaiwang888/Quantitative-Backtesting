"""批量回测服务：股票池 / 自定义列表。"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from quant.config import get_settings
from quant.data.iwencai import IwencaiError, fetch_all
from quant.data.normalization import (
    build_history_query,
    normalize_bars,
    pick_text,
)
from quant.errors import UpstreamError, ValidationError
from quant.logging_setup import get_logger
from quant.services.backtest import UNIVERSE_QUERIES, _safe_persist_bars
from quant.strategies import SPECS, min_bars, run_backtest
from quant.services.validation import (
    validate_date_range,
    validate_strategy_params,
    validate_execution_inputs,
    validate_financial_inputs,
    validate_paging,
    validate_symbol,
    validate_single_series,
)


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
    universe_limit: int = 100
    universe_pages: int = 5
    strategy_params: Dict[str, Any] = field(default_factory=dict)


def run_batch_backtest(req: BatchRequest) -> Dict[str, Any]:
    """批量回测入口。返回每只标的的 summary + 总体汇总。"""
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
    validate_date_range(req.start_date, req.end_date, required=True)
    validate_paging(req.limit, req.max_pages)
    if req.max_symbols < 1 or req.max_workers < 1:
        raise ValidationError(
            "max_symbols 和 max_workers 必须大于 0",
            details={"field": "max_symbols/max_workers"},
        )
    if not 1 <= req.universe_limit <= 100 or not 1 <= req.universe_pages <= 10:
        raise ValidationError(
            "universe_limit 必须在 1-100，universe_pages 必须在 1-10",
            details={"field": "universe_limit/universe_pages"},
        )
    if req.strategy not in SPECS:
        raise ValidationError(
            f"未知策略: {req.strategy}",
            details={"field": "strategy", "available": list(SPECS)},
        )
    # 先验证策略参数，避免错误输入仍然消耗上游额度。
    req.strategy_params = validate_strategy_params(req.strategy, req.initial_cash, req.fee_rate, req.strategy_params)
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
            validate_single_series(bars)
            if len(bars) < min_bars(req.strategy, req.strategy_params):
                return (
                    None,
                    {"symbol": code, "name": name, "error": f"K线不足（{len(bars)}<{min_bars(req.strategy, req.strategy_params)}）"},
                )
            persistence = _safe_persist_bars(bars, query_text, req.start_date, req.end_date, req.persist)
            result = run_backtest(
                req.strategy,
                bars,
                initial_cash=req.initial_cash,
                fee_rate=req.fee_rate,
                slippage_rate=req.slippage_rate,
                min_commission=req.min_commission,
                stamp_duty_rate=req.stamp_duty_rate,
                transfer_fee_rate=req.transfer_fee_rate,
                lot_size=req.lot_size,
                max_pending_bars=req.max_pending_bars,
                price_limit_pct=req.price_limit_pct,
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
        except ValidationError as exc:
            return (None, {"symbol": code, "name": name, "error": exc.message})
        except IwencaiError as exc:
            return (None, {"symbol": code, "name": name, "error": f"问财错误: {exc.message}"})
        except Exception:  # noqa: BLE001
            _LOG.exception("批量回测 %s 失败", code)
            return (None, {"symbol": code, "name": name, "error": "回测执行失败（详见服务端日志）"})

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(run_one, code, name): (code, name) for code, name in symbols}
        for future in as_completed(futures):
            row, err = future.result()
            if err:
                errors.append(err)
            elif row:
                rows.append(row)

    rows.sort(key=lambda row: str(row.get("symbol") or ""))
    errors.sort(key=lambda row: str(row.get("symbol") or ""))

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
    if not isinstance(raw, str):
        raise ValidationError(
            "symbols 必须是逗号或换行分隔的字符串",
            details={"field": "symbols"},
        )
    result: List[Tuple[str, str]] = []
    seen = set()
    for token in raw.replace("\n", ",").replace("，", ",").split(","):
        value = validate_symbol(token)
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
    if not sorted_returns:
        median = None
    else:
        middle = len(sorted_returns) // 2
        median = (
            sorted_returns[middle]
            if len(sorted_returns) % 2
            else (sorted_returns[middle - 1] + sorted_returns[middle]) / 2
        )
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
