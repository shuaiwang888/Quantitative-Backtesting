"""跨层健壮性回归测试。"""

from __future__ import annotations

import json
import math
import threading
import urllib.error
import urllib.request

import pytest

from quant.config import Settings
from quant.data.normalization import Bar, normalize_bars
from quant.errors import AuthError, ValidationError
from quant.payload_utils import _payload_float, _payload_int
from quant.server.app import (
    BacktestHandler,
    BacktestHTTPServer,
    _normalize_request_credentials,
    _strategy_params,
)
from quant.server.middleware import RateLimiter, check_auth
from quant.services.batch import summarize_batch
from quant.services.optimize import OptimizeRequest, run_grid_search
from quant.services.validation import validate_single_series


def _post(url: str, payload: dict) -> tuple[int, dict, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read()), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read()), dict(exc.headers)


@pytest.fixture
def hardened_server(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT", "1")
    monkeypatch.setenv("RATE_WINDOW", "60")
    from quant.config import get_settings, reset_settings_cache

    reset_settings_cache()
    settings = get_settings()
    previous = BacktestHandler.limiter
    BacktestHandler.limiter = RateLimiter(limit=1, window_seconds=60)
    server = BacktestHTTPServer(("127.0.0.1", 0), BacktestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", settings
    server.shutdown()
    server.server_close()
    BacktestHandler.limiter = previous


def test_rate_limit_returns_json_429(hardened_server):
    base, _ = hardened_server
    first_status, _, _ = _post(f"{base}/api/unknown", {})
    assert first_status == 404
    status, body, headers = _post(f"{base}/api/unknown", {})
    assert status == 429
    assert body["code"] == "rate_limited"
    assert headers["Retry-After"] == "60"


def test_health_and_security_headers(hardened_server):
    base, _ = hardened_server
    with urllib.request.urlopen(f"{base}/api/health", timeout=5) as response:
        body = json.loads(response.read())
        assert body == {"success": True, "status": "ok"}
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"


def test_auth_accepts_dedicated_header_and_separates_upstream_key():
    settings = Settings(api_key="site-secret")
    headers = {"X-API-Key": "site-secret"}
    check_auth({"api_key": "iwencai-secret"}, settings, headers)
    normalized = _normalize_request_credentials(
        {"api_key": "iwencai-secret"}, settings, headers
    )
    assert normalized["api_key"] == "iwencai-secret"


def test_legacy_auth_key_is_not_forwarded_upstream():
    settings = Settings(api_key="site-secret")
    payload = {"api_key": "site-secret"}
    check_auth(payload, settings)
    assert "api_key" not in _normalize_request_credentials(payload, settings, {})


def test_strategy_params_accept_nested_frontend_shape():
    params = _strategy_params(
        {
            "strategy": "moving_average",
            "strategy_params": {"fast_window": "3", "slow_window": "12"},
        }
    )
    assert params == {"fast_window": 3, "slow_window": 12}


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", math.nan, math.inf])
def test_non_finite_payload_numbers_rejected(value):
    with pytest.raises(ValidationError, match="有限"):
        _payload_float(value, 1.0, "amount")
    with pytest.raises(ValidationError):
        _payload_int(value, 1, "count")


def test_even_batch_median_is_average_of_middle_values():
    rows = [{"total_return": 0.1}, {"total_return": 0.3}]
    assert summarize_batch(rows, [])["median_return"] == 0.2


def test_multiple_symbols_cannot_be_backtested_as_one_series():
    bars = [
        Bar(date="2024-01-01", close=10, code="AAA"),
        Bar(date="2024-01-01", close=20, code="BBB"),
    ]
    with pytest.raises(ValidationError, match="多个证券"):
        validate_single_series(bars)


def test_invalid_ohlc_rows_are_discarded():
    rows = [
        {"交易日期": "bad-date", "收盘价": 10},
        {"交易日期": "2024-01-01", "开盘价": 10, "最高价": 8, "收盘价": 9},
        {"交易日期": "2024-01-02", "开盘价": 10, "最高价": 11, "最低价": 9, "收盘价": 10.5},
    ]
    bars = normalize_bars(rows)
    assert len(bars) == 1
    assert bars[0].date == "2024-01-02"


def test_request_cannot_raise_optimizer_server_limit(monkeypatch, sample_bars):
    monkeypatch.setenv("OPTIMIZE_MAX_COMBINATIONS", "5")
    from quant.config import reset_settings_cache

    reset_settings_cache()
    with pytest.raises(ValidationError, match="超过上限"):
        run_grid_search(
            OptimizeRequest(
                strategy="moving_average",
                param_ranges={"fast_window": [3, 4, 5], "slow_window": [10, 20]},
                max_combinations=99999,
            ),
            sample_bars,
        )
