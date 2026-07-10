#!/usr/bin/env python3
"""HF Space 入口（Gradio SDK + ZeroGPU 兼容）。

架构：
  - FastAPI 提供 /api/* 路由（业务逻辑完全复用 quant 包）
  - Gradio Blocks 作占位 UI（让 HF 识别 SDK = gradio，绕过 ZeroGPU 限制）
  - gr.mount_gradio_app 把 Gradio mount 到 FastAPI
  - uvicorn 启动 ASGI app，监听 0.0.0.0:7860

路径：
  - /api/strategies        (GET)
  - /api/query             (POST)
  - /api/bars              (POST)
  - /api/backtest          (POST)
  - /api/batch_backtest    (POST)
  - /api/optimize          (POST)
  - /api/analyze           (POST)
  - /                      (Gradio 占位 UI)

前端**零改动**（路径与原 stdlib http.server 一致）。
本地仍走 app.py + stdlib http.server（开发体验不变）。
"""
from __future__ import annotations

import os
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import gradio as gr

from quant.config import get_settings
from quant.logging_setup import setup_logging


def create_api_app() -> FastAPI:
    """构造 FastAPI app（/api/* 路由）。"""
    settings = get_settings()
    app = FastAPI(
        title="A股量化回测平台 Backend",
        version="0.1.0",
    )

    # CORS：收窄到 GitHub Pages 域名
    cors_origin = settings.cors_origin or "*"
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[cors_origin] if cors_origin != "*" else ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- /api/strategies ----
    @app.get("/api/strategies")
    async def api_strategies():
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

    # ---- /api/query ----
    @app.post("/api/query")
    async def api_query(payload: dict):
        from quant.services.query import natural_language_query, QueryRequest
        try:
            req = QueryRequest(**payload)
        except TypeError as exc:
            raise HTTPException(status_code=400, detail=f"参数错误: {exc}")
        return natural_language_query(req)

    # ---- /api/bars ----
    @app.post("/api/bars")
    async def api_bars(payload: dict):
        from quant.services.query import fetch_bars
        query = payload.get("query", "").strip()
        if not query:
            raise HTTPException(status_code=400, detail="query 不能为空")
        return fetch_bars(
            query_text=query,
            api_key=payload.get("api_key") or None,
            max_pages=int(payload.get("max_pages") or 3),
            limit=int(payload.get("limit") or 100),
        )

    # ---- /api/backtest ----
    @app.post("/api/backtest")
    async def api_backtest(payload: dict):
        from quant.services.backtest import run_single_backtest, BacktestRequest
        try:
            req = BacktestRequest(**payload)
        except TypeError as exc:
            raise HTTPException(status_code=400, detail=f"参数错误: {exc}")
        return run_single_backtest(req)

    # ---- /api/batch_backtest ----
    @app.post("/api/batch_backtest")
    async def api_batch_backtest(payload: dict):
        from quant.services.batch import run_batch_backtest, BatchRequest
        try:
            req = BatchRequest(**payload)
        except TypeError as exc:
            raise HTTPException(status_code=400, detail=f"参数错误: {exc}")
        return run_batch_backtest(req)

    # ---- /api/optimize ----
    @app.post("/api/optimize")
    async def api_optimize(payload: dict):
        from quant.services.optimize import run_grid_search, OptimizeRequest
        try:
            req = OptimizeRequest(**payload)
        except TypeError as exc:
            raise HTTPException(status_code=400, detail=f"参数错误: {exc}")
        return run_grid_search(req)

    # ---- /api/analyze ----
    @app.post("/api/analyze")
    async def api_analyze(payload: dict):
        from quant.services.analyze import analyze
        return {"analysis": analyze(payload)}

    # ---- 健康检查 ----
    @app.get("/health")
    async def health():
        return {"status": "ok", "service": "quant-backtest"}

    return app


def create_gradio_ui() -> gr.Blocks:
    """Gradio Blocks 占位 UI（让 HF 识别 SDK = gradio）。"""
    with gr.Blocks(title="Quant Backend") as demo:
        gr.Markdown(
            "# A股量化回测平台后端\n\n"
            "此 Space 只提供后端 API（FastAPI on 0.0.0.0:7860）。\n\n"
            "**前端在 GitHub Pages**：\n"
            "https://shuaiwang888.github.io/Quantitative-Backtesting/\n\n"
            "## 端点\n\n"
            "- `GET  /api/strategies`\n"
            "- `POST /api/query`\n"
            "- `POST /api/bars`\n"
            "- `POST /api/backtest`\n"
            "- `POST /api/batch_backtest`\n"
            "- `POST /api/optimize`\n"
            "- `POST /api/analyze`\n"
        )
    return demo


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    port = int(os.environ.get("PORT", 7860))

    api_app = create_api_app()
    gradio_ui = create_gradio_ui()

    # 把 Gradio mount 到 FastAPI（根路径 /）
    # ZeroGPU 看到 gr.Blocks 就放行
    app = gr.mount_gradio_app(api_app, gradio_ui, path="/")

    print(f"A股量化回测平台已启动: http://0.0.0.0:{port}")
    print(f"配置: cors={settings.cors_origin} rate_limit={settings.rate_limit}/{settings.rate_window}s iwencai={'owner' if settings.iwencai_api_key else 'visitor-only'}")
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
