"""价量因子库 + FactorStrategy + 寻优并行/热力图 测试。"""

from __future__ import annotations

import os
import time

import pytest

from quant.data.normalization import Bar
from quant.factors import compute_all, get_factor, list_factors
from quant.factors.operators import Series, ts_max, ts_mean, ts_rank, ts_stddev
from quant.services.optimize import OptimizeRequest, _build_heatmap, run_grid_search
from quant.strategies import SPECS, run_backtest
from quant.strategies.factor_strategy import FactorStrategy, run_factor_strategy


def _make_bars(n: int = 80, base: float = 10.0, seed: int = 0) -> list[Bar]:
    """生成确定性的 K 线，避免随机性。"""
    import random

    rng = random.Random(seed)
    bars: list[Bar] = []
    close = base
    for i in range(n):
        # 简单线性 + 噪声
        noise = (rng.random() - 0.5) * 0.5
        open_p = close + noise
        close = open_p + (rng.random() - 0.5) * 0.3
        high = max(open_p, close) + rng.random() * 0.2
        low = min(open_p, close) - rng.random() * 0.2
        vol = 1000 + rng.randint(-200, 200) + i * 5
        bars.append(
            Bar(
                date=f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
                close=round(close, 4),
                open=round(open_p, 4),
                high=round(high, 4),
                low=round(low, 4),
                volume=float(vol),
                amount=close * vol,
                code="TEST",
                name="Test",
            )
        )
    return bars


# --- operators sanity ---


class TestOperators:
    def test_ts_max_basic(self):
        s: Series = [1, 3, 2, 5, 4, None, 2]
        out = ts_max(s, 3)
        # 前 2 个位置是 None
        assert out[0] is None and out[1] is None
        assert out[2] == 3
        assert out[3] == 5
        assert out[5] is None  # 含 None 时整窗置 None

    def test_ts_mean_simple(self):
        s = [1.0, 2, 3, 4, 5, 6]
        out = ts_mean(s, 3)
        assert out[0] is None and out[1] is None
        assert out[2] == 2.0
        assert out[5] == 5.0

    def test_ts_rank_bounds(self):
        s = [3, 1, 4, 1, 5, 9, 2, 6]
        out = ts_rank(s, 4)
        # 滚动窗口里，rank 越接近 0 越小，越接近 1 越大
        for v in out[3:]:
            assert v is None or 0 <= v <= 1

    def test_ts_stddev_non_negative(self):
        import math

        s = [1.0, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        out = ts_stddev(s, 5)
        for v in out[4:]:
            assert v is not None
            assert v >= 0 and math.isfinite(v)


# --- alpha 因子 sanity ---


class TestAlpha101Factors:
    def test_at_least_30_factors_registered(self):
        assert len(list_factors()) >= 30, f"只注册了 {len(list_factors())} 个因子"

    def test_compute_all_returns_dict(self):
        bars = _make_bars(80)
        out = compute_all(bars)
        assert len(out) == len(list_factors())
        # alpha_019 需要 ts_sum(returns, 250)，80 根不够；其余因子应当有非空值
        LONG_HISTORY_FACTORS = {"alpha_019"}
        for name, values in out.items():
            assert len(values) == len(bars), f"{name} 长度不匹配"
            if name in LONG_HISTORY_FACTORS:
                continue  # 已知对短 bar 退化为全 None
            non_null = sum(1 for v in values if v is not None)
            assert non_null > 0, f"{name} 全是 None"

    @pytest.mark.parametrize(
        "name",
        [
            "alpha_001",
            "alpha_002",
            "alpha_038",
            "alpha_066",
            "alpha_101",
        ],
    )
    def test_individual_alpha_returns_signal(self, name):
        bars = _make_bars(80)
        factor = get_factor(name)
        values = factor.compute(bars)
        assert len(values) == len(bars)
        # 至少一半的 bar 应该能算出非空值（典型 alpha 在 d=20 之后才有值）
        non_null = [v for v in values[20:] if v is not None]
        assert len(non_null) > 5, f"{name} 计算结果几乎全是 None"

    def test_factor_display_name_present(self):
        for name in list_factors():
            assert get_factor(name).display_name, f"{name} 缺 display_name"


# --- FactorStrategy ---


class TestFactorStrategy:
    def test_factor_strategy_runs(self):
        bars = _make_bars(100)
        result = run_factor_strategy(
            bars, "alpha_001", initial_cash=100000, lookback=20, buy_z=1.0, sell_z=-0.5
        )
        assert "summary" in result
        assert "equity_curve" in result
        # extras 在 build_result 时被 ** 展开到 equity_curve 顶层
        first_point = result["equity_curve"][0]
        assert "factor_z" in first_point, f"first_point keys: {list(first_point.keys())}"

    def test_factor_strategy_validates_params(self):
        with pytest.raises(ValueError, match="lookback"):
            FactorStrategy(
                initial_cash=100000,
                fee_rate=0.0003,
                factor_name="alpha_001",
                lookback=2,
            )
        with pytest.raises(ValueError, match="buy_z"):
            FactorStrategy(
                initial_cash=100000,
                fee_rate=0.0003,
                factor_name="alpha_001",
                buy_z=0.5,
                sell_z=1.0,
            )

    def test_factor_strategies_in_specs(self):
        factor_specs = {k: v for k, v in SPECS.items() if k.startswith("factor_")}
        assert len(factor_specs) >= 3, "至少注册 3 个 factor_xxx 策略"
        for spec in factor_specs.values():
            assert spec.default_params.get("factor_name"), f"{spec.name} 缺 factor_name"

    def test_factor_strategy_in_runs_via_run_backtest(self):
        bars = _make_bars(100)
        result = run_backtest("factor_alpha_101", bars, initial_cash=100000)
        assert "summary" in result
        assert result["summary"]["strategy"]


# --- 并行寻优 + 热力图 ---


class TestOptimizeParallelAndHeatmap:
    def test_small_grid_uses_sequential(self):
        bars = _make_bars(80)
        req = OptimizeRequest(
            strategy="channel_reversal",
            param_ranges={"channel_window": [3, 6, 9]},  # 只有 3 组合
        )
        result = run_grid_search(req, bars)
        assert result["parallel"] is False
        assert result["n_jobs"] == 1
        assert len(result["optimization_results"]) == 3

    def test_large_grid_uses_parallel(self):
        # 5x4 = 20 组合 > MIN_PARALLEL_THRESHOLD(8)
        bars = _make_bars(80)
        req = OptimizeRequest(
            strategy="channel_reversal",
            param_ranges={"channel_window": [3, 4, 5, 6, 7], "stop_loss_pct": [0.03, 0.05, 0.08, 0.1]},
        )
        start = time.time()
        result = run_grid_search(req, bars)
        elapsed = time.time() - start
        assert result["combinations"] == 20
        assert result["parallel"] is True
        assert result["n_jobs"] >= 2
        # 并行跑应当 30s 内完成
        assert elapsed < 30, f"并行寻优过慢: {elapsed:.1f}s"

    def test_heatmap_data_for_2_params(self):
        bars = _make_bars(80)
        req = OptimizeRequest(
            strategy="channel_reversal",
            param_ranges={"channel_window": [3, 6, 9], "stop_loss_pct": [0.05, 0.1]},
        )
        result = run_grid_search(req, bars)
        assert "heatmap" in result
        hp = result["heatmap"]
        assert hp["x_key"] == "channel_window"
        assert hp["y_key"] == "stop_loss_pct"
        assert len(hp["x_values"]) == 3
        assert len(hp["y_values"]) == 2
        assert len(hp["z_values"]) == 2
        assert all(len(row) == 3 for row in hp["z_values"])

    def test_no_heatmap_for_1_or_3_params(self):
        bars = _make_bars(80)
        # 1 个参数
        r1 = run_grid_search(
            OptimizeRequest(strategy="channel_reversal", param_ranges={"channel_window": [3, 6]}),
            bars,
        )
        assert "heatmap" not in r1
        # 3 个参数（用 momentum_atr，5 个有效参数可选 3 个）
        r3 = run_grid_search(
            OptimizeRequest(
                strategy="momentum_atr",
                param_ranges={
                    "breakout_window": [10, 20],
                    "trend_window": [30, 60],
                    "atr_window": [7, 14],
                },
            ),
            bars,
        )
        assert "heatmap" not in r3

    def test_build_heatmap_with_sparse_data(self):
        # 部分位置是 None，build_heatmap 应当正确处理
        results = [
            {"params": {"a": 1, "b": 1}, "total_return": 0.1},
            {"params": {"a": 2, "b": 1}, "total_return": None},  # 失败
            {"params": {"a": 1, "b": 2}, "total_return": 0.05},
        ]
        hp = _build_heatmap(results, ["a", "b"])
        assert hp is not None
        assert hp["z_values"][0][0] == 0.1
        assert hp["z_values"][0][1] is None
        assert hp["z_values"][1][0] == 0.05
