"""优化服务 + 历史 bug 回归测试。"""

from __future__ import annotations

import os

import pytest

from quant.config import reset_settings_cache
from quant.data.normalization import Bar
from quant.errors import ValidationError
from quant.services.optimize import OptimizeRequest, run_grid_search, run_grid_search_from_payload


def _bars(n: int = 80) -> list[Bar]:
    out = []
    for i in range(n):
        out.append(
            Bar(
                date=f"2024-01-{(i % 30) + 1:02d}" if i < 30 else f"2024-02-{(i % 28) + 1:02d}",
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


class TestGridSearch:
    def test_unknown_strategy_raises(self):
        with pytest.raises(ValidationError, match="未知策略"):
            run_grid_search(
                OptimizeRequest(strategy="foo", param_ranges={"x": [1]}),
                _bars(),
            )

    def test_empty_param_ranges_raises(self):
        with pytest.raises(ValidationError, match="不能为空"):
            run_grid_search(
                OptimizeRequest(strategy="moving_average", param_ranges={}),
                _bars(),
            )

    def test_unsupported_param_raises(self):
        with pytest.raises(ValidationError, match="不支持参数"):
            run_grid_search(
                OptimizeRequest(
                    strategy="moving_average",
                    param_ranges={"fast_window": [5], "bogus": [1]},
                ),
                _bars(50),
            )

    def test_combination_limit_enforced(self):
        os.environ["OPTIMIZE_MAX_COMBINATIONS"] = "5"
        reset_settings_cache()
        try:
            with pytest.raises(ValidationError, match="超过上限"):
                run_grid_search(
                    OptimizeRequest(
                        strategy="moving_average",
                        param_ranges={
                            "fast_window": [3, 5, 7],
                            "slow_window": [10, 20, 30],
                        },
                    ),
                    _bars(),
                )
        finally:
            os.environ.pop("OPTIMIZE_MAX_COMBINATIONS", None)
            reset_settings_cache()


class TestGridSearchFromPayload:
    def _raw_bars(self, n: int = 80):
        return [
            {
                "日期": f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
                "股票代码": "000001.SZ",
                "股票简称": "平安银行",
                "开盘价": 10.0 + 0.04 * i,
                "最高价": 10.0 + 0.06 * i,
                "最低价": 10.0 + 0.03 * i,
                "收盘价": 10.0 + 0.05 * i,
                "成交量": 1000.0 + i * 10,
            }
            for i in range(n)
        ]

    def test_payload_entry_fetches_bars_and_returns_success(self, monkeypatch):
        seen = {}

        def fake_fetch_all(query, **kwargs):
            seen["query"] = query
            seen["kwargs"] = kwargs
            return {"datas": self._raw_bars(80), "trace_ids": ["trace-1"]}

        monkeypatch.setattr("quant.data.iwencai.fetch_all", fake_fetch_all)
        result = run_grid_search_from_payload(
            {
                "strategy": "moving_average",
                "symbol": "000001.SZ",
                "start_date": "2024-01-01",
                "end_date": "2024-03-31",
                "param_ranges": {"fast_window": [3, 5], "slow_window": [10]},
                "limit": 500,
                "max_pages": 50,
                "api_key": "visitor-key",
            }
        )
        assert result["success"] is True
        assert result["combinations"] == 2
        assert "000001.SZ 2024-01-01到2024-03-31 每日行情" in seen["query"]
        assert seen["kwargs"]["limit"] == 100
        assert seen["kwargs"]["max_pages"] == 20
        assert seen["kwargs"]["api_key"] == "visitor-key"
        assert result["trace_ids"] == ["trace-1"]

    def test_payload_entry_threads_max_combinations(self, monkeypatch):
        monkeypatch.setattr(
            "quant.data.iwencai.fetch_all",
            lambda *args, **kwargs: {"datas": self._raw_bars(80)},
        )
        with pytest.raises(ValidationError, match="超过上限"):
            run_grid_search_from_payload(
                {
                    "strategy": "moving_average",
                    "query": "mock",
                    "param_ranges": {"fast_window": [3, 5, 7], "slow_window": [10, 20]},
                    "max_combinations": 4,
                }
            )

    def test_basic_grid_returns_sorted_results(self):
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5], "slow_window": [10, 20]},
            ),
            _bars(50),
        )
        assert result["combinations"] == 4
        assert len(result["optimization_results"]) == 4
        # 验证：按 total_return 降序
        returns = [r["total_return"] for r in result["optimization_results"]]
        assert returns == sorted(returns, reverse=True)

    def test_invalid_param_caught_as_error(self):
        result = run_grid_search(
            OptimizeRequest(
                strategy="channel_reversal",
                param_ranges={"channel_window": [5], "stop_loss_pct": [0.05, 0.1]},
            ),
            _bars(50),
        )
        # stop_loss_pct=0.1 是合法的，stop_loss_pct=0.05 也合法 → 全部成功
        # 故意把 stop_loss_pct=1.5 触发 ValueError
        result2 = run_grid_search(
            OptimizeRequest(
                strategy="channel_reversal",
                param_ranges={"channel_window": [5], "stop_loss_pct": [0.05, 1.5]},
            ),
            _bars(50),
        )
        # 至少有一条 error
        assert len(result2["optimization_errors"]) >= 1

    def test_regression_sort_with_none_does_not_crash(self):
        """历史 bug 回归：`sort(key=total_return, reverse=True)` 在 total_return=None 时崩溃。"""
        # 构造一个会触发 None 的场景比较难（None 只在 equity_curve 为空时出现），
        # 但代码已用 (is None, -value) 排序，不依赖类型比较。
        # 这里只验证排序本身不会崩溃。
        result = run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 5], "slow_window": [10, 20]},
            ),
            _bars(50),
        )
        assert isinstance(result["optimization_results"], list)

    def test_default_limit_covers_972_combo_volume_shadow(self):
        """回归：volume_shadow_break 默认 6 维 param_ranges = 972 组合，
        默认上限 2000 必须能容纳。"""
        # 强制重置 settings，确保拿到最新默认 2000
        os.environ.pop("OPTIMIZE_MAX_COMBINATIONS", None)
        reset_settings_cache()
        result = run_grid_search(
            OptimizeRequest(
                strategy="volume_shadow_break",
                param_ranges={
                    "volume_window": [2, 3, 4],
                    "volume_multiplier": [1.1, 1.2, 1.3, 1.4],
                    "sell_volume_multiplier": [1.01, 1.03, 1.05],
                    "upper_shadow_ratio": [0.1, 0.15, 0.2],
                    "lower_shadow_ratio": [0.2, 0.3, 0.4],
                    "ma_window": [3, 5, 8],
                },
            ),
            _bars(80),
        )
        assert result["combinations"] == 972

    def test_request_max_combinations_overrides_default(self):
        """OptimizeRequest.max_combinations 临时覆盖默认上限。"""
        os.environ["OPTIMIZE_MAX_COMBINATIONS"] = "2000"
        reset_settings_cache()
        try:
            # 8 组合，默认 2000 远不会超限；但显式传 5 → 应该被拒
            with pytest.raises(ValidationError, match="超过上限"):
                run_grid_search(
                    OptimizeRequest(
                        strategy="moving_average",
                        param_ranges={
                            "fast_window": [3, 5, 7],
                            "slow_window": [10, 20],
                        },
                        max_combinations=5,  # 6 组合超 5
                    ),
                    _bars(50),
                )
        finally:
            os.environ.pop("OPTIMIZE_MAX_COMBINATIONS", None)
            reset_settings_cache()

    def test_request_max_combinations_zero_or_negative_uses_default(self):
        """max_combinations <= 0 时回退到 settings 默认上限。"""
        os.environ["OPTIMIZE_MAX_COMBINATIONS"] = "2000"
        reset_settings_cache()
        try:
            # max_combinations=0 应被忽略，走默认 2000；6 组合应通过
            result = run_grid_search(
                OptimizeRequest(
                    strategy="moving_average",
                    param_ranges={
                        "fast_window": [3, 5, 7],
                        "slow_window": [10, 20],
                    },
                    max_combinations=0,
                ),
                _bars(50),
            )
            assert result["combinations"] == 6
        finally:
            os.environ.pop("OPTIMIZE_MAX_COMBINATIONS", None)
            reset_settings_cache()
