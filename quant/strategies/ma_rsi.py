"""均线 + RSI 策略。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.indicators import precompute_ma, precompute_rsi
from quant.strategies.base import BaseStrategy, _round_or_none


class MARSIStrategy(BaseStrategy):
    """快均线 > 慢均线 且 RSI < 阈值 → 买入；快均线 < 慢均线 或 RSI > 阈值 → 卖出。"""

    name = "均线 + RSI"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        fast_window: int,
        slow_window: int,
        rsi_window: int,
        buy_rsi: float,
        sell_rsi: float,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        if fast_window < 1 or slow_window < 2 or rsi_window < 2:
            raise ValueError("均线和 RSI 窗口必须为正数")
        if fast_window >= slow_window:
            raise ValueError("快均线窗口必须小于慢均线窗口")
        self.fast_window = fast_window
        self.slow_window = slow_window
        self.rsi_window = rsi_window
        self.buy_rsi = buy_rsi
        self.sell_rsi = sell_rsi
        # 预计算缓存
        self._fast_ma: List[Optional[float]] = []
        self._slow_ma: List[Optional[float]] = []
        self._rsi: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return self.name

    def _prepare_series(self, bars: List[Bar]) -> None:  # type: ignore[override]
        super()._prepare_series(bars)
        self._fast_ma = precompute_ma(self.closes, self.fast_window)
        self._slow_ma = precompute_ma(self.closes, self.slow_window)
        self._rsi = precompute_rsi(self.closes, self.rsi_window)

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        return {
            "fast_ma": _round_or_none(self._fast_ma[index]),
            "slow_ma": _round_or_none(self._slow_ma[index]),
            "rsi": _round_or_none(self._rsi[index]),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        fast = self._fast_ma[index]
        slow = self._slow_ma[index]
        rsi = self._rsi[index]
        if fast is None or slow is None or rsi is None:
            return
        if self.shares == 0 and fast > slow and rsi < self.buy_rsi:
            buyable = self.calc_buyable_shares(bar.close)
            if buyable > 0:
                self.buy(bar, bar.close, buyable)
        elif self.shares > 0 and (fast < slow or rsi > self.sell_rsi):
            self.sell(bar, bar.close)


__all__ = ["MARSIStrategy"]
