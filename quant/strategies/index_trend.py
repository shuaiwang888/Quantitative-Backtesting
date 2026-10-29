"""Long-only index timing with trend confirmation, hysteresis and close-based risk exits."""
from __future__ import annotations

import math
from typing import Any

from quant.data.normalization import Bar
from quant.indicators import precompute_ma
from quant.strategies.base import BaseStrategy, Trade, _round_or_none


class IndexTrendStrategy(BaseStrategy):
    """日收盘信号、次日开盘执行；退出后等待新的趋势入场条件。"""

    def __init__(self, initial_cash: float, fee_rate: float, fast_window: int = 20,
                 slow_window: int = 120, entry_buffer: float = 0.01,
                 exit_buffer: float = 0.01, trailing_stop_pct: float = 0.12,
                 position_fraction: float = 1.0) -> None:
        super().__init__(initial_cash, fee_rate)
        if not 2 <= fast_window < slow_window <= 10000:
            raise ValueError('窗口需要满足 2 <= fast_window < slow_window <= 10000')
        values = (entry_buffer, exit_buffer, trailing_stop_pct, position_fraction)
        if not all(math.isfinite(value) for value in values):
            raise ValueError('策略参数必须为有限数值')
        if not 0 <= entry_buffer < 0.2 or not 0 <= exit_buffer < 0.2:
            raise ValueError('均线缓冲必须在 [0, 0.2) 内')
        if not 0 < trailing_stop_pct < 1 or not 0 < position_fraction <= 1:
            raise ValueError('止损比例和仓位比例必须在 (0, 1] 内，止损比例不能等于 1')
        self.fast_window = fast_window
        self.slow_window = slow_window
        self.entry_buffer = entry_buffer
        self.exit_buffer = exit_buffer
        self.trailing_stop_pct = trailing_stop_pct
        self.position_fraction = position_fraction
        self.peak_close: float | None = None

    def get_strategy_name(self) -> str:
        return '指数趋势过滤 + 回撤退出'

    def _prepare_series(self, bars: list[Bar]) -> None:
        super()._prepare_series(bars)
        self._fast = precompute_ma(self.closes, self.fast_window)
        self._slow = precompute_ma(self.closes, self.slow_window)

    def reset_strategy_state(self) -> None:
        self.peak_close = None

    def on_trade(self, trade: Trade) -> None:
        self.peak_close = trade.price if trade.side == 'buy' else None

    def get_extras(self, bar: Bar, index: int) -> dict[str, Any]:
        return {'fast_ma': _round_or_none(self._fast[index]),
                'slow_ma': _round_or_none(self._slow[index]),
                'trailing_stop': _round_or_none(self.peak_close * (1 - self.trailing_stop_pct)
                                                if self.peak_close is not None else None)}

    def on_bar(self, bar: Bar, index: int) -> None:
        fast, slow = self._fast[index], self._slow[index]
        if fast is None or slow is None:
            return
        if self.shares:
            self.peak_close = max(self.peak_close or bar.close, bar.close)
            if (bar.close < slow * (1 - self.exit_buffer)
                    or bar.close <= self.peak_close * (1 - self.trailing_stop_pct)):
                self.sell(bar, bar.close)
        elif fast > slow and bar.close > slow * (1 + self.entry_buffer):
            lot = self.execution.lot_size
            buyable = self.calc_buyable_shares(bar.close)
            shares = int(buyable * self.position_fraction / lot) * lot
            self.buy(bar, bar.close, shares)
