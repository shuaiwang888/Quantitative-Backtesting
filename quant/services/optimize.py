"""参数网格寻优服务。"""

from __future__ import annotations

import itertools
import signal
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeout
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from quant.config import get_settings
from quant.data.normalization import Bar
from quant.errors import ValidationError
from quant.logging_setup import get_logger
from quant.strategies import SPECS, get_spec, min_bars


_LOG = get_logger("optimize_service")


@dataclass
class OptimizeRequest:
    strategy: str
    param_ranges: Dict[str, List[Any]]
    start_date: str = ""
    end_date: str = ""
    query: str = ""
    bars: Optional[List[Bar]] = None  # 服务层传入，避免重复拉数据
    initial_cash: float = 100000.0
    fee_rate: float = 0.0003


def _count_combinations(ranges: Dict[str, List[Any]]) -> int:
    total = 1
    for values in ranges.values():
        total *= max(1, len(values or []))
    return total


def run_grid_search(
    req: OptimizeRequest,
    bars: List[Bar],
) -> Dict[str, Any]:
    """对一组 (bars, param_ranges) 跑网格寻优。"""
    if req.strategy not in SPECS:
        raise ValidationError(
            f"未知策略: {req.strategy}",
            details={"field": "strategy", "available": list(SPECS)},
        )
    if not req.param_ranges:
        raise ValidationError("param_ranges 不能为空", details={"field": "param_ranges"})

    spec = get_spec(req.strategy)
    settings = get_settings()

    n_combos = _count_combinations(req.param_ranges)
    if n_combos > settings.optimize_max_combinations:
        raise ValidationError(
            f"参数组合数 {n_combos} 超过上限 {settings.optimize_max_combinations}",
            details={"combinations": n_combos, "limit": settings.optimize_max_combinations},
        )
    if len(bars) < min_bars(req.strategy):
        raise ValidationError(
            f"可用K线不足，至少需要 {min_bars(req.strategy)} 条",
            details={"got": len(bars), "required": min_bars(req.strategy)},
        )

    keys = list(req.param_ranges.keys())
    values = list(req.param_ranges.values())
    # 仅保留策略接受的参数
    valid_keys = set(_strategy_param_keys(spec.strategy_cls))
    invalid = [k for k in keys if k not in valid_keys]
    if invalid:
        raise ValidationError(
            f"策略 {req.strategy} 不支持参数: {invalid}",
            details={"unsupported": invalid, "supported": sorted(valid_keys)},
        )

    combos = list(itertools.product(*values))
    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    # 用线程池并发（CPU 密集度适中，线程池足以；进程池序列化 Bar 对象成本高）
    from concurrent.futures import ThreadPoolExecutor

    max_workers = min(8, max(1, len(combos)))
    timeout = settings.optimize_timeout_seconds

    def _run_one(combo: tuple) -> Optional[Dict[str, Any]]:
        params = dict(zip(keys, combo))
        full = {**spec.default_params, **params, "fee_rate": req.fee_rate}
        try:
            strategy_instance = spec.strategy_cls(
                initial_cash=req.initial_cash,
                fee_rate=req.fee_rate,
                **{k: v for k, v in full.items() if k != "fee_rate"},
            )
            result = strategy_instance.run(bars)
            summary = result["summary"]
            return {
                "params": params,
                "total_return": summary.get("total_return"),
                "annual_return": summary.get("annual_return", 0),
                "max_drawdown": summary.get("max_drawdown"),
                "sharpe_ratio": summary.get("sharpe_ratio", 0),
                "win_rate": summary.get("win_rate"),
                "trade_count": summary.get("trade_count", 0),
            }
        except Exception as exc:  # noqa: BLE001
            return {"_error": str(exc), "params": params}

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_run_one, combo): combo for combo in combos}
        for future in futures:
            try:
                outcome = future.result(timeout=timeout / max(1, len(combos)))
            except Exception as exc:  # noqa: BLE001
                errors.append({"params": {}, "error": str(exc)})
                continue
            if outcome is None:
                continue
            if "_error" in outcome:
                errors.append({"params": outcome["params"], "error": outcome["_error"]})
            else:
                results.append(outcome)

    # 修复历史 bug：原代码 `sort(key=total_return, reverse=True)` 在 total_return=None 时崩溃
    results.sort(
        key=lambda r: (r.get("total_return") is None, -(r.get("total_return") or 0.0))
    )
    return {
        "strategy": req.strategy,
        "combinations": len(combos),
        "optimization_results": results,
        "optimization_errors": errors,
    }


def _strategy_param_keys(strategy_cls: type) -> List[str]:
    """从策略 __init__ 签名提取参数名（除 initial_cash / fee_rate）。"""
    import inspect

    sig = inspect.signature(strategy_cls.__init__)
    return [
        name
        for name, param in sig.parameters.items()
        if name not in ("self", "initial_cash", "fee_rate")
    ]


__all__ = ["OptimizeRequest", "run_grid_search"]
