#!/usr/bin/env python3
"""HF Space 入口（Gradio SDK + ZeroGPU 兼容）。

设计：
  - 完全用 demo.launch() 启动（不要 uvicorn.run，否则与 ZeroGPU 端口冲突）
  - 7 个 /api/* 全部用 gr.Interface 包装为 Gradio function
  - 路径从 /api/* 变为 /gradio_api/call/<name>
  - Body 从 {query, page, limit} 变为 {data: [query, page, limit, ...]}
  - 响应是流式（SSE），前端要适配（见 web/src/api.js）

调用约定（统一）：
  - 每个 API 用 gr.JSON 收 payload dict
  - 内部构造对应的 Request dataclass 并调用 quant.services.*
  - 返回 dict

启动端口 7860（ZeroGPU 默认）。本地不起作用（要 uvicorn 走的话用 app.py）。
"""
from __future__ import annotations

import os
import gradio as gr

# `spaces` 是 HF Space runtime 才提供的独立包（不是 huggingface_hub 子模块）。
# 本地 import 失败时降级为 no-op 装饰器（不影响本地运行）。
try:
    from spaces import GPU as _GPU
except ImportError:
    def _GPU(duration=None):
        def decorator(fn):
            return fn
        return decorator

from quant.config import get_settings
from quant.logging_setup import setup_logging


# ---- Gradio function 包装：所有 API 用 dict payload 形式 ----
# 注意：所有 API 都加 @_GPU 装饰器（ZeroGPU 平台要求至少一个）。
# 这些函数实际不需要 GPU，但 ZeroGPU runtime 会为它们分配 L4 资源。
# 短任务友好（strategies / query / bars / analyze 几秒内完成）；
# 长任务（backtest / batch / optimize）用更长的 duration 配额。

@_GPU(duration=20)
def api_strategies(payload: dict = None):
    """GET /api/strategies 的 Gradio 版本（payload 忽略，保持 GET 语义）。"""
    from quant.strategies import list_strategies
    specs = list_strategies()
    return {
        "success": True,
        "strategies": [
            {
                "name": s.name,
                "display_name": s.display_name,
                "default_params": s.default_params,
                "default_grid": s.default_grid,
            }
            for s in specs
        ],
    }


@_GPU(duration=60)
def api_query(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.query import natural_language_query, QueryRequest
        req = QueryRequest(**payload)
        return natural_language_query(req)
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


@_GPU(duration=60)
def api_bars(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.query import fetch_bars
        query = (payload.get("query") or "").strip()
        if not query:
            return {"success": False, "code": "validation", "error": "query 不能为空"}
        return fetch_bars(
            query_text=query,
            api_key=payload.get("api_key") or None,
            max_pages=int(payload.get("max_pages") or 3),
            limit=int(payload.get("limit") or 100),
        )
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


@_GPU(duration=300)
def api_backtest(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.backtest import run_single_backtest, BacktestRequest
        req = BacktestRequest(**payload)
        return run_single_backtest(req)
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


@_GPU(duration=300)
def api_batch_backtest(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.batch import run_batch_backtest, BatchRequest
        req = BatchRequest(**payload)
        return run_batch_backtest(req)
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


@_GPU(duration=300)
def api_optimize(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.optimize import run_grid_search, OptimizeRequest
        req = OptimizeRequest(**payload)
        return run_grid_search(req)
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


@_GPU(duration=120)
def api_analyze(payload: dict):
    if not isinstance(payload, dict):
        return {"success": False, "code": "validation", "error": "payload 必须是 dict"}
    try:
        from quant.services.analyze import analyze
        return {"analysis": analyze(payload)}
    except Exception as exc:
        return {"success": False, "code": "exception", "error": str(exc)}


def build_ui() -> gr.Blocks:
    """Gradio Blocks + 7 个 API endpoint（无 UI 组件，纯 API）。"""
    with gr.Blocks(title="Quant Backend") as demo:
        gr.Markdown(
            "# A股量化回测平台后端\n\n"
            "此 Space 只提供后端 API（Gradio Functions）。\n\n"
            "**前端在 GitHub Pages**：https://shuaiwang888.github.io/Quantitative-Backtesting/\n\n"
            "## 端点（Gradio API 格式）\n\n"
            "- `POST /gradio_api/call/strategies` body `{\"data\": [{}]}`\n"
            "- `POST /gradio_api/call/query`     body `{\"data\": [payload]}`\n"
            "- `POST /gradio_api/call/bars`      body `{\"data\": [payload]}`\n"
            "- `POST /gradio_api/call/backtest`  body `{\"data\": [payload]}`\n"
            "- `POST /gradio_api/call/batch_backtest` body `{\"data\": [payload]}`\n"
            "- `POST /gradio_api/call/optimize`  body `{\"data\": [payload]}`\n"
            "- `POST /gradio_api/call/analyze`   body `{\"data\": [payload]}`\n"
        )

        # 注册 7 个 API（inputs=JSON，outputs=JSON；data 列表里只有一个 dict）
        gr.Interface(
            fn=api_strategies,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="strategies",
        )
        gr.Interface(
            fn=api_query,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="query",
        )
        gr.Interface(
            fn=api_bars,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="bars",
        )
        gr.Interface(
            fn=api_backtest,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="backtest",
        )
        gr.Interface(
            fn=api_batch_backtest,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="batch_backtest",
        )
        gr.Interface(
            fn=api_optimize,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="optimize",
        )
        gr.Interface(
            fn=api_analyze,
            inputs=gr.JSON(value={}),
            outputs=gr.JSON(),
            api_name="analyze",
        )

    return demo


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    port = int(os.environ.get("PORT", 7860))

    demo = build_ui()
    print(f"A股量化回测平台已启动: http://0.0.0.0:{port}", flush=True)
    print(f"配置: cors={settings.cors_origin} rate_limit={settings.rate_limit}/{settings.rate_window}s iwencai={'owner' if settings.iwencai_api_key else 'visitor-only'}", flush=True)

    # 只用 demo.launch()（不调 uvicorn.run；ZeroGPU 平台自己也有 listener）
    demo.launch(
        server_name="0.0.0.0",
        server_port=port,
        show_error=True,
    )


if __name__ == "__main__":
    main()
