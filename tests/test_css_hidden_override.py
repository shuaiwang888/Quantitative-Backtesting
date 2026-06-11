"""回归：[hidden] 属性必须真的能隐藏元素（CSS 层）。

背景 bug：.modal { display: grid } 和 .keys-banner { display: flex } 会以
"作者样式"覆盖浏览器内置的 [hidden] { display: none }（特异度都 0,1,0，
作者样式源码在后 → 赢）。结果 JS 设 modal.hidden = true，属性变了但
视觉上还在。

修法：static/styles.css 顶部加全局重置：
    [hidden] { display: none !important; }

JSDOM 测不到 CSS，所以这里直接校验源文件包含这条规则。
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CSS_PATH = REPO_ROOT / "static" / "styles.css"


def test_hidden_override_present_in_css() -> None:
    """[hidden] 必须有 !important 规则，否则 .modal 关闭不生效。"""
    text = CSS_PATH.read_text(encoding="utf-8")
    # 简单字符串匹配；不做完整 CSS 解析（避免引入新依赖）
    assert "[hidden]" in text, "styles.css 应包含 [hidden] 选择器"
    # 必须显式带 !important —— 仅有 [hidden] 也会被 .modal 的 display: grid 覆盖
    # 注意：不能在注释里也写 [hidden] { display: none }，否则会被 ^ 锚点
    # 误匹配到注释示例。
    assert re.search(
        r"^\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?",
        text,
        re.MULTILINE,
    ), (
        "styles.css 应包含 `[hidden] { display: none !important; }` "
        "—— 否则 .modal / .keys-banner 的 hidden 属性会被自身的 display 覆盖"
    )


def test_modal_uses_display_grid() -> None:
    """确认 .modal 真的设了 display: grid —— 锁住回归触发条件。"""
    text = CSS_PATH.read_text(encoding="utf-8")
    # 找到 .modal { ... } 块，断言里面有 display: grid
    block = re.search(r"\.modal\s*\{[^}]*\}", text)
    assert block, ".modal { ... } 块应存在"
    assert "display" in block.group(0)
    assert "grid" in block.group(0)


def test_keys_banner_uses_display_flex() -> None:
    """确认 .keys-banner 真的设了 display: flex —— 锁住回归触发条件。"""
    text = CSS_PATH.read_text(encoding="utf-8")
    block = re.search(r"\.keys-banner\s*\{[^}]*\}", text)
    assert block, ".keys-banner { ... } 块应存在"
    assert "display" in block.group(0)
    assert "flex" in block.group(0)
