"""价量因子库：30 个纯价量 Alpha101 + 通用 Factor 协议 + 算子。

使用方式::

    from quant.factors import get_factor, list_factors, compute_all

    f = get_factor("alpha_001")
    values = f.compute(bars)  # List[Optional[float]] 与 bars 等长

    # 一键跑全部因子，输出 dict[name -> values]
    all_values = compute_all(bars)
"""

from __future__ import annotations

from typing import Dict, List

from quant.data.normalization import Bar
from quant.factors.base import (
    Factor,
    all_factors,
    get_factor,
    list_factors,
    register_factor,
)
from quant.factors.operators import Series

# 导入 alpha101 会触发 ``@register_alpha`` 把 30 个因子写进注册表
from quant.factors import alpha101  # noqa: F401


def compute_all(bars: List[Bar]) -> Dict[str, Series]:
    """对所有注册因子跑一次，返回 {name: values}。"""
    out: Dict[str, Series] = {}
    for name, factor in all_factors().items():
        out[name] = factor.compute(bars)
    return out


__all__ = [
    "Factor",
    "Series",
    "all_factors",
    "compute_all",
    "get_factor",
    "list_factors",
    "register_factor",
]
