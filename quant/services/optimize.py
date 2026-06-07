"""参数网格寻优服务。

特点：
- 用 ``ProcessPoolExecutor`` 真正吃满多核（Bar 是 frozen dataclass，pickle 没问题）
- 小组合（< MIN_PARALLEL_THRESHOLD）退化为顺序执行，避免进程启动开销
- 超时 / 组合数双重上限保护
- 2 个参数时自动生成 ``heatmap`` 字段（x/y/z 三个数组），前端用 Plotly 直接画
- worker 函数必须是模块级（ProcessPool 需要可 pickle 的 callable）
"""

from __future__ import annotations

import itertools
import os
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeout
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from quant.config import get_settings
from quant.data.normalization import Bar
from quant.errors import ValidationError
from quant.logging_setup import get_logger
from quant.strategies import SPECS, get_spec, min_bars


_LOG = get_logger("optimize_service")

# 低于此组合数直接顺序跑，避免进程池启动开销得不偿失
MIN_PARALLEL_THRESHOLD = 8


@dataclass
class OptimizeRequest:
    strategy: str
    param_ranges: Dict[str, List[Any]]
    start_date: str = ""
    end_date: str = ""
    query: str = ""
    bars: Optional[List[Bar]] = None
    initial_cash: float = 100000.0
    fee_rate: float = 0.0003
    # 单次寻优可临时覆盖默认上限；None 时使用 Settings.optimize_max_combinations
    max_combinations: Optional[int] = None


def _count_combinations(ranges: Dict[str, List[Any]]) -> int:
    total = 1
    for values in ranges.values():
        total *= max(1, len(values or []))
    return total


# --- 模块级 worker（必须可 pickle） ---


def _worker_run_combo(
    strategy_name: str,
    combo: Tuple[Any, ...],
    keys: Tuple[str, ...],
    bars: List[Bar],
    initial_cash: float,
    fee_rate: float,
) -> Dict[str, Any]:
    """跑单组参数。返回 params + 关键指标；异常包成 ``_error``。"""
    spec = get_spec(strategy_name)
    params = dict(zip(keys, combo))
    full = {**spec.default_params, **params, "fee_rate": fee_rate}
    try:
        instance = spec.strategy_cls(
            initial_cash=initial_cash,
            fee_rate=fee_rate,
            **{k: v for k, v in full.items() if k != "fee_rate"},
        )
        result = instance.run(bars)
        summary = result.get("summary", {})
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


def _build_heatmap(
    results: List[Dict[str, Any]],
    param_keys: List[str],
    metric: str = "total_return",
) -> Optional[Dict[str, Any]]:
    """2 个参数时构造 Plotly 友好的 heatmap 字段。

    返回 ``{x_key, y_key, x_values, y_values, z_values, metric}`` 或 None。
    """
    if len(param_keys) != 2:
        return None
    kx, ky = param_keys
    # 收集完整轴（用 param_ranges 顺序保证坐标稳定）
    # 我们没有 param_ranges 在此层，从 results 里去重保序
    xs: List[Any] = []
    ys: List[Any] = []
    for r in results:
        p = r.get("params", {})
        if kx in p and p[kx] not in xs:
            xs.append(p[kx])
        if ky in p and p[ky] not in ys:
            ys.append(p[ky])
    # 数值化（Plotly 需要 z 是 2D list）
    z: List[List[Optional[float]]] = [[None for _ in xs] for _ in ys]
    for r in results:
        p = r.get("params", {})
        v = r.get(metric)
        if v is None or kx not in p or ky not in p:
            continue
        i = xs.index(p[kx])
        j = ys.index(p[ky])
        z[j][i] = v
    return {
        "x_key": kx,
        "y_key": ky,
        "x_values": xs,
        "y_values": ys,
        "z_values": z,
        "metric": metric,
    }


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
    effective_limit = req.max_combinations if (req.max_combinations and req.max_combinations > 0) else settings.optimize_max_combinations
    if n_combos > effective_limit:
        raise ValidationError(
            f"参数组合数 {n_combos} 超过上限 {effective_limit}",
            details={"combinations": n_combos, "limit": effective_limit,
                     "default_limit": settings.optimize_max_combinations},
        )
    if len(bars) < min_bars(req.strategy):
        raise ValidationError(
            f"可用K线不足，至少需要 {min_bars(req.strategy)} 条",
            details={"got": len(bars), "required": min_bars(req.strategy)},
        )

    keys = list(req.param_ranges.keys())
    values = list(req.param_ranges.values())
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

    n_jobs = _resolve_n_jobs(settings.optimize_n_jobs)
    timeout = settings.optimize_timeout_seconds
    use_parallel = n_jobs > 1 and len(combos) >= MIN_PARALLEL_THRESHOLD

    if use_parallel:
        _LOG.info(
            "寻优并行: strategy=%s combos=%d n_jobs=%d",
            req.strategy, len(combos), n_jobs,
        )
        with ProcessPoolExecutor(max_workers=n_jobs) as executor:
            futures = {
                executor.submit(
                    _worker_run_combo,
                    req.strategy,
                    combo,
                    tuple(keys),
                    bars,
                    req.initial_cash,
                    req.fee_rate,
                ): combo
                for combo in combos
            }
            per_combo_timeout = max(10.0, timeout / max(1, len(combos)))
            for future in futures:
                try:
                    outcome = future.result(timeout=per_combo_timeout)
                except FuturesTimeout:
                    errors.append({"params": {}, "error": "combo timeout"})
                    continue
                except Exception as exc:  # noqa: BLE001
                    errors.append({"params": {}, "error": str(exc)})
                    continue
                if "_error" in outcome:
                    errors.append({"params": outcome["params"], "error": outcome["_error"]})
                else:
                    results.append(outcome)
    else:
        _LOG.info(
            "寻优顺序: strategy=%s combos=%d threshold=%d",
            req.strategy, len(combos), MIN_PARALLEL_THRESHOLD,
        )
        for combo in combos:
            outcome = _worker_run_combo(
                req.strategy, combo, tuple(keys), bars, req.initial_cash, req.fee_rate
            )
            if "_error" in outcome:
                errors.append({"params": outcome["params"], "error": outcome["_error"]})
            else:
                results.append(outcome)

    # 排序：None 排最后，按 total_return 降序
    results.sort(
        key=lambda r: (r.get("total_return") is None, -(r.get("total_return") or 0.0))
    )

    response: Dict[str, Any] = {
        "strategy": req.strategy,
        "combinations": len(combos),
        "optimization_results": results,
        "optimization_errors": errors,
        "parallel": use_parallel,
        "n_jobs": n_jobs if use_parallel else 1,
    }
    if len(keys) == 2:
        response["heatmap"] = _build_heatmap(results, keys, metric="total_return")
        response["heatmap_drawdown"] = _build_heatmap(results, keys, metric="max_drawdown")
    return response


def _resolve_n_jobs(configured: int) -> int:
    """根据配置 + CPU 数决定 worker 数。"""
    if configured <= 0:
        return 1
    cpu = max(1, os.cpu_count() or 1)
    return max(1, min(configured, cpu))


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
