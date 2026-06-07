"""同花顺问财（Iwencai）OpenAPI 客户端。

合并了原 cli.py 的底层 HTTP 调用 + astock_api.py 的高层封装。
设计要点：
- 单次请求独立生成 trace_id；5xx/429 自动重试。
- fetch_all 自动翻页，按 code_count 终止。
- 错误统一包装为 UpstreamError 抛到上层。
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


SKILL_NAME = "hithink-astock-selector"
SKILL_VERSION = "1.0.0"
DEFAULT_API_URL = "https://openapi.iwencai.com/v1/query2data"
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0


# --- 异常 ---


class IwencaiError(Exception):
    """问财接口错误。"""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        response: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.response = response


# --- 公共工具 ---


def _trace_id() -> str:
    return secrets.token_hex(32)


def _resolve_api_key(provided: Optional[str]) -> str:
    key = provided or os.environ.get("IWENCAI_API_KEY", "")
    if not key:
        raise IwencaiError(
            "API 密钥未设置。请通过 --api-key 参数或环境变量 IWENCAI_API_KEY 指定。"
        )
    return key


def _build_headers(api_key: str, trace_id: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": SKILL_NAME,
        "X-Claw-Skill-Version": SKILL_VERSION,
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": trace_id,
    }


# --- 单次请求 ---


def query(
    query_text: str,
    *,
    page: int = 1,
    limit: int = 10,
    api_key: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    parser_logic: bool = False,
) -> Dict[str, Any]:
    """调用一次问财接口。返回完整 JSON 响应。"""
    api_key = _resolve_api_key(api_key)
    payload = {
        "query": query_text,
        "page": str(page),
        "limit": str(limit),
        "is_cache": "1",
        "expand_index": "true",
    }
    if parser_logic:
        payload["parser_logic"] = True

    last_error: Optional[Exception] = None
    for attempt in range(MAX_RETRIES):
        trace_id = _trace_id()
        headers = _build_headers(api_key, trace_id)
        if attempt > 0:
            headers["X-Claw-Call-Type"] = "retry"

        request = urllib.request.Request(
            DEFAULT_API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                data = json.loads(body)
                data["_trace_id"] = trace_id  # 附带回包 trace_id 便于排查
                return data
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8") if exc.fp else ""
            if (exc.code == 429 or 500 <= exc.code < 600) and attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
                continue
            raise IwencaiError(
                f"HTTP 错误 {exc.code}: {exc.reason}",
                status_code=exc.code,
                response=error_body,
            )
        except urllib.error.URLError as exc:
            last_error = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
                continue
            raise IwencaiError(f"网络错误: {exc.reason}") from exc
        except json.JSONDecodeError as exc:
            last_error = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
                continue
            raise IwencaiError(f"响应解析失败: {exc}") from exc
    raise IwencaiError(f"重试{MAX_RETRIES}次后仍失败: {last_error}")


# --- 翻页 ---


def fetch_all(
    query_text: str,
    *,
    api_key: Optional[str] = None,
    limit: int = 100,
    max_pages: int = 10,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """翻页拉取直到 code_count 耗尽或达到 max_pages。"""
    all_rows: List[Dict[str, Any]] = []
    traces: List[str] = []
    total = 0

    for page in range(1, max_pages + 1):
        result = query(
            query_text,
            page=page,
            limit=limit,
            api_key=api_key,
            timeout=timeout,
        )
        rows = result.get("datas")
        if not isinstance(rows, list):
            rows = result.get("data") if isinstance(result.get("data"), list) else []

        all_rows.extend(row for row in rows if isinstance(row, dict))
        if isinstance(result.get("code_count"), int):
            total = result["code_count"]
        else:
            total = max(total, len(all_rows))
        if result.get("_trace_id"):
            traces.append(result["_trace_id"])

        if not rows or len(all_rows) >= total:
            break

    return {
        "success": True,
        "query": query_text,
        "datas": all_rows,
        "code_count": total or len(all_rows),
        "trace_ids": traces,
    }


# --- 工具函数（标准化响应） ---


def normalize_response(
    query_text: str,
    raw: Dict[str, Any],
) -> Dict[str, Any]:
    """把问财原始响应归一化成前端约定的字段。"""
    datas = raw.get("datas")
    if datas is None and isinstance(raw.get("data"), list):
        datas = raw.get("data")
    if not isinstance(datas, list):
        datas = []
    return {
        "success": True,
        "query": query_text,
        "datas": datas,
        "code_count": raw.get("code_count", len(datas)),
        "trace_id": raw.get("trace_id") or raw.get("_trace_id", ""),
        "chunks_info": raw.get("chunks_info", {}),
        "raw": raw,
    }


# --- CLI（保留原 cli.py 行为，供命令行直接调用） ---


def _cli_main() -> int:
    parser = argparse.ArgumentParser(
        description="同花顺智能选股 - A股数据查询工具",
    )
    parser.add_argument("--query", "-q", required=True, help="查询字符串")
    parser.add_argument("--page", default="1")
    parser.add_argument("--limit", default="10")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args()

    try:
        result = query(
            query_text=args.query,
            page=int(args.page),
            limit=int(args.limit),
            api_key=args.api_key,
            timeout=args.timeout,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except IwencaiError as exc:
        print(json.dumps({"error": exc.message, "status_code": exc.status_code}, ensure_ascii=False, indent=2))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"发生错误: {exc}"}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli_main())


__all__ = [
    "IwencaiError",
    "query",
    "fetch_all",
    "normalize_response",
]
