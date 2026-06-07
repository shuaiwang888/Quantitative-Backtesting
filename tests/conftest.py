"""pytest 全局 fixtures。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 让 pytest 能 import 项目根目录
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


# 测试时强制设置必需环境变量
os.environ.setdefault("IWENCAI_API_KEY", "test-key")
os.environ.setdefault("MYSQL_PERSIST_ENABLED", "0")


import pytest  # noqa: E402

from quant.config import reset_settings_cache  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_settings():
    """每个测试用例前后重置 settings 单例。"""
    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest.fixture
def sample_bars():
    """100 根合成 K 线，覆盖一个上升趋势 + 一些震荡。"""
    from quant.data.normalization import Bar

    bars = []
    for i in range(100):
        base = 10.0 + 0.05 * i
        swing = 0.5 if i % 5 == 0 else (-0.3 if i % 7 == 0 else 0.0)
        bars.append(
            Bar(
                date=f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
                close=base + swing,
                open=base,
                high=base + 1.0,
                low=base - 1.0,
                volume=1000.0 + i * 10,
                code="TEST",
                name="Test",
            )
        )
    return bars
