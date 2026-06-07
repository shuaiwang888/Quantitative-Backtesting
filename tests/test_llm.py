"""LLM 客户端 / 配置校验测试。"""

from __future__ import annotations

import socket
import urllib.error

import pytest

from quant.config import Settings, reset_settings_cache
from quant.data.llm import LLMError, analyze_backtest


class _FakeResponse:
    def __init__(self, body: str = "{}"):
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeHTTPError(urllib.error.HTTPError):
    def __init__(self, code: int = 404, body: str = "not found"):
        super().__init__(
            url="https://example.com/v1/messages",
            code=code,
            msg="err",
            hdrs={},  # type: ignore[arg-type]
            fp=None,
        )
        self._body = body.encode("utf-8")

    def read(self) -> bytes:  # type: ignore[override]
        return self._body


class TestLLMErrorHandling:
    def test_http_error_wrapped(self, monkeypatch):
        """4xx/5xx 响应应该转成 LLMError，不让 500 漏到上层。"""

        def _fake_urlopen(req, timeout=0):  # noqa: ARG001
            raise _FakeHTTPError(404, "404 page not found")

        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        monkeypatch.setenv("MINIMAX_MODEL", "MiniMax-M2.7")
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

        with pytest.raises(LLMError, match="404"):
            analyze_backtest({"summary": {}, "trades": [], "bars": []}, timeout=10)

    def test_timeout_wrapped(self, monkeypatch):
        """socket.timeout 必须被捕获并转成 LLMError，不能 500。"""

        def _fake_urlopen(req, timeout=0):  # noqa: ARG001
            raise socket.timeout("read timed out")

        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

        with pytest.raises(LLMError, match="超时"):
            analyze_backtest({"summary": {}, "trades": [], "bars": []}, timeout=1)

    def test_timeout_error_wrapped(self, monkeypatch):
        """Python 3.10+ 的 TimeoutError 也要被捕获。"""

        def _fake_urlopen(req, timeout=0):  # noqa: ARG001
            raise TimeoutError("timed out")

        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

        with pytest.raises(LLMError, match="超时"):
            analyze_backtest({"summary": {}, "trades": [], "bars": []}, timeout=1)

    def test_url_error_wrapped(self, monkeypatch):
        """DNS 失败 / 连接拒绝应该返回明确的网络错误。"""

        def _fake_urlopen(req, timeout=0):  # noqa: ARG001
            raise urllib.error.URLError("Name or service not known")

        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

        with pytest.raises(LLMError, match="网络错误"):
            analyze_backtest({"summary": {}, "trades": [], "bars": []}, timeout=1)

    def test_missing_api_key_raises(self, monkeypatch):
        monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
        with pytest.raises(LLMError, match="MINIMAX_API_KEY"):
            analyze_backtest({"summary": {}}, api_key="")

    def test_successful_response_extracted(self, monkeypatch):
        body = '{"content":[{"type":"text","text":"分析结论"}]}'

        def _fake_urlopen(req, timeout=0):  # noqa: ARG001
            return _FakeResponse(body)

        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

        result = analyze_backtest({"summary": {}, "trades": [], "bars": []})
        assert result == "分析结论"


class TestLLMConfigValidation:
    def test_openai_url_rejected(self, monkeypatch):
        """OpenAI 兼容 URL 必须显式拒绝（客户端只支持 Anthropic 协议）。"""
        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1")
        reset_settings_cache()
        with pytest.raises(RuntimeError, match="Anthropic 兼容"):
            Settings()
        reset_settings_cache()

    def test_anthropic_url_accepted(self, monkeypatch):
        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
        reset_settings_cache()
        s = Settings()
        assert s.minimax_base_url.endswith("/anthropic")
        reset_settings_cache()

    def test_anthropic_v1_url_accepted(self, monkeypatch):
        """允许 base url 末尾带 /v1，客户端实现会再拼 /v1/messages。"""
        monkeypatch.setenv("MINIMAX_API_KEY", "fake-key")
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic/v1")
        reset_settings_cache()
        s = Settings()
        assert s.minimax_base_url.endswith("/anthropic/v1")
        reset_settings_cache()

    def test_disabled_llm_skips_validation(self, monkeypatch):
        """没配 API key 时不应校验 URL。"""
        monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
        monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1")
        reset_settings_cache()
        s = Settings()  # 不应抛错
        assert s.minimax_api_key == ""
        reset_settings_cache()

    def test_default_timeout_is_180(self, monkeypatch):
        """默认超时应该足够长，避免 M3 thinking 模式超时。"""
        monkeypatch.delenv("MINIMAX_TIMEOUT", raising=False)
        reset_settings_cache()
        s = Settings()
        assert s.minimax_timeout == 180
        reset_settings_cache()
