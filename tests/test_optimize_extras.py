"""寻优响应扩展字段测试：Calmar / 6 个 heatmap / 参数重要性 / 双重最佳。"""

from __future__ import annotations

import pytest

from quant.data.normalization import Bar
from quant.services.optimize import (
    OPTIMIZE_HEATMAP_METRICS,
    OptimizeRequest,
    _calmar,
    _compute_param_importance,
    run_grid_search,
)


def _bars(n: int = 60) -> list[Bar]:
    """制造一个能让 moving_average / ma_rsi 都跑得动的 K 线序列。"""
    out = []
    for i in range(n):
        out.append(
            Bar(
                date=f"2024-01-{(i % 30) + 1:02d}" if i < 30
                     else f"2024-02-{(i % 28) + 1:02d}",
                close=10.0 + 0.05 * i + (0.3 if i % 5 == 0 else -0.2 if i % 7 == 0 else 0),
                open=10.0 + 0.04 * i,
                high=10.0 + 0.06 * i,
                low=10.0 + 0.03 * i,
                volume=1000.0 + i * 10,
                code="TEST",
                name="Test",
            )
        )
    return out


class TestCalmar:
    """Calmar = total_return / max(|max_drawdown|, 0.01)。"""

    def test_positive_calmar(self):
        # 浮点精度：用 pytest.approx 比较
        assert _calmar({"total_return": 0.3, "max_drawdown": -0.1}) == pytest.approx(3.0)

    def test_negative_calmar(self):
        assert _calmar({"total_return": -0.1, "max_drawdown": -0.2}) == pytest.approx(-0.5)

    def test_none_passthrough(self):
        assert _calmar({"total_return": None, "max_drawdown": -0.1}) is None
        assert _calmar({"total_return": 0.1, "max_drawdown": None}) is None

    def test_zero_drawdown_floored(self):
        # max_drawdown=0 时除以 0.01 而不是 0（避免 ZeroDivisionError）
        assert _calmar({"total_return": 0.05, "max_drawdown": 0}) == pytest.approx(5.0)


class TestParamImportance:
    """参数重要性：边际效应 + max-normalize。"""

    def test_empty_results(self):
        assert _compute_param_importance([], []) == []

    def test_normalize_max_to_one(self):
        results = [
            {"params": {"a": 1}, "total_return": 0.1},
            {"params": {"a": 2}, "total_return": 0.3},
            {"params": {"a": 3}, "total_return": 0.2},
        ]
        imp = _compute_param_importance(results, ["a"])
        assert len(imp) == 1
        assert imp[0]["importance"] == 1.0  # max 归一化
        assert imp[0]["param"] == "a"
        # 三个取值，组均值分别是 0.1/0.3/0.2
        assert sorted(imp[0]["values"]) == [1, 2, 3]
        assert len(imp[0]["means"]) == 3

    def test_identical_param_zero_importance(self):
        # a 变化但 total_return 全相同 → a 重要性 = 0
        results = [
            {"params": {"a": 1, "b": 5}, "total_return": 0.1},
            {"params": {"a": 2, "b": 5}, "total_return": 0.1},
        ]
        imp = _compute_param_importance(results, ["a", "b"])
        a = next(x for x in imp if x["param"] == "a")
        assert a["importance"] == 0.0

    def test_relative_importance_a_above_c_above_b(self):
        # a 影响 0.2（取值 1→2 总收益 +0.2），c 影响 0.05（0.1→0.2 加 0.05），b 不影响
        results = []
        for a in [1, 2]:
            for b in [10, 20]:
                for c in [0.1, 0.2]:
                    ret = 0.1 * a + 0.25 * c
                    results.append({"params": {"a": a, "b": b, "c": c}, "total_return": ret})
        imp = _compute_param_importance(results, ["a", "b", "c"])
        by_name = {x["param"]: x["importance"] for x in imp}
        assert by_name["a"] == 1.0  # max 归一化
        assert by_name["b"] < by_name["c"] < by_name["a"]


class TestRunGridSearchExtras:
    """run_grid_search 响应字段扩展。"""

    def test_2param_returns_six_heatmaps(self):
        """2 参时 6 个 metric 全部生成 heatmap_* 字段。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5], "slow_window": [10, 20]},
            ),
            _bars(60),
        )
        for m in OPTIMIZE_HEATMAP_METRICS:
            assert f"heatmap_{m}" in result, f"missing heatmap_{m}"
            hm = result[f"heatmap_{m}"]
            assert hm["x_values"] and hm["y_values"]
            assert hm["z_values"]  # non-empty
        # 旧字段应该被新字段取代
        assert "heatmap" not in result
        assert "heatmap_drawdown" not in result

    def test_3param_no_heatmap_only_importance(self):
        """3 参时只返回 importance，不返回 heatmap_*。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="ma_rsi",
                param_ranges={
                    "fast_window": [3, 5],
                    "slow_window": [10, 20],
                    "rsi_window": [10, 14],
                },
            ),
            _bars(60),
        )
        assert "heatmap_total_return" not in result
        assert "param_importance" in result
        assert len(result["param_importance"]) == 3
        params_in_order = [x["param"] for x in result["param_importance"]]
        assert params_in_order == ["fast_window", "slow_window", "rsi_window"]

    def test_1param_no_heatmap_has_importance(self):
        """1 参时无 heatmap，但仍给出 importance（用 = 1.0 占位）。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5, 7, 9]},
            ),
            _bars(60),
        )
        assert "heatmap_total_return" not in result
        assert "param_importance" in result
        assert len(result["param_importance"]) == 1
        assert result["param_importance"][0]["param"] == "fast_window"

    def test_best_by_return_matches_first_sorted(self):
        """best_by_return = optimization_results[0].params（已按 total_return 降序）。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5, 7], "slow_window": [10, 20, 30]},
            ),
            _bars(60),
        )
        assert result["best_by_return"] == result["optimization_results"][0]["params"]
        assert isinstance(result["best_by_return"], dict)

    def test_best_by_calmar_and_top_robust(self):
        """Calmar 最高 + Top 10 鲁棒表都存在且 calmar 字段类型正确。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5, 7], "slow_window": [10, 20, 30]},
            ),
            _bars(60),
        )
        assert "best_by_calmar" in result
        assert "top_robust" in result
        assert len(result["top_robust"]) <= 10
        for r in result["top_robust"]:
            assert "calmar" in r
            assert isinstance(r["calmar"], float)
        # top_robust[0] 的 params 应等于 best_by_calmar
        assert result["top_robust"][0]["params"] == result["best_by_calmar"]
        # Calmar 降序
        calmars = [r["calmar"] for r in result["top_robust"]]
        assert calmars == sorted(calmars, reverse=True)

    def test_empty_results_no_crash(self):
        """results 为空（全部失败）时不崩。"""
        result = run_grid_search(
            OptimizeRequest(
                strategy="channel_reversal",
                # 故意造一个一定失败的参数：stop_loss_pct=1.5 触发 ValueError
                param_ranges={"channel_window": [5], "stop_loss_pct": [1.5]},
            ),
            _bars(60),
        )
        # 失败时 results 为空，但 best_by_return 等字段仍是 None，不应崩
        assert result["best_by_return"] is None
        assert result["best_by_calmar"] is None
        assert result["top_robust"] == []
        # param_importance 也应返回空或零值
        assert result["param_importance"] in ([],) or all(
            x["importance"] == 0.0 for x in result["param_importance"]
        )
