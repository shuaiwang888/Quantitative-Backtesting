"""AI 复盘分析服务。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.llm import LLMError, analyze_backtest as _llm_analyze
from quant.errors import UpstreamError


def analyze(payload: Dict[str, Any]) -> str:
    """根据回测结果调用大模型生成中文策略复盘。

    ``payload`` 里可以带 ``minimax_api_key``（访客在浏览器里填入的），
    优先级高于 Settings / 环境变量。这样公开部署时 owner 不用暴露自己的 key。
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
        raise UpstreamError(str(exc), details={"upstream": "minimax"}) from exc


__all__ = ["analyze"]
