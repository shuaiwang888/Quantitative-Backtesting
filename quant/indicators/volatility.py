"""ATR (Average True Range)。

使用前缀和实现 TR 的滚动平均，避免在每个 index 重复计算 N 个 TR。
TR_t = max(high - low, |high - prev_close|, |low - prev_close|)
"""

from __future__ import annotations

from typing import List, Optional


def compute_true_ranges(
    highs: List[float],
    lows: List[float],
    closes: List[float],
) -> List[Optional[float]]:
    """预计算每个 index 的 TR。index 0 的 prev_close 用自身。"""
    n = len(closes)
    if len(highs) != n or len(lows) != n:
        raise ValueError("highs/lows/closes 长度必须一致")
    if n == 0:
        return []
    trs: List[Optional[float]] = [None] * n
    trs[0] = max(highs[0] - lows[0], 0.0, 0.0)
    for i in range(1, n):
        prev_close = closes[i - 1]
        trs[i] = max(
            highs[i] - lows[i],
            abs(highs[i] - prev_close),
            abs(lows[i] - prev_close),
        )
    return trs


def precompute_atr(
    highs: List[float],
    lows: List[float],
    closes: List[float],
    window: int,
) -> List[Optional[float]]:
    """对每根 K 线返回长度为 window 的 TR 平均。"""
    trs = compute_true_ranges(highs, lows, closes)
    n = len(trs)
    result: List[Optional[float]] = [None] * n
    if window <= 0 or n == 0:
        return result
    # TR 已经是 List[float|None]，但正常路径下全是 float
    prefix = [0.0] * (n + 1)
    for i, tr in enumerate(trs):
        prefix[i + 1] = prefix[i] + (tr or 0.0)
    for i in range(window - 1, n):
        result[i] = (prefix[i + 1] - prefix[i + 1 - window]) / window
    return result


__all__ = ["compute_true_ranges", "precompute_atr"]
