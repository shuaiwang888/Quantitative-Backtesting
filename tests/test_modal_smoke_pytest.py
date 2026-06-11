"""跑 JSDOM 冒烟测试验证 modal save button 的 click handler 真的注册成功。

背景 bug：app.js 在 <body> 末尾执行时，DOMContentLoaded 已 fire，
之前的代码用 addEventListener 永远等不到，导致"保存"按钮点击没反应。

修法：app.js 改用 ready() 辅助函数判断 readyState，已就绪就直接跑。
这个测试在 JSDOM 里加载真实 HTML+JS，模拟"脚本在 body 末尾"的真实场景，
然后 dispatch click 事件验证 handler 真的被触发了。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SMOKE_JS = REPO_ROOT / "tests" / "test_modal_smoke.js"


def _node_modules_with_jsdom() -> Path | None:
    """找一个含 jsdom 包的 node_modules 路径。"""
    # 本地开发：可能装在 /tmp/node_modules（手动 npm install jsdom）
    for cand in [Path("/tmp/node_modules"), REPO_ROOT / "node_modules"]:
        if (cand / "jsdom").is_dir():
            return cand
    return None


@pytest.mark.skipif(
    _node_modules_with_jsdom() is None,
    reason="jsdom 未安装；本地跑过 `npm install jsdom --prefix /tmp` 才能跑这个测试",
)
def test_modal_click_handlers_actually_registered():
    """端到端：JSDOM 加载真实 HTML+JS，模拟浏览器，验证 modal 流程可工作。"""
    node_modules = _node_modules_with_jsdom()
    env = os.environ.copy()
    env["NODE_PATH"] = str(node_modules)

    result = subprocess.run(
        ["node", str(SMOKE_JS)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        cwd=str(REPO_ROOT),
    )

    # 把 stdout 全部 dump 到测试输出，方便排查
    print(result.stdout)
    if result.returncode != 0:
        print("STDERR:", result.stderr, file=sys.stderr)

    assert result.returncode == 0, f"smoke test failed (rc={result.returncode})"
    assert "🎉 全部通过" in result.stdout, "expected '全部通过' in smoke test output"