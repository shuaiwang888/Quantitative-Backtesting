"""结构化日志配置。

- 默认输出到 stderr，简单一行格式。
- 通过 LOG_LEVEL 控制级别。
- 提供 access_log() 便捷函数，避免散落各处的 print。
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Mapping

_initialized = False


def setup_logging(level: str | None = None) -> None:
    """幂等初始化。重复调用不会重复挂 handler。"""
    global _initialized
    if _initialized:
        return

    log_level = (level or os.environ.get("LOG_LEVEL", "INFO")).upper()
    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(log_level)
    _initialized = True


def get_logger(name: str) -> logging.Logger:
    if not _initialized:
        setup_logging()
    return logging.getLogger(name)


def access_log(method: str, path: str, status: int, duration_ms: float, **extra: Any) -> None:
    """记录一次 HTTP 访问。"""
    logger = get_logger("access")
    fields = " ".join(f"{k}={v}" for k, v in extra.items() if v is not None)
    logger.info("%s %s %s %.1fms %s", method, path, status, duration_ms, fields)


__all__ = ["setup_logging", "get_logger", "access_log"]
