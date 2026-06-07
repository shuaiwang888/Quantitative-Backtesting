"""价量因子的算子库（纯 stdlib 实现）。

设计要点：
- 全部用 list[float] 进出，避免引入 pandas/numpy，保持项目 zero-dep 风格。
- 所有滚动算子在 d 之前的位置返回 None（与 pandas 的 min_periods=d 一致）。
- NaN 透传：None / 不可计算的位置都返回 None。
- 单值退化：d=1 时 rolling 与 elementary 等价，单独做"无窗口"快路径。
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple


# --- 类型别名 ---

Number = float
Series = List[Optional[Number]]


def _to_float(x: Optional[Number]) -> Optional[float]:
    """把 None 透传；把可转换的数转 float；其它 NaN。"""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _clean(xs: Sequence[Optional[Number]]) -> List[float]:
    """把 None/NaN 过滤掉，保留有效值。"""
    out: List[float] = []
    for x in xs:
        v = _to_float(x)
        if v is not None:
            out.append(v)
    return out


# --- 基础算子 ---


def delay(x: Series, d: int) -> Series:
    """x[t-d]，最前 d 个位置为 None。"""
    if d <= 0:
        return [_to_float(v) for v in x]
    out: Series = [None] * min(d, len(x))
    for i in range(d, len(x)):
        out.append(_to_float(x[i - d]))
    return out


def delta(x: Series, d: int) -> Series:
    """x[t] - x[t-d]。"""
    out: Series = [None] * len(x)
    for i in range(d, len(x)):
        a = _to_float(x[i])
        b = _to_float(x[i - d])
        if a is None or b is None:
            continue
        out[i] = a - b
    return out


def signedpower(x: Series, a: float) -> Series:
    """sign(x) * |x|^a。"""
    out: Series = []
    for v in x:
        f = _to_float(v)
        if f is None:
            out.append(None)
            continue
        out.append(math.copysign(abs(f) ** a, f))
    return out


def scale(x: Series, a: float = 1.0) -> Series:
    """x / sum(|x|) * a，结果的 |sum| = a。sum 为 0 时全部置 None。"""
    valid = [(i, _to_float(v)) for i, v in enumerate(x)]
    total = sum(abs(v) for _, v in valid if v is not None)
    if total == 0 or not math.isfinite(total):
        return [None] * len(x)
    return [None if v is None else v / total * a for _, v in valid for v in [v]]


# --- 滚动算子 ---


def _rolling_apply(
    x: Series,
    d: int,
    fn,
) -> Series:
    """通用滚动窗口：窗口大小 d，fn 接受子序列返回标量。"""
    if d <= 0:
        raise ValueError("窗口 d 必须 > 0")
    out: Series = [None] * len(x)
    for i in range(d - 1, len(x)):
        window = [_to_float(v) for v in x[i - d + 1 : i + 1]]
        if any(v is None for v in window):
            continue
        out[i] = fn(window)  # type: ignore[arg-type]
    return out


def ts_sum(x: Series, d: int) -> Series:
    return _rolling_apply(x, d, sum)


def ts_mean(x: Series, d: int) -> Series:
    return _rolling_apply(x, d, lambda w: sum(w) / len(w))


def ts_stddev(x: Series, d: int) -> Series:
    def _std(w: List[float]) -> float:
        m = sum(w) / len(w)
        var = sum((v - m) ** 2 for v in w) / max(1, len(w) - 1)
        return math.sqrt(var)

    return _rolling_apply(x, d, _std)


def ts_max(x: Series, d: int) -> Series:
    return _rolling_apply(x, d, max)


def ts_min(x: Series, d: int) -> Series:
    return _rolling_apply(x, d, min)


def ts_rank(x: Series, d: int) -> Series:
    """当前值在最近 d 个值里的百分位 rank ∈ (0, 1]。"""

    def _rank(w: List[float]) -> float:
        cur = w[-1]
        less = sum(1 for v in w if v < cur)
        return less / max(1, len(w) - 1)

    return _rolling_apply(x, d, _rank)


def ts_argmax(x: Series, d: int) -> Series:
    """最近 d 个值中最大值的索引（0-based，从窗口末尾倒数）。"""

    def _argmax(w: List[float]) -> float:
        # 离当前最近的窗口中最大值的相对位置
        m = max(w)
        for i in range(len(w) - 1, -1, -1):
            if w[i] == m:
                return len(w) - 1 - i
        return 0.0

    return _rolling_apply(x, d, _argmax)


def ts_argmin(x: Series, d: int) -> Series:
    def _argmin(w: List[float]) -> float:
        m = min(w)
        for i in range(len(w) - 1, -1, -1):
            if w[i] == m:
                return len(w) - 1 - i
        return 0.0

    return _rolling_apply(x, d, _argmin)


def product(x: Series, d: int) -> Series:
    return _rolling_apply(x, d, math.prod)


def rolling_corr(x: Series, y: Series, d: int) -> Series:
    """x 与 y 在最近 d 个值上的滚动 Pearson 相关系数。"""
    if len(x) != len(y):
        raise ValueError("x 和 y 长度必须一致")
    out: Series = [None] * len(x)
    for i in range(d - 1, len(x)):
        xs = [_to_float(v) for v in x[i - d + 1 : i + 1]]
        ys = [_to_float(v) for v in y[i - d + 1 : i + 1]]
        if any(v is None for v in xs) or any(v is None for v in ys):
            continue
        mx = sum(xs) / d
        my = sum(ys) / d
        num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        denx = math.sqrt(sum((a - mx) ** 2 for a in xs))
        deny = math.sqrt(sum((b - my) ** 2 for b in ys))
        den = denx * deny
        if den == 0:
            continue
        out[i] = num / den
    return out


def decay_linear(x: Series, d: int) -> Series:
    """线性衰减加权平均，权重 1..d，最近一根权重最大。"""
    if d <= 0:
        raise ValueError("窗口 d 必须 > 0")
    weights = list(range(1, d + 1))
    wsum = sum(weights)
    out: Series = [None] * len(x)
    for i in range(d - 1, len(x)):
        window = [_to_float(v) for v in x[i - d + 1 : i + 1]]
        if any(v is None for v in window):
            continue
        num = sum(w * v for w, v in zip(weights, window))
        out[i] = num / wsum
    return out


# --- 截面 rank（退化为时序 rank 供单标的用） ---


def rank(x: Series) -> Series:
    """对单一时序做整体 rank ∈ (0, 1]。"""
    valid_idx: List[int] = []
    vals: List[float] = []
    for i, v in enumerate(x):
        f = _to_float(v)
        if f is not None:
            valid_idx.append(i)
            vals.append(f)
    if not vals:
        return [None] * len(x)
    sorted_pairs = sorted(enumerate(vals), key=lambda p: p[1])
    out: Series = [None] * len(x)
    n = len(vals)
    # 简单 rank：percentile = (rank-1) / (n-1)
    for r, (orig_idx, _) in enumerate(sorted_pairs):
        out[valid_idx[orig_idx]] = r / max(1, n - 1)
    return out


# --- 复合 / 派生算子 ---


def vwap_from_bars(
    highs: Sequence[Optional[Number]],
    lows: Sequence[Optional[Number]],
    closes: Sequence[Optional[Number]],
    volumes: Sequence[Optional[Number]],
) -> Series:
    """典型价 (HLC/3) × 成交量，再除以总成交量做金额加权均价。"""
    n = len(closes)
    out: Series = [None] * n
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(n):
        h = _to_float(highs[i])
        l = _to_float(lows[i])
        c = _to_float(closes[i])
        v = _to_float(volumes[i])
        if None in (h, l, c, v):
            out[i] = None if cum_v == 0 else cum_pv / cum_v
            continue
        typical = (h + l + c) / 3.0
        cum_pv += typical * v
        cum_v += v
        out[i] = cum_pv / cum_v if cum_v > 0 else None
    return out


def adv(volume: Series, d: int) -> Series:
    """平均日成交量 = rolling mean of volume。"""
    return ts_mean(volume, d)


def where(cond: Series, a: Series, b: Series) -> Series:
    """三目 cond ? a : b，按位置选。"""
    if not (len(cond) == len(a) == len(b)):
        raise ValueError("cond / a / b 长度必须一致")
    out: Series = []
    for c, va, vb in zip(cond, a, b):
        cv = _to_float(c)
        if cv is None:
            out.append(None)
        elif cv > 0:
            out.append(_to_float(va))
        else:
            out.append(_to_float(vb))
    return out


def sign(x: Series) -> Series:
    out: Series = []
    for v in x:
        f = _to_float(v)
        if f is None:
            out.append(None)
        elif f > 0:
            out.append(1.0)
        elif f < 0:
            out.append(-1.0)
        else:
            out.append(0.0)
    return out


__all__ = [
    "Series",
    "delay",
    "delta",
    "signedpower",
    "scale",
    "ts_sum",
    "ts_mean",
    "ts_stddev",
    "ts_max",
    "ts_min",
    "ts_rank",
    "ts_argmax",
    "ts_argmin",
    "product",
    "rolling_corr",
    "decay_linear",
    "rank",
    "vwap_from_bars",
    "adv",
    "where",
    "sign",
]
