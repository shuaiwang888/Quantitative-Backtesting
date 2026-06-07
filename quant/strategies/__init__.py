"""策略注册表。

- 单一来源：新加策略只需在此文件注册一次。
- 工厂方法 `make_strategy(name, bars, **kwargs)` 按名字构造策略实例。
- `min_bars(name)` 用于服务层做前置校验。
- `default_params(name)` 用于前端默认值 / 寻优默认网格（前端也可直接读这里）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Type

from quant.data.normalization import Bar
from quant.strategies.base import BaseStrategy
from quant.strategies.channel_reversal import ChannelReversalStrategy
from quant.strategies.ma_rsi import MARSIStrategy
from quant.strategies.momentum_atr import MomentumATRStrategy
from quant.strategies.moving_average import MovingAverageStrategy
from quant.strategies.volume_shadow_break import VolumeShadowBreakStrategy


@dataclass(frozen=True)
class StrategySpec:
    """单个策略的元数据。"""

    name: str  # 内部标识，CLI/API 字符串
    display_name: str  # 中文显示名
    strategy_cls: Type[BaseStrategy]
    default_params: Dict[str, Any]
    default_grid: Dict[str, List[Any]]  # 寻优默认网格


def _spec(
    name: str,
    display: str,
    cls: Type[BaseStrategy],
    defaults: Dict[str, Any],
    grid: Dict[str, List[Any]],
) -> StrategySpec:
    return StrategySpec(
        name=name,
        display_name=display,
        strategy_cls=cls,
        default_params=defaults,
        default_grid=grid,
    )


# 单一来源：所有策略信息在此集中
SPECS: Dict[str, StrategySpec] = {
    "momentum_atr": _spec(
        "momentum_atr",
        "动量突破 + ATR风控",
        MomentumATRStrategy,
        defaults={
            "breakout_window": 20,
            "trend_window": 60,
            "atr_window": 14,
            "atr_multiplier": 2.5,
            "risk_per_trade": 0.02,
        },
        grid={
            "breakout_window": [15, 20, 25],
            "atr_multiplier": [1.5, 2.0, 2.5],
        },
    ),
    "moving_average": _spec(
        "moving_average",
        "双均线交叉",
        MovingAverageStrategy,
        defaults={"fast_window": 5, "slow_window": 20},
        grid={"fast_window": [3, 5, 7], "slow_window": [15, 20, 30]},
    ),
    "ma_rsi": _spec(
        "ma_rsi",
        "均线 + RSI",
        MARSIStrategy,
        defaults={
            "fast_window": 5,
            "slow_window": 20,
            "rsi_window": 6,
            "buy_rsi": 40,
            "sell_rsi": 60,
        },
        grid={
            "fast_window": [5, 10],
            "slow_window": [20, 30],
            "rsi_window": [6, 14],
            "buy_rsi": [30, 40],
            "sell_rsi": [60, 70],
        },
    ),
    "channel_reversal": _spec(
        "channel_reversal",
        "6日通道反转 + 止损",
        ChannelReversalStrategy,
        defaults={"channel_window": 6, "stop_loss_pct": 0.05},
        grid={"channel_window": [5, 6, 10, 15], "stop_loss_pct": [0.03, 0.05, 0.08]},
    ),
    "volume_shadow_break": _spec(
        "volume_shadow_break",
        "倍量上/下影线 + 跌破5日均线",
        VolumeShadowBreakStrategy,
        defaults={
            "volume_window": 3,
            "volume_multiplier": 1.1,
            "sell_volume_multiplier": 1.05,
            "upper_shadow_ratio": 0.1,
            "lower_shadow_ratio": 0.2,
            "ma_window": 3,
        },
        grid={
            "volume_window": [2, 3, 4],
            "volume_multiplier": [1.1, 1.2, 1.3, 1.4],
            "sell_volume_multiplier": [1.01, 1.03, 1.05],
            "upper_shadow_ratio": [0.1, 0.15, 0.2],
            "lower_shadow_ratio": [0.2, 0.3, 0.4],
            "ma_window": [3, 5, 8],
        },
    ),
}


def list_strategies() -> List[StrategySpec]:
    return list(SPECS.values())


def get_spec(name: str) -> StrategySpec:
    if name not in SPECS:
        raise KeyError(f"未知策略: {name}")
    return SPECS[name]


def make_strategy(
    name: str,
    *,
    initial_cash: float,
    fee_rate: float = 0.0003,
    **params: Any,
) -> BaseStrategy:
    """根据 name 构造策略实例。

    - ``initial_cash`` / ``fee_rate`` 是服务级参数，独立于策略元数据。
    - ``params`` 只覆盖策略特定的 default_params（不会污染 fee_rate）。
    """
    spec = get_spec(name)
    merged = {**spec.default_params, **params}
    merged["initial_cash"] = initial_cash
    merged["fee_rate"] = fee_rate
    return spec.strategy_cls(**merged)


def min_bars(name: str) -> int:
    """每个策略对最小 K 线数的要求（用于前置校验）。"""
    spec = get_spec(name)
    defaults = spec.default_params
    if name == "moving_average":
        return defaults["slow_window"] + 1
    if name == "momentum_atr":
        return max(defaults["atr_window"], defaults["breakout_window"], defaults["trend_window"]) + 1
    if name == "ma_rsi":
        return max(defaults["slow_window"], defaults["rsi_window"] + 1)
    if name == "channel_reversal":
        return defaults["channel_window"] + 1
    if name == "volume_shadow_break":
        return max(defaults["volume_window"], defaults["ma_window"]) + 1
    return 1


def run_backtest(
    name: str,
    bars: List[Bar],
    *,
    initial_cash: float = 100000.0,
    fee_rate: float = 0.0003,
    **params: Any,
) -> Dict[str, Any]:
    """便捷入口：构造 + run。"""
    needed = min_bars(name)
    if len(bars) < needed:
        from quant.errors import ValidationError
        raise ValidationError(
            f"可用K线不足，至少需要 {needed} 条",
            details={"got": len(bars), "required": needed, "strategy": name},
        )
    strategy = make_strategy(name, initial_cash=initial_cash, fee_rate=fee_rate, **params)
    return strategy.run(bars)


__all__ = [
    "StrategySpec",
    "SPECS",
    "list_strategies",
    "get_spec",
    "make_strategy",
    "min_bars",
    "run_backtest",
]
