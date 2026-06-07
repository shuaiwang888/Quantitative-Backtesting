"""AI 复盘分析服务。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.llm import LLMError, analyze_backtest as _llm_analyze
from quant.errors import UpstreamError


def analyze(payload: Dict[str, Any]) -> str:
    """根据回测结果调用大模型生成中文策略复盘。"""
    settings = get_settings()
    try:
        return _llm_analyze(
            payload,
            timeout=settings.minimax_timeout,
            max_tokens=settings.minimax_max_tokens,
        )
    except LLMError as exc:
        raise UpstreamError(str(exc), details={"upstream": "minimax"}) from exc


__all__ = ["analyze"]
