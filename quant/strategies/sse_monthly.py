"""低频上证指数择时：月初趋势/动量确认，日收盘回撤退出。"""
from __future__ import annotations
import math
from typing import Any
from quant.data.normalization import Bar
from quant.indicators import precompute_ma
from quant.strategies.base import BaseStrategy, Trade, _round_or_none


class SSEMonthlyStrategy(BaseStrategy):
    def __init__(self, initial_cash: float, fee_rate: float, trend_window: int = 200,
                 momentum_window: int = 126, buffer_pct: float = 0.01,
                 trailing_stop_pct: float = 0.12, position_fraction: float = 1.0) -> None:
        super().__init__(initial_cash, fee_rate)
        if not 2 <= trend_window <= 10000 or not 2 <= momentum_window <= 10000:
            raise ValueError('趋势和动量窗口必须在 2-10000 内')
        if not all(math.isfinite(value) for value in (buffer_pct, trailing_stop_pct, position_fraction)):
            raise ValueError('策略参数必须是有限数值')
        if not 0 <= buffer_pct < 0.2 or not 0 < trailing_stop_pct < 1 or not 0 < position_fraction <= 1:
            raise ValueError('缓冲、止损或仓位比例超出范围')
        self.trend_window = trend_window
        self.momentum_window = momentum_window
        self.buffer_pct = buffer_pct
        self.trailing_stop_pct = trailing_stop_pct
        self.position_fraction = position_fraction
        self.peak_close: float | None = None

    def get_strategy_name(self) -> str:
        return '上证指数月度趋势 + 动量风控'

    def _prepare_series(self, bars: list[Bar]) -> None:
        super()._prepare_series(bars)
        self._trend = precompute_ma(self.closes, self.trend_window)
        self._months = [bar.date[:7] for bar in bars]

    def reset_strategy_state(self) -> None:
        self.peak_close = None

    def on_trade(self, trade: Trade) -> None:
        self.peak_close = trade.price if trade.side == 'buy' else None

    def get_extras(self, bar: Bar, index: int) -> dict[str, Any]:
        momentum = bar.close / self.closes[index-self.momentum_window] - 1 if index >= self.momentum_window else None
        return {'trend_ma': _round_or_none(self._trend[index]), 'momentum': _round_or_none(momentum),
                'trailing_stop': _round_or_none(self.peak_close * (1-self.trailing_stop_pct)
                                                if self.peak_close is not None else None)}

    def on_bar(self, bar: Bar, index: int) -> None:
        trend = self._trend[index]
        if trend is None or index < self.momentum_window:
            return
        momentum = bar.close / self.closes[index-self.momentum_window] - 1
        if self.shares:
            self.peak_close = max(self.peak_close or bar.close, bar.close)
            if bar.close <= self.peak_close * (1-self.trailing_stop_pct):
                self.sell(bar, bar.close)
                return
        # 月份变化仅取决于已知日期，不读取未来交易日或未来价格。
        if index and self._months[index] == self._months[index-1]:
            return
        if self.shares:
            if bar.close < trend * (1-self.buffer_pct) or momentum < 0:
                self.sell(bar, bar.close)
        elif bar.close > trend * (1+self.buffer_pct) and momentum > 0:
            lot = self.execution.lot_size
            shares = int(self.calc_buyable_shares(bar.close) * self.position_fraction / lot) * lot
            self.buy(bar, bar.close, shares)
