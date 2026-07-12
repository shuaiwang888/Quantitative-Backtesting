"""AI 复盘分析服务。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.llm import LLMError, analyze_backtest as _llm_analyze
from quant.errors import UpstreamError
from quant.logging_setup import get_logger


_LOG = get_logger("services.analyze")

# 对外只暴露前 N 个字符，剩下的去日志里查；防止上游 body / URL / 凭据泄漏。
_MAX_SAFE_MESSAGE = 100


def _sanitize_message(raw: str, limit: int = _MAX_SAFE_MESSAGE) -> str:
    text = (raw or "").strip() or "大模型服务异常"
    if len(text) <= limit:
        return text
    return text[:limit] + "…（详见服务端日志）"


def analyze(payload: Dict[str, Any]) -> str:
    """根据回测结果调用大模型生成中文策略复盘。

    ``payload`` 里可以带 ``minimax_api_key``（访客在浏览器里填入的），
    优先级高于 Settings / 环境变量。这样公开部署时 owner 不用暴露自己的 key。

    错误处理：``LLMError`` 不会再把原始上游响应（可能含 body / URL / 凭据）
    直接回给前端 —— 截断到 ``_MAX_SAFE_MESSAGE`` 字符并提示 "see logs"。
    """
    settings = get_settings()
    visitor_key = payload.get("minimax_api_key") if isinstance(payload, dict) else None
    try:
        return _llm_analyze(
            payload,
            api_key=visitor_key or None,
            timeout=settings.minimax_timeout,
            max_tokens=settings.minimax_max_tokens,
        )
    except LLMError as exc:
        # 原始 message 可能含敏感上下文：入日志，前端只看到 sanitize 后的简短文案
        _LOG.warning("LLM 复盘失败: %s", exc.message, exc_info=exc)
        raise UpstreamError(
            _sanitize_message(exc.message),
            details={"upstream": "minimax"},
        ) from exc


__all__ = ["analyze"]
