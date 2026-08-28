"""现实撮合模型的回归测试。"""

from __future__ import annotations

import pytest

from quant.data.normalization import Bar
from quant.strategies.base import BaseStrategy, ExecutionConfig


class BuyThenSellStrategy(BaseStrategy):
    def get_strategy_name(self) -> str:
        return "test"

    def get_extras(self, bar: Bar, index: int):  # noqa: ARG002
        return {}

    def on_bar(self, bar: Bar, index: int) -> None:
        if index == 0:
            self.buy(bar, bar.close, 100)
        elif index == 2 and self.shares:
            self.sell(bar, bar.close)


class BuyOnceStrategy(BaseStrategy):
    def get_strategy_name(self) -> str:
        return "test"

    def get_extras(self, bar: Bar, index: int):  # noqa: ARG002
        return {}

    def on_bar(self, bar: Bar, index: int) -> None:
        if index == 0:
            self.buy(bar, bar.close, 100)


def _bar(
    date: str,
    close: float,
    *,
    open_: float | None = None,
    high: float | None = None,
    low: float | None = None,
    volume: float | None = 1000,
    code: str = "600000.SH",
) -> Bar:
    open_price = close if open_ is None else open_
    return Bar(
        date=date,
        close=close,
        open=open_price,
        high=max(open_price, close) if high is None else high,
        low=min(open_price, close) if low is None else low,
        volume=volume,
        code=code,
    )


def test_signal_fills_at_next_open_and_costs_are_split():
    strategy = BuyThenSellStrategy(initial_cash=10_000, fee_rate=0.0003)
    strategy.configure_execution(
        ExecutionConfig(
            slippage_rate=0.001,
            min_commission=5,
            stamp_duty_rate=0.0005,
            transfer_fee_rate=0.00001,
        )
    )
    result = strategy.run(
        [
            _bar("2024-01-01", 10),
            _bar("2024-01-02", 11, open_=10, high=11, low=9.9),
            _bar("2024-01-03", 11.5),
            _bar("2024-01-04", 12, open_=12, high=12.2, low=11.8),
        ]
    )

    buy, sell = result["trades"]
    assert (buy["signal_date"], buy["date"]) == ("2024-01-01", "2024-01-02")
    assert buy["price"] == pytest.approx(10.01)
    assert buy["commission"] == 5
    assert buy["stamp_duty"] == 0
    assert buy["transfer_fee"] == pytest.approx(0.01)
    assert (sell["signal_date"], sell["date"]) == ("2024-01-03", "2024-01-04")
    assert sell["price"] == pytest.approx(11.988)
    assert sell["stamp_duty"] == pytest.approx(0.6)
    assert result["summary"]["execution_model"] == "next_bar_open"
    assert result["summary"]["total_cost"] > result["summary"]["commission"]


def test_suspension_and_one_price_limit_defer_order_until_tradable_bar():
    strategy = BuyOnceStrategy(initial_cash=10_000, fee_rate=0)
    strategy.configure_execution(
        ExecutionConfig(
            slippage_rate=0,
            min_commission=0,
            stamp_duty_rate=0,
            transfer_fee_rate=0,
            max_pending_bars=5,
        )
    )
    result = strategy.run(
        [
            _bar("2024-01-01", 10),
            _bar("2024-01-02", 10, volume=0),
            _bar("2024-01-03", 11, open_=11, high=11, low=11),
            _bar("2024-01-04", 10.6, open_=10.5, high=10.8, low=10.4),
        ]
    )

    assert result["trades"][0]["date"] == "2024-01-04"
    deferred = [e for e in result["order_events"] if e["status"] == "deferred"]
    assert [e["reason"] for e in deferred] == ["停牌或无成交量", "一字涨停无法买入"]
    assert result["summary"]["deferred_orders"] == 2


def test_last_bar_signal_is_cancelled_instead_of_same_close_fill():
    strategy = BuyOnceStrategy(initial_cash=10_000, fee_rate=0)
    # 只给一根 K 线，信号没有未来数据可供成交。
    result = strategy.run([_bar("2024-01-01", 10)])
    assert result["trades"] == []
    assert result["summary"]["cancelled_orders"] == 1
    assert result["order_events"][0]["status"] == "cancelled"


@pytest.mark.parametrize(
    "config",
    [
        ExecutionConfig(slippage_rate=-0.1),
        ExecutionConfig(min_commission=-1),
        ExecutionConfig(max_pending_bars=0),
        ExecutionConfig(price_limit_pct=1.0),
    ],
)
def test_invalid_execution_configuration_is_rejected(config: ExecutionConfig):
    strategy = BuyOnceStrategy(initial_cash=10_000, fee_rate=0)
    with pytest.raises(ValueError):
        strategy.configure_execution(config)
