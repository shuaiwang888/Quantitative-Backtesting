"""动量突破 + ATR 风控。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.indicators import (
    precompute_atr,
    precompute_ma,
    precompute_rolling_high,
    slope,
)
from quant.strategies.base import BaseStrategy, _round_or_none


class MomentumATRStrategy(BaseStrategy):
    """突破前 N 日高点 + 收盘在趋势均线上方 + 斜率向上 → 买入；跌破 ATR 移动止损或趋势均线 → 卖出。"""

    name = "动量突破 + ATR风控"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        breakout_window: int,
        trend_window: int,
        atr_window: int,
        atr_multiplier: float,
        risk_per_trade: float,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        self.breakout_window = breakout_window
        self.trend_window = trend_window
        self.atr_window = atr_window
        self.atr_multiplier = atr_multiplier
        self.risk_per_trade = risk_per_trade
        self.entry_price: Optional[float] = None
        self.highest_since_entry: Optional[float] = None
        self.trailing_stop: Optional[float] = None
        # 预计算缓存
        self._atr: List[Optional[float]] = []
        self._trend_ma: List[Optional[float]] = []
        self._rolling_high: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return self.name

    def _prepare_series(self, bars: List[Bar]) -> None:  # type: ignore[override]
        super()._prepare_series(bars)
        self._atr = precompute_atr(self.highs, self.lows, self.closes, self.atr_window)
        self._trend_ma = precompute_ma(self.closes, self.trend_window)
        self._rolling_high = precompute_rolling_high(self.highs, self.breakout_window + 1)

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        return {
            "trend_ma": _round_or_none(self._trend_ma[index]),
            "atr": _round_or_none(self._atr[index]),
            "trailing_stop": _round_or_none(self.trailing_stop),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        atr = self._atr[index]
        trend_ma = self._trend_ma[index]
        # breakout 用 i-1 之前（不含当前 bar）的高点
        breakout_high = self._rolling_high[index - 1] if index > 0 else None

        # 退出逻辑
        if self.shares > 0 and atr is not None:
            self.highest_since_entry = max(
                self.highest_since_entry or bar.close, self.highs[index]
            )
            self.trailing_stop = self.highest_since_entry - self.atr_multiplier * atr
            trend_break = trend_ma is not None and bar.close < trend_ma
            stop_break = self.trailing_stop is not None and bar.close < self.trailing_stop
            if stop_break or trend_break:
                self.sell(bar, bar.close)
                self.entry_price = None
                self.highest_since_entry = None
                self.trailing_stop = None
                return

        # 入场逻辑
        if (
            self.shares == 0
            and atr is not None
            and trend_ma is not None
            and breakout_high is not None
        ):
            is_breakout = bar.close > breakout_high
            slope_window = min(10, self.trend_window)
            is_uptrend = bar.close > trend_ma and slope(self.closes, index, slope_window) > 0
            if is_breakout and is_uptrend:
                stop_price = bar.close - self.atr_multiplier * atr
                per_share_risk = max(bar.close - stop_price, bar.close * 0.03)
                risk_cash = self.cash * self.risk_per_trade
                risk_sized = int(risk_cash / per_share_risk / 100) * 100
                cash_sized = self.calc_buyable_shares(bar.close)
                buyable = max(0, min(risk_sized, cash_sized))
                if buyable > 0:
                    self.entry_price = bar.close
                    self.highest_since_entry = self.highs[index]
                    self.trailing_stop = stop_price
                    self.buy(bar, bar.close, buyable)


__all__ = ["MomentumATRStrategy"]
