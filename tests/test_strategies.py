"""策略层单元测试。"""

from __future__ import annotations

import pytest

from quant.data.normalization import Bar
from quant.errors import ValidationError
from quant.strategies import (
    SPECS,
    get_spec,
    list_strategies,
    make_strategy,
    min_bars,
    run_backtest,
)


def _make_bars(n: int, base: float = 10.0) -> list[Bar]:
    bars = []
    for i in range(n):
        bars.append(
            Bar(
                date=f"2024-01-{i + 1:02d}" if i < 30 else f"2024-02-{i - 29:02d}",
                close=base + 0.05 * i,
                open=base + 0.04 * i,
                high=base + 0.06 * i,
                low=base + 0.03 * i,
                volume=1000.0 + i * 10,
                code="TEST",
                name="Test",
            )
        )
    return bars


class TestStrategyRegistry:
    def test_all_strategies_listed(self):
        names = [s.name for s in list_strategies()]
        assert set(names) == {
            "momentum_atr",
            "moving_average",
            "ma_rsi",
            "channel_reversal",
            "volume_shadow_break",
        }

    def test_get_spec_unknown(self):
        with pytest.raises(KeyError):
            get_spec("nonexistent")

    def test_make_strategy_unknown(self):
        with pytest.raises(KeyError):
            make_strategy("foo", initial_cash=1000)

    def test_make_strategy_uses_defaults(self):
        s = make_strategy("momentum_atr", initial_cash=1000)
        assert s.initial_cash == 1000
        assert s.breakout_window == 20  # default

    def test_make_strategy_overrides(self):
        s = make_strategy("momentum_atr", initial_cash=1000, breakout_window=10)
        assert s.breakout_window == 10


class TestRunBacktest:
    def test_too_few_bars_raises(self):
        bars = _make_bars(10)
        with pytest.raises(ValidationError, match="至少需要"):
            run_backtest("moving_average", bars)

    def test_all_strategies_produce_result(self, sample_bars):
        for name in SPECS:
            result = run_backtest(name, sample_bars)
            assert "summary" in result
            assert "equity_curve" in result
            assert "trades" in result
            assert "bars" in result
            summary = result["summary"]
            assert summary["strategy"]
            assert summary["bar_count"] == len(sample_bars)
            assert summary["start_date"] == sample_bars[0].date
            assert summary["end_date"] == sample_bars[-1].date


class TestFeeRateSeparation:
    """fee_rate 是服务级参数，不应出现在 SPECS.default_params。"""

    def test_fee_rate_not_in_spec_defaults(self):
        for name, spec in SPECS.items():
            assert "fee_rate" not in spec.default_params, (
                f"策略 {name} 的 default_params 包含 fee_rate，应该独立于 SPECS"
            )

    def test_make_strategy_accepts_fee_rate_explicitly(self):
        s = make_strategy("channel_reversal", initial_cash=1000, fee_rate=0.01)
        assert s.fee_rate == 0.01

    def test_make_strategy_default_fee_rate(self):
        s = make_strategy("channel_reversal", initial_cash=1000)
        assert s.fee_rate == 0.0003  # 默认值

    def test_run_backtest_accepts_fee_rate(self, sample_bars):
        result = run_backtest(
            "channel_reversal", sample_bars, initial_cash=1000, fee_rate=0.002
        )
        assert "summary" in result

    def test_run_backtest_uses_explicit_fee_rate(self, sample_bars):
        # 当 fee_rate=0 时，交易成本为 0 → 期末权益应高于默认 fee_rate=0.0003
        result_zero = run_backtest(
            "channel_reversal", sample_bars, initial_cash=100000, fee_rate=0
        )
        result_default = run_backtest(
            "channel_reversal", sample_bars, initial_cash=100000
        )
        # 零手续费情况下净收益应 ≥ 默认手续费情况
        assert (
            result_zero["summary"]["final_equity"]
            >= result_default["summary"]["final_equity"]
        )


class TestMovingAverage:
    def test_initial_cash_must_be_positive(self):
        with pytest.raises(ValueError, match="初始资金"):
            make_strategy("moving_average", initial_cash=0)

    def test_fast_must_be_less_than_slow(self):
        with pytest.raises(ValueError, match="快线"):
            make_strategy(
                "moving_average", initial_cash=1000, fast_window=20, slow_window=10
            )

    def test_triggers_buy_in_uptrend(self):
        bars = _make_bars(50, base=10.0)
        result = run_backtest("moving_average", bars, fast_window=3, slow_window=10)
        # 上升趋势 → 至少一次买入
        assert result["summary"]["trade_count"] >= 1


class TestMomentumATR:
    def test_window_mismatch(self):
        bars = _make_bars(30)
        with pytest.raises(ValidationError):
            run_backtest("momentum_atr", bars)

    def test_enough_data_runs(self, sample_bars):
        result = run_backtest("momentum_atr", sample_bars)
        assert "summary" in result


class TestChannelReversal:
    def test_stop_loss_bounds(self):
        with pytest.raises(ValueError, match="止损"):
            make_strategy("channel_reversal", initial_cash=1000, stop_loss_pct=1.5)
        with pytest.raises(ValueError, match="止损"):
            make_strategy("channel_reversal", initial_cash=1000, stop_loss_pct=0)

    def test_window_at_least_two(self):
        with pytest.raises(ValueError, match="通道"):
            make_strategy("channel_reversal", initial_cash=1000, channel_window=1)


class TestMARSI:
    def test_window_validation(self):
        with pytest.raises(ValueError):
            make_strategy("ma_rsi", initial_cash=1000, rsi_window=1)

    def test_fast_less_than_slow(self):
        with pytest.raises(ValueError):
            make_strategy("ma_rsi", initial_cash=1000, fast_window=20, slow_window=10)


class TestVolumeShadowBreak:
    def test_volume_multiplier_must_be_gt_one(self):
        with pytest.raises(ValueError, match="倍量倍数"):
            make_strategy("volume_shadow_break", initial_cash=1000, volume_multiplier=0.9)

    def test_sell_volume_multiplier_must_be_gt_one(self):
        with pytest.raises(ValueError, match="卖出放量"):
            make_strategy(
                "volume_shadow_break",
                initial_cash=1000,
                sell_volume_multiplier=0.9,
            )

    def test_shadow_ratio_bounds(self):
        with pytest.raises(ValueError, match="上影线"):
            make_strategy(
                "volume_shadow_break", initial_cash=1000, upper_shadow_ratio=1.5
            )
        with pytest.raises(ValueError, match="下影线"):
            make_strategy(
                "volume_shadow_break", initial_cash=1000, lower_shadow_ratio=1.5
            )


class TestMinBars:
    def test_min_bars_values(self):
        # 这些值是各策略的最低要求
        assert min_bars("moving_average") >= 20
        assert min_bars("momentum_atr") >= 60
        assert min_bars("ma_rsi") >= 20
        assert min_bars("channel_reversal") >= 5
        assert min_bars("volume_shadow_break") >= 4
