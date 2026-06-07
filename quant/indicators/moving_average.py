"""简单移动平均（MA）。

通过前缀和实现 O(n) 一次性预计算，每个 index 后续 O(1) 查询。
"""

from __future__ import annotations

from typing import List, Optional


def precompute_ma(values: List[float], window: int) -> List[Optional[float]]:
    """返回长度为 n 的列表，index i 处为 `values[max(0, i-window+1):i+1]` 的算术平均。

    窗口不足时为 None。`window <= 0` 时全部为 None。
    """
    n = len(values)
    result: List[Optional[float]] = [None] * n
    if window <= 0 or n == 0:
        return result
    if window == 1:
        # 等价直接拷贝，避免前缀和分配
        for i, v in enumerate(values):
            result[i] = float(v)
        return result
    # 前缀和：prefix[i+1] = sum(values[:i+1])
    prefix = [0.0] * (n + 1)
    for i, v in enumerate(values):
        prefix[i + 1] = prefix[i] + v
    for i in range(window - 1, n):
        result[i] = (prefix[i + 1] - prefix[i + 1 - window]) / window
    return result


__all__ = ["precompute_ma"]
