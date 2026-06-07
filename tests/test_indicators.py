"""指标层单元测试。"""

from __future__ import annotations

import math

import pytest

from quant.indicators import (
    precompute_atr,
    precompute_ma,
    precompute_rsi,
    precompute_rolling_high,
    precompute_rolling_low,
    slope,
)


class TestMovingAverage:
    def test_basic(self):
        ma = precompute_ma([1.0, 2.0, 3.0, 4.0, 5.0], 3)
        assert ma[0] is None
        assert ma[1] is None
        assert ma[2] == 2.0
        assert ma[3] == 3.0
        assert ma[4] == 4.0

    def test_window_one(self):
        ma = precompute_ma([1.5, 2.5, 3.5], 1)
        assert ma == [1.5, 2.5, 3.5]

    def test_window_larger_than_data(self):
        assert precompute_ma([1.0, 2.0], 5) == [None, None]

    def test_invalid_window(self):
        assert precompute_ma([1.0, 2.0], 0) == [None, None]
        assert precompute_ma([1.0, 2.0], -1) == [None, None]

    def test_empty(self):
        assert precompute_ma([], 3) == []


class TestATR:
    def test_basic(self):
        highs = [12, 14, 13, 15, 16]
        lows = [10, 11, 10, 12, 13]
        closes = [11, 13, 12, 14, 15]
        atr = precompute_atr(highs, lows, closes, 2)
        # index 0 窗口不足
        assert atr[0] is None
        # index 1 之后应有值
        assert atr[1] is not None
        assert atr[4] > 0

    def test_mismatched_lengths(self):
        with pytest.raises(ValueError):
            precompute_atr([1.0], [1.0, 2.0], [1.0, 2.0], 2)


class TestRSI:
    def test_all_up(self):
        closes = [float(i) for i in range(20, 40)]
        rsi = precompute_rsi(closes, 14)
        # 全部上涨 → RSI 应为 100
        assert rsi[14] == 100.0
        for v in rsi[15:]:
            assert v == 100.0

    def test_all_down(self):
        closes = [float(i) for i in range(40, 20, -1)]
        rsi = precompute_rsi(closes, 14)
        # 全部下跌 → avg_gain=0 → avg_loss>0 → RS=0 → RSI=0
        assert rsi[14] == 0.0
        for v in rsi[15:]:
            assert v == 0.0

    def test_window_too_small(self):
        # window=2, n=2: 不够 window+1=3 → 全 None
        rsi = precompute_rsi([1.0, 2.0], 2)
        assert rsi == [None, None]


class TestRollingHighLow:
    def test_rolling_high(self):
        rh = precompute_rolling_high([3, 1, 4, 1, 5, 9, 2, 6], 3)
        assert rh[0] is None
        assert rh[1] is None
        assert rh[2] == 4
        assert rh[3] == 4
        assert rh[4] == 5
        assert rh[7] == 9

    def test_rolling_low(self):
        rl = precompute_rolling_low([3, 1, 4, 1, 5, 9, 2, 6], 3)
        assert rl[0] is None
        assert rl[2] == 1
        assert rl[7] == 2

    def test_invalid_window(self):
        assert precompute_rolling_high([1.0, 2.0], 0) == [None, None]


class TestSlope:
    def test_basic(self):
        assert slope([1.0, 2.0, 3.0, 4.0, 5.0], 4, 5) == 4.0
        assert slope([5.0, 4.0, 3.0, 2.0, 1.0], 4, 5) == -4.0

    def test_window_too_large(self):
        assert slope([1.0, 2.0], 1, 5) == 0.0
