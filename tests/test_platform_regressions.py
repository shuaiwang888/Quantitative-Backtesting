"""线上排查发现的请求、取数和自定义策略回归。"""
import io
import json
from unittest.mock import Mock

import pytest

from quant.data import iwencai
from quant.errors import ValidationError
from quant.server.app import _strategy_params, _normalize_request_credentials
from quant.config import Settings
from quant.strategies import run_backtest


@pytest.mark.parametrize("response", [[], None, "wrong", {"success": False}, {"success": "false"}])
def test_malformed_or_failed_upstream_is_not_success(monkeypatch, response):
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **kw: io.BytesIO(json.dumps(response).encode()))
    with pytest.raises(iwencai.IwencaiError):
        iwencai.query("mock", api_key="visitor")


def test_zero_count_does_not_truncate_history(monkeypatch):
    responses = iter([
        {"datas": [{"date": "2024-01-01"}], "code_count": 0},
        {"datas": [{"date": "2024-01-02"}], "code_count": 0},
        {"datas": []},
    ])
    monkeypatch.setattr(iwencai, "query", lambda *a, **kw: next(responses))
    assert len(iwencai.fetch_all("mock")["datas"]) == 2


@pytest.mark.parametrize("raw", ["nan", "inf", True, -float("inf")])
def test_strategy_floats_reject_nonfinite_and_bool(raw):
    with pytest.raises(ValidationError):
        _strategy_params({"strategy": "momentum_atr", "atr_multiplier": raw})


@pytest.mark.parametrize("field", ["iwencai_api_key", "api_key", "minimax_api_key"])
def test_invalid_credential_type_is_validation_error(field):
    with pytest.raises(ValidationError):
        _normalize_request_credentials({field: {"bad": "shape"}}, Settings(), {})


def test_invalid_strategy_rejected_before_upstream_request(monkeypatch):
    import importlib
    service = importlib.import_module("quant.services.backtest")
    fetch = Mock()
    monkeypatch.setattr(service, "fetch_all", fetch)
    with pytest.raises(ValidationError, match="策略参数"):
        service.run_single_backtest(service.BacktestRequest(
            strategy="moving_average", query="mock",
            strategy_params={"fast_window": 20, "slow_window": 5},
        ))
    fetch.assert_not_called()


def test_custom_short_windows_accept_short_history(sample_bars):
    result = run_backtest("moving_average", sample_bars[:10], fast_window=2, slow_window=5)
    assert result["summary"]["bar_count"] == 10


def test_custom_long_window_requires_enough_history(sample_bars):
    with pytest.raises(ValidationError, match="151"):
        run_backtest("moving_average", sample_bars, fast_window=5, slow_window=150)


def test_invalid_momentum_risk_is_rejected(sample_bars):
    with pytest.raises(ValidationError, match="单笔风险"):
        run_backtest("momentum_atr", sample_bars, risk_per_trade=-0.1)
