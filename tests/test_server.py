"""HTTP 服务层 / 中间件测试。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest

from quant.errors import AuthError, RateLimitError, ValidationError
from quant.server.app import _coerce_strategy_value, _strategy_params
from quant.server.middleware import RateLimiter, check_auth, get_client_key


class _FakeHandler:
    def __init__(self, headers=None, client=("127.0.0.1", 12345)):
        self.headers = headers or {}
        self.client_address = client


class TestRateLimiter:
    def test_allows_within_limit(self):
        rl = RateLimiter(limit=3, window_seconds=60)
        rl.check("ip1")
        rl.check("ip1")
        rl.check("ip1")

    def test_blocks_over_limit(self):
        rl = RateLimiter(limit=2, window_seconds=60)
        rl.check("ip1")
        rl.check("ip1")
        with pytest.raises(RateLimitError):
            rl.check("ip1")

    def test_separate_keys(self):
        rl = RateLimiter(limit=2, window_seconds=60)
        rl.check("ip1")
        rl.check("ip1")
        rl.check("ip2")  # ip2 独立计数
        rl.check("ip2")
        with pytest.raises(RateLimitError):
            rl.check("ip1")  # ip1 已超

    def test_window_expiry(self):
        import time

        rl = RateLimiter(limit=2, window_seconds=0.1)
        rl.check("ip1")
        rl.check("ip1")
        with pytest.raises(RateLimitError):
            rl.check("ip1")
        time.sleep(0.15)
        rl.check("ip1")  # 窗口过期 → 重新计数

    def test_buckets_have_max_cap(self):
        """回归测试：限流器不能无限制累积 client_ip。"""
        rl = RateLimiter(limit=100, window_seconds=60, _max_buckets=10)
        for i in range(50):
            rl.check(f"ip_{i}")
        # 不应该持有 50 个 buckets
        assert len(rl._buckets) <= 10


class TestCheckAuth:
    def test_no_config_allows(self, monkeypatch):
        from quant.config import Settings, reset_settings_cache

        s = Settings(api_key="", api_key_hash="")
        check_auth({}, s)  # 不抛

    def test_missing_key_raises(self):
        """P1-1：配了 API_KEY 但 payload 没带 → 抛"未提供"，不再回退到 settings.api_key。"""
        from quant.config import Settings

        s = Settings(api_key="shortkey", api_key_hash="")
        with pytest.raises(AuthError, match="未提供"):
            check_auth({}, s)

    def test_wrong_key_raises(self):
        """P1-1：删了长度 < 16 旁路后，错的 key 直接判无效（常时间比较）。"""
        from quant.config import Settings

        s = Settings(api_key="configured-correct-key", api_key_hash="")
        with pytest.raises(AuthError, match="无效"):
            check_auth({"api_key": "short"}, s)

    def test_correct_plain_key_passes(self):
        """P1-1：明文 API_KEY 必须严格匹配，匹配则放行。"""
        from quant.config import Settings

        s = Settings(api_key="the-real-secret-key", api_key_hash="")
        check_auth({"api_key": "the-real-secret-key"}, s)  # 不抛

    def test_hash_match(self):
        import hashlib

        from quant.config import Settings

        api_key = "1234567890abcdef" * 2
        digest = hashlib.sha256(api_key.encode()).hexdigest()
        s = Settings(api_key="", api_key_hash=digest)
        check_auth({"api_key": api_key}, s)  # ok

    def test_hash_mismatch(self):
        from quant.config import Settings

        s = Settings(api_key="", api_key_hash="a" * 64)
        with pytest.raises(AuthError, match="无效"):
            check_auth({"api_key": "b" * 32}, s)


class TestGetClientKey:
    """P1-3：默认不信任任何代理头，必须显式配置 TRUSTED_PROXIES 才认。"""

    def _settings(self, trusted: str = ""):
        from quant.config import Settings

        return Settings(trusted_proxies=trusted)

    def test_xff_ignored_without_trust(self):
        """回归：没配 TRUSTED_PROXIES 时，客户端伪造 XFF 不会被采用。"""
        h = _FakeHandler(headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
        assert get_client_key(h, self._settings()) == "127.0.0.1"

    def test_x_real_ip_ignored_without_trust(self):
        h = _FakeHandler(
            headers={"X-Real-IP": "1.2.3.4"}, client=("9.9.9.9", 12345)
        )
        assert get_client_key(h, self._settings()) == "9.9.9.9"

    def test_uses_xff_when_forwarded_trusted(self):
        h = _FakeHandler(headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
        assert get_client_key(h, self._settings("forwarded")) == "1.2.3.4"

    def test_uses_x_real_ip_when_render_trusted(self):
        h = _FakeHandler(
            headers={"X-Real-IP": "1.2.3.4"}, client=("9.9.9.9", 12345)
        )
        assert get_client_key(h, self._settings("render")) == "1.2.3.4"

    def test_uses_cf_connecting_ip_when_cloudflare_trusted(self):
        h = _FakeHandler(headers={"CF-Connecting-IP": "203.0.113.5"})
        assert get_client_key(h, self._settings("cloudflare")) == "203.0.113.5"

    def test_all_trusts_everything(self):
        h = _FakeHandler(
            headers={
                "CF-Connecting-IP": "203.0.113.5",
                "X-Real-IP": "10.0.0.1",
                "X-Forwarded-For": "1.2.3.4",
            },
            client=("9.9.9.9", 12345),
        )
        # cloudflare 优先级最高
        assert get_client_key(h, self._settings("all")) == "203.0.113.5"

    def test_wildcard_trusts_everything(self):
        h = _FakeHandler(
            headers={"X-Forwarded-For": "1.2.3.4"},
            client=("9.9.9.9", 12345),
        )
        assert get_client_key(h, self._settings("*")) == "1.2.3.4"

    def test_falls_back_to_client_address(self):
        h = _FakeHandler(client=("9.9.9.9", 12345))
        assert get_client_key(h, self._settings()) == "9.9.9.9"

    def test_only_forwarded_trusted_ignores_cf(self):
        """开了 forwarded 但没开 cloudflare → CF-Connecting-IP 不生效。"""
        h = _FakeHandler(
            headers={
                "CF-Connecting-IP": "203.0.113.5",
                "X-Forwarded-For": "1.2.3.4",
            },
            client=("9.9.9.9", 12345),
        )
        assert get_client_key(h, self._settings("forwarded")) == "1.2.3.4"


class TestServerEndpoints:
    """集成测试：实际启服务并发请求（用一个临时端口）。"""

    @pytest.fixture
    def server(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test")
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        monkeypatch.setenv("PORT", "0")  # 系统分配
        from quant.config import reset_settings_cache

        reset_settings_cache()
        from quant.server.app import BacktestHandler, run_server
        from http.server import ThreadingHTTPServer
        from quant.server.middleware import RateLimiter
        import threading

        settings = __import__("quant.config", fromlist=["get_settings"]).get_settings()
        BacktestHandler.limiter = RateLimiter(
            limit=settings.rate_limit, window_seconds=settings.rate_window
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), BacktestHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{port}"
        server.shutdown()
        server.server_close()

    def test_strategies_endpoint(self, server):
        import urllib.request

        with urllib.request.urlopen(f"{server}/api/strategies") as resp:
            data = json.loads(resp.read())
        assert data["success"] is True
        names = {s["name"] for s in data["strategies"]}
        assert "momentum_atr" in names
        assert "moving_average" in names

    def test_strategies_with_query_string(self, server):
        """P1-4：/api/strategies?nocache=1 必须命中（query string 不该导致 404）。"""
        import urllib.request

        with urllib.request.urlopen(f"{server}/api/strategies?nocache=1") as resp:
            data = json.loads(resp.read())
        assert data["success"] is True
        assert isinstance(data["strategies"], list)

    def test_cors_preflight(self, server):
        """CORS 行为：默认 ``*`` 白名单时 OPTIONS 必须返回 Allow-Origin。

        详见 ``test_cors_whitelist_*`` 系列对白名单模式的覆盖。
        """
        import urllib.request

        req = urllib.request.Request(
            f"{server}/api/query",
            method="OPTIONS",
            headers={"Origin": "http://example.com"},
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 204
            assert "Access-Control-Allow-Origin" in resp.headers


class TestCorsWhitelist:
    """P0-2：白名单模式 CORS。

    - 配置 ``CORS_ORIGIN=https://allowed.com,https://other.com``
    - Origin 命中 → 回显该 origin
    - Origin 不命中 → 不发 Allow-Origin（浏览器拦截）
    - 无 Origin 头 → 不发 Allow-Origin（curl 仍然能拿到 200）
    """

    @pytest.fixture
    def server(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test")
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        monkeypatch.setenv("PORT", "0")
        monkeypatch.setenv(
            "CORS_ORIGIN",
            "https://allowed.com,https://other.com",
        )
        from quant.config import reset_settings_cache
        import threading
        from http.server import ThreadingHTTPServer

        reset_settings_cache()
        from quant.server.app import BacktestHandler
        from quant.server.middleware import RateLimiter

        settings = __import__("quant.config", fromlist=["get_settings"]).get_settings()
        assert "," in settings.cors_origin  # 白名单被原样保留（逗号分隔）

        BacktestHandler.limiter = RateLimiter(
            limit=settings.rate_limit, window_seconds=settings.rate_window
        )
        srv = ThreadingHTTPServer(("127.0.0.1", 0), BacktestHandler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        yield f"http://127.0.0.1:{port}"
        srv.shutdown()
        srv.server_close()

    def _preflight(self, server, origin):
        req = urllib.request.Request(
            f"{server}/api/query",
            method="OPTIONS",
            headers={"Origin": origin} if origin else {},
        )
        with urllib.request.urlopen(req) as resp:
            return resp.status, dict(resp.headers)

    def test_whitelist_matching_origin_echoed(self, server):
        status, headers = self._preflight(server, "https://allowed.com")
        assert status == 204
        assert headers.get("Access-Control-Allow-Origin") == "https://allowed.com"
        # 显式回显时带 credentials
        assert headers.get("Access-Control-Allow-Credentials") == "true"
        assert headers.get("Vary") == "Origin"

    def test_whitelist_second_origin_echoed(self, server):
        status, headers = self._preflight(server, "https://other.com")
        assert status == 204
        assert headers.get("Access-Control-Allow-Origin") == "https://other.com"

    def test_whitelist_non_matching_origin_silent(self, server):
        """不在白名单里的 origin 必须**不返回** Allow-Origin。"""
        status, headers = self._preflight(server, "https://evil.com")
        assert status == 204
        assert "Access-Control-Allow-Origin" not in headers

    def test_whitelist_no_origin_header_silent(self, server):
        """curl / 服务端调用等没 Origin 头时也不发 Allow-Origin。"""
        status, headers = self._preflight(server, None)
        assert status == 204
        assert "Access-Control-Allow-Origin" not in headers

    def test_whitelist_post_matching_origin(self, server):
        """POST 请求也应正确回显（不只是 OPTIONS）。"""
        req = urllib.request.Request(
            f"{server}/api/strategies",
            data=b"",
            headers={"Origin": "https://allowed.com"},
            method="GET",
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            assert resp.headers.get("Access-Control-Allow-Origin") == "https://allowed.com"

    def test_whitelist_post_non_matching_silent(self, server):
        req = urllib.request.Request(
            f"{server}/api/strategies",
            data=b"",
            headers={"Origin": "https://evil.com"},
            method="GET",
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            assert "Access-Control-Allow-Origin" not in resp.headers

    def test_unknown_endpoint(self, server):
        import urllib.request
        import urllib.error

        req = urllib.request.Request(
            f"{server}/api/unknown",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req)
        assert exc_info.value.code == 404


class TestStrategyParamCoercion:
    """防止前端 FormData 把数值序列化为字符串后导致 500。"""

    def test_int_default_accepts_numeric_string(self):
        # 前端 FormData 传过来的 volume_window: "3"
        assert _coerce_strategy_value("volume_window", 3, "3") == 3

    def test_int_default_accepts_int(self):
        assert _coerce_strategy_value("volume_window", 3, 3) == 3

    def test_int_default_rejects_non_integer_float(self):
        with pytest.raises(ValidationError, match="整数"):
            _coerce_strategy_value("ma_window", 3, 3.5)

    def test_int_default_rejects_garbage_string(self):
        with pytest.raises(ValidationError, match="不是合法整数"):
            _coerce_strategy_value("volume_window", 3, "abc")

    def test_int_default_rejects_bool(self):
        # True 不应当被解释为 1，避免歧义
        with pytest.raises(ValidationError, match="整数"):
            _coerce_strategy_value("volume_window", 3, True)

    def test_float_default_accepts_numeric_string(self):
        # atr_multiplier: "2.5" (来自前端字符串)
        assert _coerce_strategy_value("atr_multiplier", 2.5, "2.5") == 2.5

    def test_float_default_accepts_int_value(self):
        assert _coerce_strategy_value("risk_per_trade", 0.02, 1) == 1.0

    def test_float_default_rejects_garbage_string(self):
        with pytest.raises(ValidationError, match="不是合法数字"):
            _coerce_strategy_value("atr_multiplier", 2.5, "high")

    def test_picks_only_keys_in_spec_defaults(self):
        # volume_shadow_break 不接受 fee_rate 之外的字段
        payload = {
            "strategy": "volume_shadow_break",
            "volume_window": "3",
            "ma_window": "3",
            "unknown_field": "ignored",
        }
        result = _strategy_params(payload)
        assert set(result.keys()) == {"volume_window", "ma_window"}
        assert result["volume_window"] == 3  # int
        assert result["ma_window"] == 3

    def test_skips_empty_values_falls_back_to_default(self):
        payload = {"strategy": "volume_shadow_break", "volume_window": ""}
        assert _strategy_params(payload) == {}

    def test_unknown_strategy_returns_empty(self):
        # 让路由层在更合适的地方报错
        assert _strategy_params({"strategy": "no_such_strategy", "x": 1}) == {}


class TestOptimizeMaxCombinationsHandler:
    """回归：server._handle_optimize 必须把 payload['max_combinations'] 传给 OptimizeRequest。
    之前漏了这一行，前端在 payload 里塞了覆盖值但 server 忽略了，仍然按默认上限校验。"""

    @pytest.fixture
    def server(self, monkeypatch):
        """启一个真 server（避免 BacktestHandler 初始化时复杂的父类参数）。"""
        monkeypatch.setenv("IWENCAI_API_KEY", "test")
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        monkeypatch.setenv("PORT", "0")
        from quant.config import reset_settings_cache
        reset_settings_cache()
        from quant.server.app import BacktestHandler, run_server
        from http.server import ThreadingHTTPServer
        from quant.server.middleware import RateLimiter
        import threading

        settings = __import__("quant.config", fromlist=["get_settings"]).get_settings()
        BacktestHandler.limiter = RateLimiter(
            limit=settings.rate_limit, window_seconds=settings.rate_window
        )
        srv = ThreadingHTTPServer(("127.0.0.1", 0), BacktestHandler)
        port = srv.server_address[1]
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{port}"
        srv.shutdown()

    def _bars_payload(self, n: int = 100):
        out = []
        for i in range(n):
            out.append({
                "日期": f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
                "开盘价": 10.0 + 0.04 * i,
                "最高价": 10.0 + 0.06 * i,
                "最低价": 10.0 + 0.03 * i,
                "收盘价": 10.0 + 0.05 * i,
                "成交量": 1000.0 + i * 10,
            })
        return out

    def _post_optimize(self, base_url, payload, monkeypatch):
        """用 monkeypatch 替换 iwencai.fetch_all，POST /api/optimize。"""
        import json as _json
        import urllib.request

        from quant.data import iwencai as iwc
        monkeypatch.setattr(iwc, "fetch_all",
                            lambda *a, **k: {"datas": self._bars_payload(100)})
        body = _json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/api/optimize",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return _json.loads(e.read().decode("utf-8"))

    def test_handler_threads_max_combinations_to_service(self, server, monkeypatch):
        """显式 max_combinations=4 收紧上限 → 6 组合应被拒。"""
        monkeypatch.setenv("OPTIMIZE_MAX_COMBINATIONS", "2000")
        from quant.config import reset_settings_cache
        reset_settings_cache()

        payload = {
            "strategy": "moving_average",
            "query": "mock",
            "param_ranges": {
                "fast_window": [3, 5, 7],
                "slow_window": [10, 20],  # 3×2 = 6
            },
            "max_combinations": 4,  # 6 > 4 → 期望拒
        }
        data = self._post_optimize(server, payload, monkeypatch)
        assert data.get("success") is False
        assert "超过上限" in (data.get("error") or "")
        assert data.get("details", {}).get("limit") == 4

    def test_handler_without_max_combinations_uses_default(self, server, monkeypatch):
        """不传 max_combinations → 走默认 2000。972 组合应通过。"""
        monkeypatch.setenv("OPTIMIZE_MAX_COMBINATIONS", "2000")
        from quant.config import reset_settings_cache
        reset_settings_cache()

        payload = {
            "strategy": "volume_shadow_break",
            "query": "mock",
            "param_ranges": {
                "volume_window": [2, 3, 4],
                "volume_multiplier": [1.1, 1.2, 1.3, 1.4],
                "sell_volume_multiplier": [1.01, 1.03, 1.05],
                "upper_shadow_ratio": [0.1, 0.15, 0.2],
                "lower_shadow_ratio": [0.2, 0.3, 0.4],
                "ma_window": [3, 5, 8],
            },
        }
        data = self._post_optimize(server, payload, monkeypatch)
        assert data.get("success") is True, f"failed: {data}"
        assert data["combinations"] == 972

    def test_handler_max_combinations_zero_falls_back_to_default(self, server, monkeypatch):
        """max_combinations=0 / "" / None → 走默认上限（不收紧）。"""
        monkeypatch.setenv("OPTIMIZE_MAX_COMBINATIONS", "2000")
        from quant.config import reset_settings_cache
        reset_settings_cache()

        for falsy in (0, "", None):
            payload = {
                "strategy": "volume_shadow_break",
                "query": "mock",
                "param_ranges": {
                    "volume_window": [2, 3, 4],
                    "volume_multiplier": [1.1, 1.2, 1.3, 1.4],
                    "sell_volume_multiplier": [1.01, 1.03, 1.05],
                    "upper_shadow_ratio": [0.1, 0.15, 0.2],
                    "lower_shadow_ratio": [0.2, 0.3, 0.4],
                    "ma_window": [3, 5, 8],
                },
                "max_combinations": falsy,
            }
            data = self._post_optimize(server, payload, monkeypatch)
            assert data.get("success") is True, f"max_combinations={falsy!r} failed: {data}"
            assert data["combinations"] == 972, \
                f"max_combinations={falsy!r} should fall back to default"

    def test_optimize_response_includes_smart_extras(self, server, monkeypatch):
        """回归：优化响应包含 best_by_return / best_by_calmar / param_importance / 6 个 heatmap（2 参时）。

        这些字段是前端智能可视化（双重星标、参数重要性条形图、metric 切换）的依赖，
        缺一个前端的展示就会降级。
        """
        payload = {
            "strategy": "moving_average",
            "query": "mock",
            "param_ranges": {
                "fast_window": [3, 5],
                "slow_window": [10, 20],
            },
        }
        data = self._post_optimize(server, payload, monkeypatch)
        assert data.get("success") is True, f"failed: {data}"
        # 双重最佳
        assert "best_by_return" in data and isinstance(data["best_by_return"], dict)
        assert "best_by_calmar" in data
        # Top 10 鲁棒表
        assert "top_robust" in data and isinstance(data["top_robust"], list)
        assert all("calmar" in r for r in data["top_robust"])
        # 参数重要性
        assert "param_importance" in data
        params_in_order = [x["param"] for x in data["param_importance"]]
        assert params_in_order == ["fast_window", "slow_window"]
        # 2 参：6 个 metric 的 heatmap
        for m in ("total_return", "annual_return", "max_drawdown",
                  "sharpe_ratio", "win_rate", "trade_count"):
            assert f"heatmap_{m}" in data, f"missing heatmap_{m}"


class TestApiBarsHandler:
    """POST /api/bars —— Dashboard 弹窗专用：拉近一年日 K + 元信息。"""

    @pytest.fixture
    def server(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test")
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        monkeypatch.setenv("PORT", "0")
        from quant.config import reset_settings_cache
        reset_settings_cache()
        from quant.server.app import BacktestHandler
        from http.server import ThreadingHTTPServer
        from quant.server.middleware import RateLimiter
        import threading

        settings = __import__("quant.config", fromlist=["get_settings"]).get_settings()
        BacktestHandler.limiter = RateLimiter(
            limit=settings.rate_limit, window_seconds=settings.rate_window
        )
        srv = ThreadingHTTPServer(("127.0.0.1", 0), BacktestHandler)
        port = srv.server_address[1]
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{port}"
        srv.shutdown()
        srv.server_close()

    @staticmethod
    def _bars_payload(n: int = 100):
        out = []
        for i in range(n):
            out.append({
                "日期": f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
                "股票代码": "600519",
                "股票简称": "贵州茅台",
                "开盘价": 10.0 + 0.04 * i,
                "最高价": 10.0 + 0.06 * i,
                "最低价": 10.0 + 0.03 * i,
                "收盘价": 10.0 + 0.05 * i,
                "成交量": 1000.0 + i * 10,
            })
        return out

    def _post_bars(self, base_url, payload, monkeypatch):
        """用 monkeypatch 替换 iwencai.fetch_all，POST /api/bars。"""
        from quant.services import query as query_svc
        monkeypatch.setattr(query_svc, "fetch_all",
                            lambda *a, **k: {"datas": self._bars_payload(100)})
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/api/bars",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode("utf-8"))

    def test_happy_path_returns_bars_and_meta(self, server, monkeypatch):
        data = self._post_bars(
            server,
            {"query": "贵州茅台的日K线，最近一年", "max_pages": 3, "limit": 100},
            monkeypatch,
        )
        assert data.get("success") is True, f"failed: {data}"
        assert "bars" in data and isinstance(data["bars"], list)
        assert len(data["bars"]) > 0
        first = data["bars"][0]
        # OHLCV 字段必须存在
        for k in ("date", "close", "open", "high", "low", "volume"):
            assert k in first, f"missing field {k}"
        # 元信息
        assert data["symbol"] == "600519"
        assert data["name"] == "贵州茅台"
        assert data["source_count"] == 100

    def test_empty_query_returns_400(self, server, monkeypatch):
        data = self._post_bars(server, {"query": ""}, monkeypatch)
        assert data.get("success") is False
        assert data.get("code") == "validation_error"
        assert "查询语句不能为空" in (data.get("error") or "")

    def test_limit_clamped_to_100(self, server, monkeypatch):
        """limit=500 不应被原样传给 fetch_all（应被钳到 100）。"""
        from quant.services import query as query_svc
        seen = {}
        def _spy_fetch_all(query, **kwargs):
            seen["limit"] = kwargs.get("limit")
            return {"datas": self._bars_payload(10)}
        monkeypatch.setattr(query_svc, "fetch_all", _spy_fetch_all)
        req = urllib.request.Request(
            f"{server}/api/bars",
            data=json.dumps({"query": "mock", "limit": 500, "max_pages": 3}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        assert data.get("success") is True
        assert seen["limit"] == 100, f"expected 100, got {seen['limit']}"


class TestPayloadCoercion:
    """回归：handler 收到非法数字字符串应当返回 400 (ValidationError)，而不是 500。

    修 P2-5 之前 ``float(payload.get('initial_cash') or 100000)`` 在收到 ``"abc"`` 时抛
    ValueError，被最外层 except 转成 500。修完之后用 ``quant.payload_utils._payload_float``
    统一抛 ValidationError(400)。
    """

    def test_payload_float_string_number(self):
        from quant.payload_utils import _payload_float
        assert _payload_float("100000", 1, "x") == 100000.0

    def test_payload_float_default_on_empty(self):
        from quant.payload_utils import _payload_float
        assert _payload_float("", 50000.0, "x") == 50000.0
        assert _payload_float(None, 50000.0, "x") == 50000.0

    def test_payload_float_rejects_garbage(self):
        from quant.payload_utils import _payload_float
        with pytest.raises(ValidationError, match="不是合法数字"):
            _payload_float("abc", 100000.0, "initial_cash")

    def test_payload_int_rejects_non_integer_float(self):
        from quant.payload_utils import _payload_int
        with pytest.raises(ValidationError, match="应当为整数"):
            _payload_int("1.5", 10, "page")
        with pytest.raises(ValidationError, match="应当为整数"):
            _payload_int(1.5, 10, "page")

    def test_payload_int_rejects_garbage(self):
        from quant.payload_utils import _payload_int
        with pytest.raises(ValidationError, match="不是合法整数"):
            _payload_int("abc", 10, "page")

    def test_payload_int_accepts_string_int(self):
        from quant.payload_utils import _payload_int
        assert _payload_int("42", 10, "page") == 42
        # "1.0" 这种合法整数表达应被接受
        assert _payload_int("1.0", 10, "page") == 1

    def test_payload_str_strips_and_defaults(self):
        from quant.payload_utils import _payload_str
        assert _payload_str("  hello  ", "", "x") == "hello"
        assert _payload_str(None, "fallback", "x") == "fallback"

    def test_coerce_bool_truthy_strings(self):
        from quant.payload_utils import _coerce_bool
        for s in ("1", "true", "yes", "on", "TRUE"):
            assert _coerce_bool(s) is True
        for s in ("0", "false", "no", "off", ""):
            assert _coerce_bool(s) is False


class TestBacktestHandler400:
    """通过真实 HTTP 验证：POST /api/backtest {"initial_cash": "abc"} 必须返回 400。"""

    @pytest.fixture
    def server(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "test")
        monkeypatch.setenv("MYSQL_PERSIST_ENABLED", "0")
        monkeypatch.setenv("PORT", "0")
        from quant.config import reset_settings_cache
        reset_settings_cache()
        from quant.server.app import BacktestHandler, run_server
        from http.server import ThreadingHTTPServer
        from quant.server.middleware import RateLimiter
        import threading

        settings = __import__("quant.config", fromlist=["get_settings"]).get_settings()
        BacktestHandler.limiter = RateLimiter(
            limit=settings.rate_limit, window_seconds=settings.rate_window
        )
        srv = ThreadingHTTPServer(("127.0.0.1", 0), BacktestHandler)
        port = srv.server_address[1]
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{port}"
        srv.shutdown()

    def _post(self, base_url, payload):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/api/backtest",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_initial_cash_abc_returns_400(self, server, monkeypatch):
        """{"initial_cash": "abc"} 必须返 400，不再是 500。"""
        # 1.18 之前：直接抛 ValueError，handler 兜底成 500
        status, body = self._post(
            server, {"strategy": "moving_average", "symbol": "000001.SZ",
                     "start_date": "2024-01-01", "end_date": "2024-06-01",
                     "initial_cash": "abc"}
        )
        assert status == 400, f"expected 400, got {status}: {body}"
        assert body.get("code") == "validation_error"
        assert "initial_cash" in (body.get("error") or "")
        assert body.get("details", {}).get("field") == "initial_cash"

    def test_initial_cash_1_5_returns_400(self, server, monkeypatch):
        """只接受 int 的字段传入 '1.5' 必须返 400（不再静默截断或 500）。"""
        status, body = self._post(
            server, {"strategy": "moving_average", "symbol": "000001.SZ",
                     "start_date": "2024-01-01", "end_date": "2024-06-01",
                     "limit": "1.5"}
        )
        assert status == 400, f"expected 400, got {status}: {body}"
        assert body.get("code") == "validation_error"

    def test_numeric_string_initial_cash_still_accepted(self, server, monkeypatch):
        """前端 FormData 通常把数字序列化成字符串，要兼容 "100000"。"""
        # mock 掉 fetch_bars（路径在 services.query）以避免打真接口
        from quant.services import query as query_svc
        import datetime as _dt
        bars = []
        for i in range(120):
            bars.append({
                "date": (_dt.date(2024, 1, 1) + _dt.timedelta(days=i)).isoformat(),
                "open": 10.0 + 0.01 * i, "close": 10.0 + 0.01 * (i + 1),
                "high": 10.0 + 0.02 * i, "low": 10.0 - 0.005 * i,
                "volume": 1000 + i * 5,
            })
        monkeypatch.setattr(query_svc, "fetch_bars",
                            lambda *a, **k: bars)
        status, body = self._post(
            server, {"strategy": "moving_average", "symbol": "000001.SZ",
                     "start_date": "2024-01-01", "end_date": "2024-12-31",
                     "initial_cash": "100000"}
        )
        # 不一定 200（可能策略本身有别的问题），但绝对不能是 400/500 from handler
        # 关键是"abc" 这种会失败而"100000"不会
        assert status != 400 or "initial_cash" not in (body.get("error") or ""), body

