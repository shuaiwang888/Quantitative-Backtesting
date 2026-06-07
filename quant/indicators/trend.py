"""技术指标：滚动最大/最小、趋势斜率。

实现策略：
- 滚动 max/min 用单调队列（O(n) 摊还），避免每个 index 重做一次切片。
- 斜率直接用差值（窗口内首尾 close 之差），够用即可。
"""

from __future__ import annotations

from collections import deque
from typing import List, Optional


def precompute_rolling_high(values: List[float], window: int) -> List[Optional[float]]:
    """对每个 index i，返回 `values[max(0, i-window+1):i+1]` 的最大值。

    第 i 个值在 i >= window-1 后才有意义，更早的位置是 None。
    """
    n = len(values)
    result: List[Optional[float]] = [None] * n
    if window <= 0 or n == 0:
        return result
    dq: deque[int] = deque()  # 单调递减：存索引，对应 values 值单调递减
    for i, value in enumerate(values):
        while dq and dq[0] <= i - window:
            dq.popleft()
        while dq and values[dq[-1]] <= value:
            dq.pop()
        dq.append(i)
        if i >= window - 1:
            result[i] = values[dq[0]]
    return result


def precompute_rolling_low(values: List[float], window: int) -> List[Optional[float]]:
    """对每个 index i，返回 `values[max(0, i-window+1):i+1]` 的最小值。"""
    n = len(values)
    result: List[Optional[float]] = [None] * n
    if window <= 0 or n == 0:
        return result
    dq: deque[int] = deque()  # 单调递增
    for i, value in enumerate(values):
        while dq and dq[0] <= i - window:
            dq.popleft()
        while dq and values[dq[-1]] >= value:
            dq.pop()
        dq.append(i)
        if i >= window - 1:
            result[i] = values[dq[0]]
    return result


def rolling_high_at(rh_series: List[Optional[float]], index: int, window: int) -> Optional[float]:
    """返回 index 时刻"看穿到 index 之前"的最大值（即 [index-window, index-1] 区间）。

    传入的 rh_series 是 precompute_rolling_high(...) 的产物，平移一个位置。
    """
    if index - 1 < 0:
        return None
    if index - 1 < window - 1:
        return None
    return rh_series[index - 1]


def rolling_low_at(rl_series: List[Optional[float]], index: int, window: int) -> Optional[float]:
    """返回 index 时刻"看穿到 index 之前"的最小值。"""
    if index - 1 < 0:
        return None
    if index - 1 < window - 1:
        return None
    return rl_series[index - 1]


def slope(values: List[float], index: int, window: int) -> float:
    """窗口内首尾 close 之差，简单替代线性回归斜率。"""
    if index + 1 < window or index - window + 1 < 0:
        return 0.0
    return values[index] - values[index - window + 1]


__all__ = [
    "precompute_rolling_high",
    "precompute_rolling_low",
    "rolling_high_at",
    "rolling_low_at",
    "slope",
]
