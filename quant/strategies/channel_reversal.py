"""6 日通道反转 + 止损策略。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.indicators import precompute_rolling_high, precompute_rolling_low
from quant.strategies.base import BaseStrategy, _round_or_none


class ChannelReversalStrategy(BaseStrategy):
    """收盘 < 前 N 日最低 → 买入（反向）；收盘 > 前 N 日最高 或 跌破止损 → 卖出。"""

    name = "6日通道反转 + 止损"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        channel_window: int,
        stop_loss_pct: float,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        if channel_window < 2:
            raise ValueError("通道窗口至少为 2")
        if not 0 < stop_loss_pct < 1:
            raise ValueError("止损百分比必须在 0 到 1 之间")
        self.channel_window = channel_window
        self.stop_loss_pct = stop_loss_pct
        self.entry_price: Optional[float] = None
        self.stop_price: Optional[float] = None
        # 预计算缓存
        self._prior_low: List[Optional[float]] = []
        self._prior_high: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return self.name

    def _prepare_series(self, bars: List[Bar]) -> None:  # type: ignore[override]
        super()._prepare_series(bars)
        # 准备 length+1 的滚动窗口，平移一个位置后用 index-1 取"前 N 日"值
        self._prior_low = precompute_rolling_low(self.lows, self.channel_window + 1)
        self._prior_high = precompute_rolling_high(self.highs, self.channel_window + 1)

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        # "前 N 日"对应原 rolling 序列在 (index-1) 处
        return {
            "prior_low": _round_or_none(self._prior_low[index - 1] if index > 0 else None),
            "prior_high": _round_or_none(self._prior_high[index - 1] if index > 0 else None),
            "stop_price": _round_or_none(self.stop_price),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        if index == 0:
            return
        prior_low = self._prior_low[index - 1]
        prior_high = self._prior_high[index - 1]
        if prior_low is None or prior_high is None:
            return

        self.stop_price = (
            self.entry_price * (1 - self.stop_loss_pct) if self.entry_price else None
        )

        if self.shares == 0 and bar.close < prior_low:
            buyable = self.calc_buyable_shares(bar.close)
            if buyable > 0:
                self.entry_price = bar.close
                self.stop_price = self.entry_price * (1 - self.stop_loss_pct)
                self.buy(bar, bar.close, buyable)
        elif self.shares > 0 and (
            bar.close > prior_high or (self.stop_price and bar.close <= self.stop_price)
        ):
            self.sell(bar, bar.close)
            self.entry_price = None
            self.stop_price = None


__all__ = ["ChannelReversalStrategy"]
