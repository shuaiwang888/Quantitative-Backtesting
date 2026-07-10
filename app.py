#!/usr/bin/env python3
"""A股量化回测平台 - 启动入口。

本文件只做引导：解析 .env、初始化日志、调用 quant.server.run_server。
所有业务代码都在 `quant/` 包中。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _load_dotenv() -> None:
    """最简 .env 加载器，避免引入 python-dotenv 依赖。"""
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        # .env 不可读时忽略
        pass


def main() -> int:
    _load_dotenv()
    # 监听地址解析顺序：
    #   1. 显式环境变量 HOST / PORT（start.sh / HF Space Variables）
    #   2. Settings 默认值（HOST=0.0.0.0 / PORT=8000）
    #   - 本地 start.sh：显式 export HOST=127.0.0.1 PORT=8000 → 127.0.0.1:8000
    #   - HF Space：注入 PORT=7860，无 HOST → 0.0.0.0:7860（满足 HF 健康检查）
    # IWENCAI_API_KEY 不再硬性必填：
    # - 本地开发：填 .env 方便；
    # - 公开部署：把 key 留空，访客在浏览器里填自己的（POST 时通过 payload.api_key 透传）。
    if not os.environ.get("IWENCAI_API_KEY"):
        print(
            "提示: IWENCAI_API_KEY 未配置 —— 访客需在浏览器里填入自己的 key 才能调用 /api/*",
            file=sys.stderr,
        )
    try:
        from quant.server import run_server
    except ImportError as exc:
        print(f"错误: 导入 quant 包失败: {exc}", file=sys.stderr)
        return 1
    run_server()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
