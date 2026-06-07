"""RSI (Relative Strength Index)，Wilder 平滑实现。

递推：
- avg_gain_t = avg_gain_{t-1} * (window-1)/window + max(0, change_t) / window
- avg_loss_t 类似
- RS = avg_gain / avg_loss
- RSI = 100 - 100 / (1 + RS)

边界：
- 窗口不足时返回 None
- avg_loss == 0 时直接返回 100（全部上涨）
"""

from __future__ import annotations

from typing import List, Optional


def precompute_rsi(closes: List[float], window: int) -> List[Optional[float]]:
    """返回每根 K 线对应的 RSI 值（0~100）。窗口不足时为 None。"""
    n = len(closes)
    result: List[Optional[float]] = [None] * n
    if window < 2 or n < window + 1:
        return result

    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, window + 1):
        change = closes[i] - closes[i - 1]
        if change >= 0:
            avg_gain += change
        else:
            avg_loss += -change
    avg_gain /= window
    avg_loss /= window
    result[window] = _rsi(avg_gain, avg_loss)

    for i in range(window + 1, n):
        change = closes[i] - closes[i - 1]
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        avg_gain = (avg_gain * (window - 1) + gain) / window
        avg_loss = (avg_loss * (window - 1) + loss) / window
        result[i] = _rsi(avg_gain, avg_loss)
    return result


def _rsi(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        if avg_gain == 0:
            return 50.0
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


__all__ = ["precompute_rsi"]
