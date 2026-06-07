"""HTTP 服务层 / 中间件测试。"""

from __future__ import annotations

import json

import pytest

from quant.errors import AuthError, RateLimitError
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
        from quant.config import Settings

        # api_key 已配置但 payload 没带 → 走 settings.api_key
        # 用长度 < 16 的 key 触发"无效"
        s = Settings(api_key="shortkey", api_key_hash="")
        with pytest.raises(AuthError, match="无效"):
            check_auth({}, s)

    def test_too_short_key_raises(self):
        from quant.config import Settings

        s = Settings(api_key="configured", api_key_hash="")
        with pytest.raises(AuthError, match="无效"):
            check_auth({"api_key": "short"}, s)

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
    def test_uses_xff(self):
        h = _FakeHandler(headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
        assert get_client_key(h) == "1.2.3.4"

    def test_uses_x_real_ip(self):
        h = _FakeHandler(
            headers={"X-Real-IP": "1.2.3.4"}, client=("9.9.9.9", 12345)
        )
        assert get_client_key(h) == "1.2.3.4"

    def test_falls_back_to_client_address(self):
        h = _FakeHandler(client=("9.9.9.9", 12345))
        assert get_client_key(h) == "9.9.9.9"


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

    def test_cors_preflight(self, server):
        import urllib.request

        req = urllib.request.Request(
            f"{server}/api/query",
            method="OPTIONS",
            headers={"Origin": "http://example.com"},
        )
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 204
            assert "Access-Control-Allow-Origin" in resp.headers

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
