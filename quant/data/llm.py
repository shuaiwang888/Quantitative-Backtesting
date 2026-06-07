"""LLM 分析：调用 MiniMax 的 Anthropic 兼容接口。"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic"
DEFAULT_MODEL = "MiniMax-M2.7"


class LLMError(Exception):
    """LLM 接口错误。"""


def analyze_backtest(
    payload: Dict[str, Any],
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    timeout: int = 60,
    max_tokens: int = 4096,
) -> str:
    """根据回测结果生成中文策略复盘文本。"""
    resolved_key = api_key or os.environ.get("MINIMAX_API_KEY", "")
    if not resolved_key:
        raise LLMError("MINIMAX_API_KEY 未设置，无法生成大模型分析")

    resolved_base = (base_url or os.environ.get("MINIMAX_BASE_URL", DEFAULT_BASE_URL)).rstrip("/")
    resolved_model = model or os.environ.get("MINIMAX_MODEL", DEFAULT_MODEL)
    url = f"{resolved_base}/v1/messages"

    request_payload = {
        "model": resolved_model,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "system": (
            "你是一名严谨的量化策略研究员。请基于用户提供的回测数据做复盘分析，"
            "不要承诺收益，不要给出确定性投资建议。输出中文，结构清晰，重点关注策略逻辑、"
            "收益来源、风险、交易质量、参数问题和下一步优化建议。"
        ),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _build_prompt(payload)},
                ],
            }
        ],
    }

    request = urllib.request.Request(
        url,
        data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": resolved_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            data = json.loads(body)
            return _extract_text(data)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8") if exc.fp else ""
        raise LLMError(f"大模型接口错误 {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        # 包含 DNS / 连接拒绝 / 超时（reason 可能是 socket.timeout）
        raise LLMError(f"大模型网络错误: {exc.reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        # M3 thinking 模式 + 大 payload 容易超出默认 60s
        raise LLMError(
            f"大模型响应超时（>{timeout}s），可调大 MINIMAX_TIMEOUT 或减小 prompt 体积"
        ) from exc
    except json.JSONDecodeError as exc:
        raise LLMError(f"大模型返回解析失败: {exc}") from exc


def _build_prompt(payload: Dict[str, Any]) -> str:
    summary = payload.get("summary", {})
    trades = payload.get("trades", [])
    bars = payload.get("bars", [])
    equity_curve = payload.get("equity_curve", [])
    strategy = payload.get("strategy") or summary.get("strategy", "")
    query = payload.get("query", "")

    compact = {
        "query": query,
        "strategy": strategy,
        "summary": summary,
        "trades": trades[:30] if isinstance(trades, list) else [],
        "recent_bars": _tail(bars, 80),
        "recent_equity_curve": _tail(equity_curve, 80),
    }
    return (
        "请分析下面这次股票量化回测。\n\n"
        "请按以下结构输出：\n"
        "1. 一句话结论\n"
        "2. 回测表现解读\n"
        "3. 买卖点质量分析\n"
        "4. 风险与回撤分析\n"
        "5. 策略是否适合当前标的走势\n"
        "6. 可执行优化建议\n"
        "7. 风险提示\n\n"
        "要求：每个部分控制在 2-5 条要点内，总体简洁完整，不要输出过长表格。\n\n"
        f"回测数据 JSON：\n{json.dumps(compact, ensure_ascii=False)}"
    )


def _tail(items: Any, limit: int) -> List[Any]:
    if not isinstance(items, list):
        return []
    return items[-limit:]


def _extract_text(data: Dict[str, Any]) -> str:
    blocks = data.get("content", [])
    texts: List[str] = []
    if isinstance(blocks, list):
        for block in blocks:
            if isinstance(block, dict):
                if block.get("type") == "text" or "text" in block:
                    value = block.get("text", "")
                    if value:
                        texts.append(str(value))
    if texts:
        return "\n".join(texts).strip()
    # Fallback：避免把原始 JSON 暴露给用户
    return "（大模型未返回可用文本，请稍后重试）"


__all__ = ["LLMError", "analyze_backtest"]
