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
    if not os.environ.get("IWENCAI_API_KEY"):
        print("错误: 缺少 IWENCAI_API_KEY 环境变量（请在 .env 中设置）", file=sys.stderr)
        return 1
    try:
        from quant.server import run_server
    except ImportError as exc:
        print(f"错误: 导入 quant 包失败: {exc}", file=sys.stderr)
        return 1
    run_server()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
