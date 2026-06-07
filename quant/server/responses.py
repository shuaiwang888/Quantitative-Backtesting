"""统一 JSON 响应构造。"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional


def json_response(
    handler,
    payload: Dict[str, Any],
    *,
    status: int = 200,
    cors_origin: str = "*",
) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", cors_origin)
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.end_headers()
    handler.wfile.write(body)


def cors_preflight(handler, cors_origin: str = "*") -> None:
    handler.send_response(204)
    handler.send_header("Access-Control-Allow-Origin", cors_origin)
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Access-Control-Max-Age", "86400")
    handler.end_headers()


__all__ = ["json_response", "cors_preflight"]
