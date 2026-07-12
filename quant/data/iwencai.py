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
import socket
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
        except (socket.timeout, TimeoutError) as exc:
            # urllib 在 Python 3.10 之前抛 socket.timeout；3.10+ 在很多路径上抛
            # built-in TimeoutError；同时捕获以兼容。专门给出一条明确 message 而不是
            # 混在 URLError 里 —— 批量场景下某个标的卡超时不应影响其它标的的判断。
            last_error = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
                continue
            raise IwencaiError(
                f"请求超时（>{timeout}s）: {type(exc).__name__}"
            ) from exc
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
    """翻页拉取直到 code_count 耗尽或达到 max_pages。

    终止条件：
      1. 本页没有行（rows 为空 / 非 list）
      2. 已累计行数 ≥ 总数（仅当 code_count 是合法正整数时）
      3. 翻到 max_pages

    注意：当 ``code_count`` 不是 int（例如 None / 字符串 / 嵌套对象）时，
    我们不再兜底用 ``max(total, len(all_rows))`` —— 那会让 total 永远 ≤ 当前
    行数，导致翻页循环立刻终止（永远只 1 页）。这种情况改为 ``None`` 表示
    "未知总数"，靠下一页为空行作为唯一终止信号。
    """
    all_rows: List[Dict[str, Any]] = []
    traces: List[str] = []
    total: Optional[int] = None

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
        code_count_raw = result.get("code_count")
        if isinstance(code_count_raw, int) and not isinstance(code_count_raw, bool):
            total = code_count_raw
        # else: 保持 None，让循环继续直到下一页空
        if result.get("_trace_id"):
            traces.append(result["_trace_id"])

        # 终止：当前页空 / 已读到 total（当 total 已知）
        if not rows:
            break
        if total is not None and len(all_rows) >= total:
            break

    return {
        "success": True,
        "query": query_text,
        "datas": all_rows,
        "code_count": total if isinstance(total, int) else len(all_rows),
        "trace_ids": traces,
    }


# --- 工具函数（标准化响应） ---


def normalize_response(
    query_text: str,
    raw: Dict[str, Any],
) -> Dict[str, Any]:
    """把问财原始响应归一化成前端约定的字段。

    安全说明：上游响应里可能包含 iwencai 内部 session token 等敏感字段
    （典型路径：``raw`` → ``data`` → 某个含 ``session_id`` / ``token`` 的字典）。
    因此这里**显式不返回 raw 字段**，只放行白名单内的 metadata，
    避免把上游凭据意外泄漏到前端 / 浏览器 DevTools。
    """
    datas = raw.get("datas")
    if datas is None and isinstance(raw.get("data"), list):
        datas = raw.get("data")
    if not isinstance(datas, list):
        datas = []
    chunks_info = raw.get("chunks_info")
    if not isinstance(chunks_info, dict):
        chunks_info = {}
    code_count = raw.get("code_count", len(datas))
    return {
        "success": True,
        "query": query_text,
        "datas": datas,
        "code_count": code_count if isinstance(code_count, int) else len(datas),
        "trace_id": raw.get("trace_id") or raw.get("_trace_id", ""),
        "chunks_info": chunks_info,
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
