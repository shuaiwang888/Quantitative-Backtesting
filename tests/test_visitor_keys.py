"""访客自带 API key 流程：analyze / iwencai / app.py 启动兼容。"""

from __future__ import annotations

import importlib
import sys
from unittest.mock import patch

import pytest


# ---------- analyze: per-request MINIMAX_API_KEY ----------


class TestAnalyzeAcceptsVisitorKey:
    """访客在浏览器填 MiniMax key → payload['minimax_api_key'] → 后端用之。"""

    @staticmethod
    def _analyze_module():
        # 用 importlib 绕开 quant.services.__init__ 把 "analyze" 绑成函数的问题
        import importlib
        return importlib.import_module("quant.services.analyze")

    def test_visitor_key_passed_to_llm(self, monkeypatch):
        """payload['minimax_api_key'] 应透传给 LLM client 的 api_key。"""
        analyze_mod = self._analyze_module()
        captured = {}

        def fake_llm(payload, **kwargs):
            captured["api_key"] = kwargs.get("api_key")
            return "分析文本"

        monkeypatch.setattr(analyze_mod, "_llm_analyze", fake_llm)
        result = analyze_mod.analyze({
            "minimax_api_key": "visitor-key-1234567890",
            "summary": {"strategy": "test"},
        })
        assert result == "分析文本"
        assert captured["api_key"] == "visitor-key-1234567890"

    def test_visitor_key_none_falls_back_to_settings(self, monkeypatch):
        """payload 没带 key 时，api_key 参数传 None（让 llm 走环境变量 / Settings）。"""
        analyze_mod = self._analyze_module()
        captured = {}

        def fake_llm(payload, **kwargs):
            captured["api_key"] = kwargs.get("api_key")
            return "ok"

        monkeypatch.setattr(analyze_mod, "_llm_analyze", fake_llm)
        analyze_mod.analyze({"summary": {"strategy": "test"}})
        assert captured["api_key"] is None

    def test_non_dict_payload_does_not_crash(self, monkeypatch):
        """payload 不是 dict 时（理论不该发生，但防御性写）也能跑。"""
        analyze_mod = self._analyze_module()
        captured = {}

        def fake_llm(payload, **kwargs):
            captured["payload"] = payload
            return "ok"

        monkeypatch.setattr(analyze_mod, "_llm_analyze", fake_llm)
        # 不应抛 AttributeError
        analyze_mod.analyze("not a dict")  # type: ignore[arg-type]
        assert captured["payload"] == "not a dict"


# ---------- app.py: 缺失 IWENCAI_API_KEY 时不再硬退 ----------


class TestAppMainToleratesMissingKey:
    """公开部署时 IWENCAI_API_KEY 可不配；app.main 不应 return 1。"""

    def test_missing_iwencai_key_does_not_exit(self, monkeypatch, capsys):
        # 把 _load_dotenv patch 成空操作，模拟"没有任何 .env / 环境变量"
        monkeypatch.setenv("IWENCAI_API_KEY", "")  # 让 settings 一定拿不到
        # 但 .env 文件存在时会重新填；所以 patch _load_dotenv
        sys.modules.pop("app", None)
        import app as app_mod
        monkeypatch.setattr(app_mod, "_load_dotenv", lambda: None)

        from quant.config import reset_settings_cache
        reset_settings_cache()

        called = {}
        def fake_run_server():
            called["run"] = True
        monkeypatch.setattr("quant.server.run_server", fake_run_server)

        rc = app_mod.main()
        assert rc == 0, f"main() should not exit when key missing, got rc={rc}"
        assert called["run"] is True
        captured = capsys.readouterr()
        assert "提示" in captured.err, f"expected 提示 in stderr, got: {captured.err!r}"
        assert "IWENCAI_API_KEY" in captured.err

    def test_existing_iwencai_key_still_works(self, monkeypatch):
        """有 key 时也正常启动（向后兼容）。"""
        monkeypatch.setenv("IWENCAI_API_KEY", "existing-key")
        sys.modules.pop("app", None)
        import app as app_mod
        monkeypatch.setattr(app_mod, "_load_dotenv", lambda: None)
        from quant.config import reset_settings_cache
        reset_settings_cache()

        called = {}
        def fake_run_server():
            called["run"] = True
        monkeypatch.setattr("quant.server.run_server", fake_run_server)

        rc = app_mod.main()
        assert rc == 0
        assert called["run"] is True


# ---------- iwencai: 已存在的 per-request key 流程不变（烟雾测试） ----------


class TestIwencaiVisitorKeyPassthrough:
    """iwencai.fetch_all 已经支持 per-request api_key；这里只验证一下流程不破。"""

    def test_explicit_key_overrides_env(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "from-env")
        from quant.config import reset_settings_cache
        reset_settings_cache()

        captured = {}

        def fake_urlopen(req, **kwargs):
            captured["auth"] = req.headers.get("Authorization")
            import io
            import json as _json
            return io.BytesIO(_json.dumps({"datas": []}).encode("utf-8"))

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
        from quant.data.iwencai import fetch_all
        # 用一个明确的 key，应当用之而不是 env 的
        fetch_all("mock", api_key="visitor-key")

        assert captured["auth"] == "Bearer visitor-key"


# ---------- Settings: IWENCAI_API_KEY 改为可选 ----------


class TestSettingsIwencaiOptional:
    """公开部署场景：Settings() 不能因为 IWENCAI_API_KEY 缺失而崩溃。"""

    def test_settings_constructs_with_empty_key(self, monkeypatch):
        monkeypatch.delenv("IWENCAI_API_KEY", raising=False)
        monkeypatch.setenv("IWENCAI_API_KEY", "")
        from quant.config import Settings, reset_settings_cache
        reset_settings_cache()
        # 不应抛 RuntimeError
        s = Settings()
        assert s.iwencai_api_key == ""

    def test_safe_summary_shows_visitor_when_empty(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "")
        from quant.config import Settings, reset_settings_cache
        reset_settings_cache()
        s = Settings()
        summary = s.safe_summary()
        assert "iwencai=visitor" in summary

    def test_safe_summary_shows_owner_when_set(self, monkeypatch):
        monkeypatch.setenv("IWENCAI_API_KEY", "owner-key-1234567890")
        from quant.config import Settings, reset_settings_cache
        reset_settings_cache()
        s = Settings()
        summary = s.safe_summary()
        assert "iwencai=owner" in summary
        # 摘要不能泄露 key
        assert "owner-key-1234567890" not in summary

    def test_get_settings_does_not_raise_on_empty_key(self, monkeypatch):
        """回归：之前的 bug——get_settings() 会抛 RuntimeError 阻断 server 启动。"""
        monkeypatch.setenv("IWENCAI_API_KEY", "")
        from quant.config import reset_settings_cache
        reset_settings_cache()
        # 应能成功构造
        from quant.config import get_settings
        s = get_settings()
        assert s.iwencai_api_key == ""

    def test_iwencai_call_without_any_key_raises_friendly_error(self, monkeypatch):
        """env 空 + 没传 visitor key → 抛 IwencaiError 提示前端引导用户配 key。"""
        monkeypatch.setenv("IWENCAI_API_KEY", "")
        from quant.config import reset_settings_cache
        reset_settings_cache()

        from quant.data.iwencai import fetch_all
        from quant.data.iwencai import IwencaiError
        with pytest.raises(IwencaiError, match="API 密钥未设置"):
            fetch_all("mock")