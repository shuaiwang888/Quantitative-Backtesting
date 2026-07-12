"""统一 JSON 响应构造。

CORS 策略：
- ``cors_origin`` 现在是一个**白名单**，可以是单个 origin（"https://x.com"），
  也可以是逗号/空白分隔的多个 origin（"https://a.com,https://b.com"）。
- 收到请求时读 ``Origin`` 头：
    - 在白名单里 → 回显该 origin（带 Vary: Origin，支持 credentials）
    - 不在白名单里 → 不返回 Allow-Origin（浏览器 CORS 拦截）
    - 没有 Origin 头（curl / server-to-server） → 不返回 Allow-Origin，但仍工作
- 解析白名单时按 "," 或空白分隔；空白条目忽略。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, Optional


def _parse_whitelist(raw: str) -> set:
    """把 ``"https://a.com, https://b.com"`` 拆成集合，自动去空白 + 去重。"""
    if not raw:
        return set()
    parts = [p.strip() for p in raw.replace("\n", ",").split(",")]
    return {p for p in parts if p}


def _resolve_allowed_origin(
    whitelist: Iterable[str],
    request_origin: Optional[str],
) -> Optional[str]:
    """根据白名单 + 请求 Origin 头决定回显哪个值。

    - ``whitelist`` 含 ``"*"`` → 全部放行，回显 ``"*"``（不带 credentials，遵循 CORS 规范）
    - ``request_origin`` 为空（curl） → 返回 None（不发 Allow-Origin）
    - ``request_origin`` 在白名单里 → 返回 request_origin（回显，带 credentials）
    - 否则 → 返回 None（拒绝）
    """
    allowed = {o.strip() for o in whitelist if o and o.strip()}
    if "*" in allowed:
        return "*"
    if not request_origin:
        return None
    if request_origin in allowed:
        return request_origin
    return None


def _send_cors_headers(handler, allowed_origin: Optional[str]) -> None:
    """发送 CORS 相关头。``allowed_origin`` 为 None 时不发 Allow-Origin。"""
    if allowed_origin:
        handler.send_header("Access-Control-Allow-Origin", allowed_origin)
        # 当 ``allowed_origin == "*"`` 时，浏览器拒绝带 credentials 的请求；
        # 显式回显具体 origin 时才能带 credentials，所以加 Vary: Origin 让 CDN
        # 按 origin 分别缓存。两者都要加，因为 "*" 路径也要可缓存。
        handler.send_header("Vary", "Origin")
        if allowed_origin != "*":
            handler.send_header("Access-Control-Allow-Credentials", "true")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")


def json_response(
    handler,
    payload: Dict[str, Any],
    *,
    status: int = 200,
    cors_origin: str = "",
    extra_headers: Optional[Dict[str, str]] = None,
) -> None:
    """发 JSON 响应。CORS 头按白名单 + 请求 Origin 动态决定。

    ``extra_headers`` 用于补充特殊场景下的响应头（如 429 携带 Retry-After）。
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    whitelist = _parse_whitelist(cors_origin)
    request_origin = handler.headers.get("Origin") if hasattr(handler, "headers") else None
    allowed = _resolve_allowed_origin(whitelist, request_origin)

    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    _send_cors_headers(handler, allowed)
    if extra_headers:
        for key, value in extra_headers.items():
            handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def cors_preflight(handler, cors_origin: str = "") -> None:
    """响应 OPTIONS 预检。CORS 头按白名单 + 请求 Origin 动态决定。"""
    whitelist = _parse_whitelist(cors_origin)
    request_origin = handler.headers.get("Origin") if hasattr(handler, "headers") else None
    allowed = _resolve_allowed_origin(whitelist, request_origin)

    handler.send_response(204)
    _send_cors_headers(handler, allowed)
    handler.send_header("Access-Control-Max-Age", "86400")
    handler.end_headers()


__all__ = ["json_response", "cors_preflight"]