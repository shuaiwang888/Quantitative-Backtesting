"""双均线交叉策略。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.indicators import precompute_ma
from quant.strategies.base import BaseStrategy, _round_or_none


class MovingAverageStrategy(BaseStrategy):
    """快均线上穿慢均线买入；下穿卖出。允许初始建仓（首次快 > 慢）。"""

    name = "双均线交叉"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        fast_window: int,
        slow_window: int,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        if fast_window < 1 or slow_window < 2:
            raise ValueError("均线窗口必须为正数，且慢线至少为 2")
        if fast_window >= slow_window:
            raise ValueError("快线窗口必须小于慢线窗口")
        self.fast_window = fast_window
        self.slow_window = slow_window
        # 预计算缓存
        self._fast_ma: List[Optional[float]] = []
        self._slow_ma: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return self.name

    def _prepare_series(self, bars: List[Bar]) -> None:  # type: ignore[override]
        super()._prepare_series(bars)
        self._fast_ma = precompute_ma(self.closes, self.fast_window)
        self._slow_ma = precompute_ma(self.closes, self.slow_window)

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        return {
            "fast_ma": _round_or_none(self._fast_ma[index]),
            "slow_ma": _round_or_none(self._slow_ma[index]),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        fast = self._fast_ma[index]
        slow = self._slow_ma[index]
        if fast is None or slow is None:
            return

        if index > 0:
            prev_fast = self._fast_ma[index - 1]
            prev_slow = self._slow_ma[index - 1]
            if prev_fast is not None and prev_slow is not None:
                crossed_up = prev_fast <= prev_slow and fast > slow
                crossed_down = prev_fast >= prev_slow and fast < slow
                if crossed_up and self.shares == 0:
                    buyable = self.calc_buyable_shares(bar.close)
                    if buyable > 0:
                        self.buy(bar, bar.close, buyable)
                elif crossed_down and self.shares > 0:
                    self.sell(bar, bar.close)
                return

        if fast > slow and self.shares == 0:
            buyable = self.calc_buyable_shares(bar.close)
            if buyable > 0:
                self.buy(bar, bar.close, buyable)


__all__ = ["MovingAverageStrategy"]
