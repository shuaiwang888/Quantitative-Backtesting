# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

本地运行的 A 股量化研究工作台，围绕同花顺问财（iwencai）OpenAPI 构建。前端是纯静态页面，后端是 Python stdlib `http.server` + 自研 `quant/` 包，回测完成后调用 MiniMax（M2.7）做 AI 复盘。

## 启动 / 开发

### 启动 HTTP 服务

```bash
./start.sh            # 推荐：自动加载 .env、检查端口、用 Homebrew Python 3.10 启动
# 或
python3 app.py
```

`start.sh` 会：
- 加载 `.env`（如果存在）
- 检查 `PORT`（默认 8000）是否被占用
- 优先用 `/usr/local/opt/python@3.10/bin/python3.10`，否则回退到 `python3`
- 在缺 `IWENCAI_API_KEY` 时直接报错退出

### 必需环境变量

- `IWENCAI_API_KEY`：问财 API Key
- `MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`：AI 复盘，可选

### MySQL 相关（可选，关闭时功能正常）

`MYSQL_PERSIST_ENABLED=1` 开启持久化；`MYSQL_AUTO_PERSIST=1` 每次查询/回测自动写库。配置从 `quant/config.py` 集中读取（`Settings` dataclass）。

### 清缓存 + 重启

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
kill <PID>
rm -rf __pycache__ /private/tmp/astock-pycache
./start.sh
# 浏览器强制刷新：Cmd + Shift + R
```

### 静态资源健康检查

```bash
curl -s http://127.0.0.1:8000/app.js | rg "function setText|selector-meta"
```

## 测试

```bash
pip install -r requirements.txt
python -m pytest tests/ -v
```

CI 在 3.10 / 3.11 / 3.12 上跑（`.github/workflows/test.yml`）。测试不需要真实 MySQL，连接池会进入 `disabled` 状态。

## 目录结构

```text
.
├── app.py                 # 启动入口（仅 30 行：加载 .env、启动服务）
├── start.sh               # 启动脚本
├── requirements.txt       # 依赖
├── pytest.ini             # pytest 配置
├── mysql_schema.sql       # 建表脚本
├── .github/workflows/     # CI
│
├── quant/                 # 主包
│   ├── __init__.py
│   ├── config.py          # 集中式配置（Settings dataclass）
│   ├── errors.py          # AppError 层级 + 错误码
│   ├── logging_setup.py   # 结构化日志
│   │
│   ├── server/            # HTTP 层
│   │   ├── app.py         # BacktestHandler + run_server
│   │   ├── middleware.py  # 鉴权 + 限流（GC 防护）
│   │   └── responses.py   # JSON 响应 / CORS
│   │
│   ├── services/          # 业务服务
│   │   ├── query.py       # 单页问财
│   │   ├── backtest.py    # 单标的/指数回测
│   │   ├── batch.py       # 批量回测（带信号量）
│   │   ├── optimize.py    # 网格寻优
│   │   └── analyze.py     # LLM 复盘
│   │
│   ├── strategies/        # 策略 + 注册表
│   │   ├── base.py        # BaseStrategy / Trade / EquityPoint
│   │   ├── moving_average.py
│   │   ├── momentum_atr.py
│   │   ├── ma_rsi.py
│   │   ├── channel_reversal.py
│   │   ├── volume_shadow_break.py
│   │   └── __init__.py    # SPECS 注册表 + 工厂
│   │
│   ├── indicators/        # 技术指标
│   │   ├── moving_average.py   # 前缀和 O(n)
│   │   ├── volatility.py       # ATR
│   │   ├── momentum.py         # Wilder RSI
│   │   └── trend.py            # 滚动高/低（单调队列 O(n)）
│   │
│   ├── data/              # 数据层
│   │   ├── normalization.py    # Bar / normalize_bars / 字段抽取
│   │   ├── iwencai.py          # 问财 OpenAPI（含 CLI）
│   │   └── llm.py              # MiniMax 兼容接口
│   │
│   ├── persistence/       # MySQL 持久化
│   │   ├── pool.py        # 线程安全连接管理（状态机）
│   │   └── repository.py  # persist_bars / persist_indicator_rows
│   │
│   └── optimization/
│       └── grid.py        # 网格寻优（带超时和上限）
│
├── tests/                 # 测试套件
│   ├── conftest.py
│   ├── test_indicators.py
│   ├── test_normalization.py
│   ├── test_strategies.py
│   ├── test_optimization.py
│   ├── test_persistence.py
│   └── test_server.py
│
├── web/                   # React + Vite 前端源码（npm run dev/build）
│   ├── index.html         # 含 favicon / theme-color / apple-touch-icon 引用
│   ├── public/            # 静态资产（构建时原样 copy 到 static/）
│   │   ├── favicon.svg    # 主图标（K 线 + 趋势线，矢量）
│   │   ├── favicon.ico    # 兼容老浏览器（16/32/48 三合一）
│   │   ├── favicon.png    # 通用 32×32
│   │   └── icons/         # apple-touch-icon / PWA / maskable 全尺寸
│   └── src/               # React 组件 / hooks / utils
│
└── static/                # Vite build 产物（GitHub Pages 部署这个）
    ├── index.html
    ├── favicon.svg / .ico / .png
    ├── icons/             # 全尺寸 PNG（自动从 web/public/ 复制）
    └── assets/            # 哈希命名的 JS / CSS chunks
```

> **图标**：源文件 `web/public/favicon.svg` + `web/public/icons/*.png`。
> 重新生成用 `python3 /tmp/gen_icons.py`（依赖 PIL，无需 cairosvg）。
> 主题色 `#0b1220` 同步在 `web/index.html` 的 `theme-color` meta。

## 各模块职责

- [quant/config.py](quant/config.py)：所有环境变量集中解析为类型化 `Settings`；提供 `safe_summary()` 给启动日志（不泄露密钥）。
- [quant/errors.py](quant/errors.py)：异常基类 + 子类（Validation/Auth/RateLimit/Upstream/NotFound/Persistence），每个携带 `code` + `status` + `safe_message`，响应里不暴露内部信息。
- [quant/server/middleware.py](quant/server/middleware.py)：限流器自带 GC（防止 X-Forwarded-For OOM）；鉴权支持 `hmac.compare_digest`。
- [quant/strategies/__init__.py](quant/strategies/__init__.py)：**单一来源**的 `SPECS` 注册表（name / display_name / default_params / default_grid）。
- [quant/indicators/](quant/indicators/)：所有指标都是 O(n) 预计算，策略 `on_bar` 内部 O(1) 查询。
- [quant/persistence/pool.py](quant/persistence/pool.py)：状态机 `disabled / pool / direct / unavailable`，首次初始化用 `threading.Lock` 保护。
- [quant/persistence/repository.py](quant/persistence/repository.py)：`query_hash` 包含 (query, page, limit)，**避免分页覆盖**。
- [quant/services/batch.py](quant/services/batch.py)：批量回测带 `Semaphore(5)`，避免打爆问财 QPS。
- [quant/services/optimize.py](quant/services/optimize.py)：组合数上限由 `OPTIMIZE_MAX_COMBINATIONS` 控制；排序用 `(is None, -value)` 不再因 None 崩溃。

## API

- `GET  /api/strategies` — 列出所有策略元数据
- `POST /api/query` — 单页问财
- `POST /api/backtest` — 单标的 / 指数回测
- `POST /api/batch_backtest` — 股票池批量
- `POST /api/optimize` — 网格寻优
- `POST /api/analyze` — LLM 复盘
- `POST /api/bars` — 拉近一年日 K + 元信息（Dashboard 标的弹窗专用，翻页 + 归一化）

错误响应统一格式：`{"success": false, "code": "...", "error": "..."}`。

## 开发约定

- **新策略** → 放 `quant/strategies/<name>.py`，在 `quant/strategies/__init__.py` 的 `SPECS` 注册（这是**唯一**需要改的地方）。
- **新数据源** → 在 `quant/data/` 加新模块（如 `quant/data/akshare.py`）；不要直接用 `urllib`，继承 `IwencaiError` 的模式定义自己的异常。
- **新指标** → 放 `quant/indicators/<category>.py`，**只导出预计算函数**（O(n)），不要给策略提供"按需计算"接口。
- **新错误** → 在 `quant/errors.py` 加子类，所有 `safe_message` 都要保证不泄露内部信息。
- **新 API** → 在 `quant/server/app.py` 的 `_dispatch` 加分支；handler 抛 `AppError` 子类即可，不要直接 `json_response(error=...)`。
- **持久化必须可降级**：DB 不可用时不能阻塞主流程；写库异常要吞掉并写到响应里的 `persistence.error`。
- **新配置** → 加到 `quant/config.py` 的 `Settings` 字段，并在 `safe_summary()` 中体现（不要打印密钥）。
- **测试覆盖**：每个新模块至少写 1 个测试文件（`tests/test_<module>.py`）；CI 强制跑 `pytest`。

## 环境变量

完整列表见 `quant/config.py` 的 `Settings`，常用：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `HOST` / `PORT` | HTTP 监听 | 127.0.0.1:8000 |
| `IWENCAI_API_KEY` | 问财 API Key（必填） | - |
| `MINIMAX_API_KEY` | AI 复盘 key | 空 |
| `MINIMAX_BASE_URL` | MiniMax 接口 | https://api.minimaxi.com/anthropic |
| `MINIMAX_MODEL` | 模型 | MiniMax-M2.7 |
| `MYSQL_PERSIST_ENABLED` | 启用持久化 | 0 |
| `MYSQL_AUTO_PERSIST` | 自动写库 | 0 |
| `MYSQL_SOCKET` / `MYSQL_HOST` | 连接方式 | socket 优先 |
| `RATE_LIMIT` / `RATE_WINDOW` | 限流 | 60 req / 60s |
| `OPTIMIZE_MAX_COMBINATIONS` | 寻优组合数上限 | 500 |
| `OPTIMIZE_TIMEOUT_SECONDS` | 寻优超时 | 120s |
| `BATCH_MAX_SYMBOLS` / `BATCH_MAX_WORKERS` | 批量上限 | 100 / 10 |
| `LOG_LEVEL` | 日志级别 | INFO |

## GitHub Secrets

CI（`.github/workflows/test.yml`）只用到 `IWENCAI_API_KEY`（其它 env 在 CI 里没意义，安全起见也用不到）。GitHub Pages 工作流不消费任何密钥——它是纯静态打包，绝不能把 API Key 注入前端 bundle，否则会被全世界看到。

设置方式两种：

### 方式一：网页 UI
仓库 → **Settings → Secrets and variables → Actions → New repository secret**，逐个加：

| Secret 名 | 值 | 用途 |
| --- | --- | --- |
| `IWENCAI_API_KEY` | 你的问财 key | CI tests 读到就跳过 dummy；fork PR 拿不到，会自动落到 `test-key-for-ci` |
| `MINIMAX_API_KEY` | 你的 M2.7 key | （可选）仅当 CI 想跑 `quant/data/llm.py` 相关测试时配 |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com/anthropic` | 同上 |
| `MINIMAX_MODEL` | `MiniMax-M2.7` | 同上 |

### 方式二：gh CLI（推荐，可批量）
先 `gh auth login` 登录，然后在仓库根目录执行：

```bash
gh secret set IWENCAI_API_KEY --body "<你的问财 key>"
gh secret set MINIMAX_API_KEY --body "<你的 M2.7 key>"   # 可选
gh secret set MINIMAX_BASE_URL --body "https://api.minimaxi.com/anthropic"  # 可选
gh secret set MINIMAX_MODEL --body "MiniMax-M2.7"        # 可选
# 验证
gh secret list
```

> ⚠️ **安全守则**：
> 1. **绝对不要把 API key 用 `VITE_*` 注入前端**——`pages.yml` 会把这些值编进 `static/assets/*.js` 并公开到 GitHub Pages。当前 `web/src/*` 不读 env，干净。
> 2. Fork 来的 PR 拿不到 secrets（GitHub 内置安全）；CI 里加了 `|| 'test-key-for-ci'` 回退，所以公仓贡献者不会因为缺 secret 而红。
> 3. 后端要部署到云（Render / Railway / Fly.io / HF Space 等——见 `pages.yml` 注释），把上面的 Secret 加到对应平台的 Environment Variables 里；它们**不是** GitHub Secrets，但命名一致便于维护。

## 部署到 Hugging Face Space（Docker SDK）

后端镜像推到 `https://huggingface.co/spaces/appQQQ/Quantitative-Backtesting-backend`，子域 `https://appQQQ-quantitative-backtesting-backend.hf.space`。前端继续走 GitHub Pages，访客首次访问用 `?api=` 切到 HF 后端。

### 关键改动

| 文件 | 改动 |
|---|---|
| `quant/config.py` | `Settings.host` 默认 `"127.0.0.1"` → `"0.0.0.0"`（满足 HF 健康检查；本地 `start.sh` 仍显式 export 127.0.0.1，不影响） |
| `app.py` | `main()` 顶部加 5 行注释说明 host 解析顺序 |
| `Dockerfile` | 新建：`python:3.10-slim` + 单进程 `python app.py` + EXPOSE 7860 + HEALTHCHECK |
| `.dockerignore` | 新建：排除 `web/`、`static/`、`tests/`、`*.md`、`.env`、cyber_ppt_output 等 |
| `.github/workflows/huggingface.yml` | 新建：监听 `quant/**` 变化 → 构建 `hf-deploy/` → `git push -f` 到 HF Space 仓库 |

### 镜像里跑什么

```text
python:3.10-slim
  ├── PYTHONPYCACHEPREFIX=/tmp/pycache   ← 写业务目录会污染镜像
  ├── WORKDIR /app
  ├── requirements.txt → pip install      ← 单层缓存
  ├── quant/ + app.py
  ├── EXPOSE 7860
  └── CMD ["python", "app.py"]
```

容器启动 → 读 HF 注入的 `PORT=7860` + Settings 默认 `HOST=0.0.0.0` → 监听 0.0.0.0:7860。

### HF Space Variables and secrets 必填

| 名 | 类型 | 值 |
|---|---|---|
| `CORS_ORIGIN` | variable | `https://shuaiwang888.github.io`（**必须收窄**） |
| `PORT` | variable | `7860`（显式声明） |
| `IWENCAI_API_KEY` | secret | owner 真实 key（访客用浏览器填自己的） |
| `MYSQL_PERSIST_ENABLED` | variable | `0`（HF 无 MySQL） |
| `RATE_LIMIT` | variable | `30`（比本地 60 收紧） |

**不设 `HOST`** —— 让 `Settings.host` 默认 `0.0.0.0` 生效。
**不设 `HF_TOKEN`** —— Docker SDK 构建由 HF 平台凭 Space 自身权限完成。

### GitHub Secret 必填

| Secret | 用途 |
|---|---|
| `HF_TOKEN` | GitHub Action 推 HF Space 用（**scope = write on appQQQ/Quantitative-Backtesting-backend 单个 Space**，不要给账号级 write） |

### 访客切换后端

```
https://shuaiwang888.github.io/Quantitative-Backtesting/?api=https://appQQQ-quantitative-backtesting-backend.hf.space
```

`web/src/api.js` 自动写入 `localStorage.quant_api_base`，后续免带参数。

### 回滚

- **前端切回**：DevTools → `localStorage.removeItem("quant_api_base")` → reload
- **Space 暂停**：HF Space Settings → Pause Space（10 秒）
- **业务代码回滚**：`git revert HEAD~1` + push
- **新增文件回滚**：`git rm Dockerfile .dockerignore .github/workflows/huggingface.yml` + push

## 提交 GitHub 前的检查清单

```bash
# 1. 语法检查
python -m compileall -q quant/ app.py

# 2. 测试全过（HF 部署不引入新逻辑，pytest 仍应全过）
python -m pytest tests/

# 3. .env 不进 git（已在 .gitignore）
git status   # 确认 .env 未被 add

# 4. .dockerignore 防止 web/ / static/ / tests/ / docs/ 进 HF 镜像
cat .dockerignore
```
