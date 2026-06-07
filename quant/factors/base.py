"""Factor 协议 + 工厂 + 注册表。

设计原则：
- 一个 Factor 接收 List[Bar]，输出与 bars 等长的"因子分"列表（None 表示不可用）。
- 注册表把 name -> Factor 实例集中管理，方便策略/前端按名调用。
- 任何新增因子都只需写一个继承 Factor 的类并注册。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Dict, List, Type

from quant.data.normalization import Bar
from quant.factors.operators import Series


class Factor(ABC):
    """价量因子抽象基类。"""

    #: 因子显示名（中文）
    display_name: str = ""

    @abstractmethod
    def compute(self, bars: List[Bar]) -> Series:
        """接收 K 线，返回与 bars 等长的因子分序列。"""

    def required_min_bars(self) -> int:
        """所需最小 K 线数（用于回测前置校验）。默认 30。"""
        return 30


# --- 注册表 ---


_REGISTRY: Dict[str, Factor] = {}


def register_factor(name: str, factor: Factor) -> None:
    """注册一个因子实例到全局表。"""
    if name in _REGISTRY:
        raise ValueError(f"因子名 {name!r} 已被注册")
    _REGISTRY[name] = factor


def get_factor(name: str) -> Factor:
    if name not in _REGISTRY:
        raise KeyError(f"未知因子: {name}，可用: {list_factors()}")
    return _REGISTRY[name]


def list_factors() -> List[str]:
    return list(_REGISTRY.keys())


def all_factors() -> Dict[str, Factor]:
    return dict(_REGISTRY)


__all__ = [
    "Factor",
    "register_factor",
    "get_factor",
    "list_factors",
    "all_factors",
]
