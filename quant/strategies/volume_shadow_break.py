"""倍量上/下影线 + 跌破均线卖出。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from quant.data.normalization import Bar
from quant.indicators import precompute_ma
from quant.strategies.base import BaseStrategy, _round_or_none


def _shadow_metrics(bar: Bar) -> Tuple[float, float, float, float]:
    """计算上下影线绝对值与占振幅比例。"""
    high = bar.high if bar.high is not None else bar.close
    low = bar.low if bar.low is not None else bar.close
    open_price = bar.open if bar.open is not None else bar.close
    upper = max(0.0, high - max(open_price, bar.close))
    lower = max(0.0, min(open_price, bar.close) - low)
    span = max(high - low, 1e-9)
    return upper, upper / span, lower, lower / span


class VolumeShadowBreakStrategy(BaseStrategy):
    """倍量 + 上/下影线满足阈值 → 买入；倍量 + 跌破 MA → 卖出。"""

    name = "倍量上/下影线 + 跌破5日均线"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        volume_window: int,
        volume_multiplier: float,
        sell_volume_multiplier: float,
        upper_shadow_ratio: float,
        lower_shadow_ratio: float,
        ma_window: int,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        if volume_window < 1:
            raise ValueError("倍量均量窗口必须至少为 1")
        if ma_window < 2:
            raise ValueError("卖出均线窗口至少为 2")
        if volume_multiplier <= 1:
            raise ValueError("倍量倍数必须大于 1")
        if sell_volume_multiplier <= 1:
            raise ValueError("卖出放量倍数必须大于 1")
        if not 0 < upper_shadow_ratio <= 1:
            raise ValueError("上影线占比必须在 0 到 1 之间")
        if not 0 < lower_shadow_ratio <= 1:
            raise ValueError("下影线占比必须在 0 到 1 之间")
        self.volume_window = volume_window
        self.volume_multiplier = volume_multiplier
        self.sell_volume_multiplier = sell_volume_multiplier
        self.upper_shadow_ratio = upper_shadow_ratio
        self.lower_shadow_ratio = lower_shadow_ratio
        self.ma_window = ma_window
        # 预计算缓存
        self._avg_volume: List[Optional[float]] = []
        self._ma: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return self.name

    def _prepare_series(self, bars: List[Bar]) -> None:  # type: ignore[override]
        super()._prepare_series(bars)
        # 看穿到 i-1 之前的均量 → 窗口为 window+1 后平移
        self._avg_volume = precompute_ma(self.volumes, self.volume_window + 1)
        self._ma = precompute_ma(self.closes, self.ma_window)

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        avg_volume = self._avg_volume[index - 1] if index > 0 else None
        volume_ratio = None
        if avg_volume and avg_volume > 0 and bar.volume is not None:
            volume_ratio = bar.volume / avg_volume
        upper, upper_pct, lower, lower_pct = _shadow_metrics(bar)
        return {
            "avg_volume": _round_or_none(avg_volume),
            "volume_ratio": _round_or_none(volume_ratio),
            "upper_shadow": _round_or_none(upper),
            "upper_shadow_ratio": _round_or_none(upper_pct),
            "lower_shadow": _round_or_none(lower),
            "lower_shadow_ratio": _round_or_none(lower_pct),
            "ma5": _round_or_none(self._ma[index]),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        avg_volume = self._avg_volume[index - 1] if index > 0 else None
        ma5 = self._ma[index]
        upper, upper_pct, lower, lower_pct = _shadow_metrics(bar)

        # 持仓中：放量 + 跌破均线 → 卖出
        if self.shares > 0:
            if avg_volume and avg_volume > 0 and ma5 is not None and bar.volume is not None:
                volume_spike = bar.volume >= avg_volume * self.sell_volume_multiplier
                if volume_spike and bar.close < ma5:
                    self.sell(bar, bar.close)
            return

        if avg_volume is None or avg_volume <= 0 or ma5 is None or bar.volume is None:
            return
        volume_spike = bar.volume >= avg_volume * self.volume_multiplier
        upper_ok = upper_pct >= self.upper_shadow_ratio and upper > 0
        lower_ok = lower_pct >= self.lower_shadow_ratio and lower > 0
        if volume_spike and (upper_ok or lower_ok):
            buyable = self.calc_buyable_shares(bar.close)
            if buyable > 0:
                self.buy(bar, bar.close, buyable)


__all__ = ["VolumeShadowBreakStrategy"]
