# A股量化回测平台

一个本地运行的 A 股量化研究工作台，围绕同花顺问财 OpenAPI 构建，支持自然语言取数、选股、单标的回测、指数回测、股票池批量回测、AI 复盘分析，以及 MySQL 数据持久化。

## 核心能力

- 自然语言数据查询：通过问财接口查询股票、指数、指标和选股结果。
- 选股工作台：输入自然语言条件，返回完整字段数据，展示 `code_count` 总股票数和 `chunks_info` 回写条件。
- 单标的回测：支持股票代码、股票名称、指数本身。
- 股票池批量回测：支持沪深300/中证500/中证1000成分股，也支持自定义股票列表。
- K线和交易可视化：展示权益曲线、K线图、买入/卖出点，支持鼠标悬停查看数据。
- AI 分析总结：回测完成后调用 MiniMax Anthropic 兼容接口生成策略复盘。
- MySQL 持久化：可将历史 K 线和选股/指标结果落库。
- 现实成交：收盘信号下一根 K 线开盘撮合，支持滑点、最低佣金、印花税、过户费、停牌和一字涨跌停延期。
- 稳定性保护：请求校验、超时、本地限流/寻优互斥；配置 Redis 后自动升级为多实例保护。

## 连接故障排查

页面出现“请求失败 · Failed to fetch”时，表示浏览器未获得可读取的接口响应；可能是后端冷启动、网络连接、错误地址或跨域配置问题。

- 页面顶部会检测后端连接；首次启动可等待约一分钟，再点“重新连接并刷新”。
- 在“连接设置”中使用“检测后端连接”。检测仅访问健康接口，不发送密钥或调用问财取数。
- 历史默认地址 `https://quant-backtest.onrender.com` 已退役；前端会将旧缓存和旧书签自动迁移到 `https://quant-backtest-wj92.onrender.com`。其他自定义后端不受影响。
- 如果配置过其他失效后端，可点“恢复默认后端”，保存后重试。
- 查询和选股翻页失败会保留上一页结果；页面缓存失效时可重置当前模块缓存并重试。
- 从选股股票池或自选股进入批量回测后，会自动选择“股票池批量”；每次最多回测前 100 只，逐只展示结果和错误，资金独立计算。

开发验证：`python3 -m pytest -q`、`npm test`、`npm run build`。前端测试覆盖连接错误、取消与超时、真实组件分页请求和股票池批量回测流程。

## 项目结构

```text
.
├── app.py                 # 启动入口（薄壳：加载 .env、启动 quant.server）
├── start.sh               # 启动脚本
├── requirements.txt       # Python 运行时依赖
├── requirements-dev.txt   # 测试 / 静态检查依赖
├── pytest.ini             # pytest 配置
├── mysql_schema.sql       # MySQL 建库建表脚本
├── .github/workflows/     # CI（pytest 多 Python 版本）
│
├── quant/                 # 主包
│   ├── config.py          # 集中式配置（Settings dataclass）
│   ├── distributed.py     # 可选 Redis 限流 / 分布式锁
│   ├── errors.py          # 错误码体系
│   ├── logging_setup.py   # 结构化日志
│   ├── server/            # HTTP 层（handler / middleware / responses）
│   ├── services/          # 业务编排（query / backtest / batch / optimize / analyze）
│   ├── strategies/        # 5 个策略 + 单一来源 SPECS 注册表
│   ├── indicators/        # MA / ATR / RSI / 滚动高/低，全部 O(n) 预计算
│   ├── data/              # 问财 + LLM + K 线规范化
│   └── persistence/       # MySQL 池（线程安全状态机）+ 仓库
│
├── tests/                 # pytest 回归套件
│
├── web/                   # React + Vite 前端源码
└── static/                # Vite 生产构建产物 + 图标
```

## 架构

```text
浏览器
  |
  | 静态页面 + fetch
  v
app.py 入口 → quant.server.BacktestHandler
  |
  ├── /api/strategies         → quant.strategies (元数据)
  ├── /api/query              → quant.services.query   → quant.data.iwencai → 问财 OpenAPI
  ├── /api/backtest           → quant.services.backtest → quant.strategies.run_backtest
  ├── /api/batch_backtest     → quant.services.batch    → (ThreadPool + Semaphore)
  ├── /api/optimize           → quant.services.optimize → quant.strategies
  └── /api/analyze            → quant.services.analyze  → quant.data.llm → MiniMax
       |
       ├── quant.indicators.*  → 预计算 O(n)
       ├── quant.persistence.* → MySQL（连接池 + 状态机）
       └── quant.errors.*      → 统一异常 → JSON 响应
```

数据流：

1. 页面提交查询或回测参数。
2. `app.py` 接收请求。
3. `quant/data/iwencai.py` 调用问财接口。
4. `quant/data/normalization.py` 规范化 K 线，`quant/strategies/` 执行策略。
5. 前端展示指标、图表、交易记录。
6. 若开启持久化，`quant/persistence/` 写入 MySQL。
7. 若是回测请求，前端会调用 `/api/analyze` 生成 AI 总结。

## 启动

基础启动：

```bash
export IWENCAI_API_KEY="你的问财 API Key"
python3 app.py
```

打开：

```text
http://127.0.0.1:8000
```

如果需要 AI 分析：

```bash
export MINIMAX_API_KEY="你的 MiniMax API Key"
export MINIMAX_BASE_URL="https://api.minimaxi.com/anthropic"
export MINIMAX_MODEL="MiniMax-M2.7"
```

当前本机推荐启动方式，使用 Homebrew Python 3.10 和 MySQL socket：

```bash
PYTHONPYCACHEPREFIX=/private/tmp/astock-pycache \
IWENCAI_API_KEY="你的问财 API Key" \
MINIMAX_API_KEY="你的 MiniMax API Key" \
MYSQL_PERSIST_ENABLED=1 \
MYSQL_AUTO_PERSIST=1 \
MYSQL_SOCKET=/tmp/quant_mysql.sock \
MYSQL_USER=quant_user \
MYSQL_PASSWORD=your_mysql_password \
MYSQL_DATABASE=quant_backtest \
PORT=8000 \
/usr/local/opt/python@3.10/bin/python3.10 app.py
```

说明：

- `quant/persistence/pool.py` 优先使用 `DBUtils` 连接池；不可用时会降级为 `PyMySQL` 直连。
- 如果开启 MySQL 持久化，请确认 `MYSQL_SOCKET`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 与本机数据库一致。
- 指数本身回测使用指数代码请求行情，例如沪深300为 `000300.SH`、中证500为 `000905.SH`、中证1000为 `000852.SH`。

### 本机清缓存并重启

如果修改了前端文件或遇到浏览器仍加载旧脚本，可以先停止旧服务、删除本地 Python 缓存，再重新启动：

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
kill <PID>
rm -rf __pycache__ /private/tmp/astock-pycache
```

然后使用推荐命令启动：

```bash
PYTHONPYCACHEPREFIX=/private/tmp/astock-pycache \
IWENCAI_API_KEY="你的问财 API Key" \
MINIMAX_API_KEY="你的 MiniMax API Key" \
MYSQL_PERSIST_ENABLED=1 \
MYSQL_AUTO_PERSIST=1 \
MYSQL_SOCKET=/tmp/quant_mysql.sock \
MYSQL_USER=quant_user \
MYSQL_PASSWORD=your_mysql_password \
MYSQL_DATABASE=quant_backtest \
PORT=8000 \
/usr/local/opt/python@3.10/bin/python3.10 app.py
```

验证静态资源是否是新版本：

```bash
curl -s http://127.0.0.1:8000/ | rg "assets/index-.*\\.js"
```

浏览器端建议使用强制刷新：

```text
Cmd + Shift + R
```

## 部署到云端（GitHub Pages + Render / Hugging Face Space）

GitHub Pages 只托管静态前端，Python 后端推荐部署到 Render（**首选**）或 Hugging Face Space。

仓库已经内置：

- `.github/workflows/pages.yml`：push 到 `main` 后构建 `web/` 并发布到 GitHub Pages。
- `.github/workflows/huggingface.yml`（可选）：手动把后端文件同步到已存在的 HF Space。
- `Dockerfile`：现有 Render Service / 容器平台的统一后端入口。

### 部署到 Render（**首选**）

本仓库故意不提供 `render.yaml`：已有服务名为 `quant-backtest-wj92`，Blueprint 会额外创建孤立服务。在现有 Render Service 中连接此 GitHub 仓库并选择 Docker runtime：

1. Build context 使用仓库根目录，由 `Dockerfile` 构建。
2. Health check path 设为 `/api/health`。
3. 设置 `HOST=0.0.0.0`，`PORT` 使用 Render 注入值。
4. Environment 页面**手动填**（不把密钥写入仓库）：
   - `IWENCAI_API_KEY` = 你的问财 key（**可选**，不填则访客必须自带）
   - `MINIMAX_API_KEY` = 你的 M2.7 key（**可选**）
   - `CORS_ORIGIN=https://github.wsllm.top,https://shuaiwang888.github.io`（实际前端 origin + Pages 备用 origin）
   - `TRUSTED_PROXIES=render`
   - `REDIS_URL` = 可选，多实例部署时建议配置
5. 启用 Git 自动部署后，push `main` 会触发新版本；上线后检查 `https://quant-backtest-wj92.onrender.com/api/health`。

> **如果你希望公开部署的 backend 完全不持有你的 key**（最安全）：第 4 步留空即可。访客必须自己填 key 才能用。

### 备选：部署到 Hugging Face Space

⚠️ **注意**：截至 2026-08，HF 新建 Gradio/Docker CPU Space 需要 PRO。当前目标 Space 已不存在，workflow 改为仅手动触发；先在 `appQQQ` 账号重建 `Quantitative-Backtesting-backend` 并更新 `HF_TOKEN`，再运行它。

HF Space 适合：低频测试 / 演示 / 不追求稳定运行。

### 推荐架构

```
访客浏览器 → GitHub Pages (静态前端) → Render (Python 后端) → iwencai / MiniMax
                                          ↑ 没有 owner 的 key
                              访客在浏览器填自己的 key（sessionStorage）
```

**关键设计**：owner 密钥可以不放在后端。访客可在「连接设置」中填入自己的问财 / MiniMax key；密钥只保存在当前标签页的 `sessionStorage`，由 `web/src/api.js` 注入请求，关闭标签页即清除。站点鉴权使用独立的 `X-API-Key`，不会被当作问财密钥透传。

- `.github/workflows/pages.yml`：push 到 `main` 后构建 `web/` 并发布到 GitHub Pages。
- `.github/workflows/huggingface.yml`：push 到 `main` 后把后端文件同步到 HF Space。

推荐架构：

```
访客浏览器 → GitHub Pages (静态前端) → Hugging Face Space (Gradio 后端) → iwencai / MiniMax
                                          ↑ 没有 owner 的 key
                              访客在浏览器填自己的 key（sessionStorage）
```

HF 前端与 Render 使用相同的会话密钥机制；默认不把访客密钥写入长期浏览器存储。

### 一、部署后端到 Hugging Face Space

1. 在 Hugging Face 创建 Space：`appQQQ/Quantitative-Backtesting-backend`。
2. Space SDK 选择 **Gradio**，入口文件由 workflow 生成的 Space README 指定为 `app_hf.py`。
3. 在 GitHub repo → Settings → Secrets and variables → Actions 中配置：
   - `HF_TOKEN`：Hugging Face write token，账号必须有该 Space 的写权限。
4. Space Settings → Variables and secrets 可选配置：
   - `IWENCAI_API_KEY`：可选，owner 兜底问财 key；不填时访客必须在前端填写自己的 key。
   - `MINIMAX_API_KEY`：可选，owner 兜底 MiniMax key。
   - `CORS_ORIGIN`：建议填 `https://github.wsllm.top,https://shuaiwang888.github.io`。
   - `PORT`：`7860`。
   - `MYSQL_PERSIST_ENABLED`：`0`。
5. 在 Actions 页面手动运行 `Deploy HF Space`，workflow 会上传后端并触发 Space rebuild。
6. 后端 URL：`https://appQQQ-quantitative-backtesting-backend.hf.space`。

> **如果你希望公开部署的 backend 完全不持有你的 key**（最安全）：第 4 步留空即可。访客必须自己填 key 才能用。

### 二、部署前端到 GitHub Pages

1. GitHub repo → **Settings** → **Pages** → **Build and deployment**
2. Source 选 **GitHub Actions**
3. push 到 `main`，`.github/workflows/pages.yml` 自动把 `static/` 部署到 Pages
4. 访问 `https://<user>.github.io/<repo>/`

### 三、把前端指向后端

首次访问时在 URL 后加 `?api=...`：

```
https://shuaiwang888.github.io/Quantitative-Backtesting/?api=https://appQQQ-quantitative-backtesting-backend.hf.space
```

`web/src/api.js` 会把后端 URL 存到 localStorage（URL 不是密钥）。使用 `?api=local` 可恢复同源/默认后端。

### 四、访客配置自己的 API 密钥

点击右上角「连接设置」，可配置后端地址、问财 Key、MiniMax Key 和独立的站点访问密钥。

- key 只存在当前标签页的 `sessionStorage.quant_session_credentials`
- 关闭标签页后自动清除，也可在模态框中点「清空」
- `/api/*` 请求自动带上 `iwencai_api_key` / `minimax_api_key`；站点密钥通过 `X-API-Key` 发送
- 后端优先用访客的 key，没有时再 fallback 到 Settings / env var

### 安全原则

| 风险 | 缓解 |
|---|---|
| `.env` 进 git | 已 gitignore；CI / Render 都不读 .env |
| API key 进仓库 | Render / HF Dashboard 中手动配置 secret，不写入 yaml / `.env.example` |
| Owner key 进 Render | **可选**；不填则 backend 完全无 owner key，访客必须自带 |
| API key 进 Pages | Pages 只托管静态文件，无密钥 |
| 访客 key 泄漏 | key 只在会话存储；CSP 降低 XSS 风险；公网必须使用 HTTPS |
| CORS 滥用 | 部署后建议把 `CORS_ORIGIN` 收窄到 Pages 域名 |
| 公开部署被刷 API | `RATE_LIMIT` + `RATE_WINDOW`；多实例配 `REDIS_URL`；必要时启用 `API_KEY` |
| iwencai key 绑本地 IP | 联系 iwencai 把 HF Space 出口 IP 加白，或改用 IP-无关的鉴权方式 |

### 成本

- GitHub Pages：100GB 带宽 / 月（个人用绰绰有余），$0
- Hugging Face Space CPU：免费额度按 HF 当前政策为准
- iwencai / MiniMax：按访客各自的账号套餐计费（owner 不承担）
- UptimeRobot 防休眠：50 个监控免费

正常个人使用 **$0**。

---

## 页面模块

### 回测

支持三种回测范围：

- 单只股票：输入股票代码或股票名称，例如 `300033`、`同花顺`。
- 指数本身：直接回测沪深300、中证500、中证1000指数行情。
- 股票池批量：对成分股或自定义股票列表逐只回测并汇总。

回测页面展示：

- 总收益
- 最大回撤
- 期末权益
- 交易次数
- 权益曲线
- K线与买卖点
- 交易记录
- AI 分析总结

说明：如果有 K 线数据但收益、回撤、交易次数均为 0，通常表示策略没有触发买卖信号，不代表取数失败。

### 数据

用于直接调试问财自然语言查询。输入任意问财查询语句后，平台会返回完整接口数据。

### 选股

输入自然语言条件，例如：

```text
市值大于100亿，近20日涨幅大于10%，换手率大于2%
```

选股模块会展示：

- `code_count`：命中的总股票数。
- `chunks_info`：问财回写/解析后的条件。
- 问财返回的所有字段和数据。
- 股票勾选框。
- 上一页/下一页翻页。
- 加入批量回测。

默认每页展示 `10` 条。

实现说明：

- 选股结果表会汇总当前页所有返回字段，不再只按第一行字段展示。
- 选股区会单独展示 `code_count`、当前页/总页数和 `chunks_info`。
- 前端使用 `setText`、`setHtml`、`setClass` 做安全写入，避免 `Cannot set properties of null (setting 'textContent')` 这类错误中断流程。

## 上证指数择时研究

策略回测页提供“载入上证指数半仓研究候选”，对应 `sse_monthly_trend` 与 `000001.SH`。采用月初趋势/动量检查、日收盘回撤退出、次日开盘执行；自动取入指标预热数据，预热期不下单、不计收益。

这是探索性研究候选。2021 年至 2026-10-28 的半仓模拟累计收益仅 1.16%、最大回撤 11.40%，未证明稳定超额收益。完整方法、失败候选和长期对照见 [上证指数择时研究](research/上证指数择时研究.md)。指数使用最小 1 模拟单位，不能把指数模拟视作可直接交易的 ETF 收益。

## 内置策略

### 动量突破 + ATR 风控

买入条件：

- 收盘价突破过去 `N` 日高点。
- 收盘价在趋势均线之上。
- 近期价格斜率向上。

卖出条件：

- 跌破 ATR 移动止损。
- 或跌破趋势均线。

核心参数：

- `breakout_window`：突破窗口，默认 `20`
- `trend_window`：趋势窗口，默认 `60`
- `atr_window`：ATR 窗口，默认 `14`
- `atr_multiplier`：ATR 止损倍数，默认 `2.5`
- `risk_per_trade`：单笔风险，默认 `0.02`

### 均线 + RSI

买入条件：

```text
MA5 > MA20 且 RSI6 < 40
```

卖出条件：

```text
MA5 < MA20 或 RSI6 > 60
```

核心参数：

- `fast_window`：快均线，默认 `5`
- `slow_window`：慢均线，默认 `20`
- `rsi_window`：RSI 窗口，默认 `6`
- `buy_rsi`：买入 RSI 阈值，默认 `40`
- `sell_rsi`：卖出 RSI 阈值，默认 `60`

### 6日通道反转 + 止损

买入条件：

```text
收盘价 < 前6根K线的最低收盘价
```

卖出条件：

```text
收盘价 > 前6根K线的最高收盘价
```

止损条件：

```text
收盘价 <= 买入价 * (1 - 止损百分比)
```

默认参数：

- `channel_window`：`6`
- `stop_loss_pct`：`0.05`

### 双均线交叉

买入条件：

- 快均线上穿慢均线。
- 如果慢均线首次形成时快均线已经在慢均线上方，也允许初始建仓。

卖出条件：

- 快均线下穿慢均线。

## 回测约定

- 当日收盘数据产生信号，下一根可交易 K 线的开盘价加/减滑点成交，避免前视偏差。
- 买入尽量使用可用现金。
- A 股按 `100` 股整数手下单。
- 卖出时一次性卖出全部持仓。
- 默认券商佣金率 `0.0003`（每笔最低 5 元），卖出印花税 `0.0005`，双边过户费 `0.00001`，单边滑点 `0.0005`。
- 明确 `volume=0` 时视为停牌/无成交；一字涨停不买、一字跌停不卖，指令默认最多延期 5 根 K 线。
- 涨跌停比例根据代码/名称推断；新股初期等特例应通过 `price_limit_pct` 显式覆盖。
- 回测结果中的基准收益为区间首尾收盘价收益。
- 权益曲线中的 `signal` 表示当天交易信号，K线图买卖点按交易发生日期标记。
- 卖出交易记录会保留实际卖出的股数，便于 K 线标记和交易复盘。
- K 线规范化会按证券代码和日期联合去重，避免多标的数据按日期互相覆盖。

## API

### `POST /api/query`

调用问财接口。

请求示例：

```json
{
  "query": "市值大于100亿，近20日涨幅大于10%，换手率大于2%",
  "page": 1,
  "limit": 10
}
```

返回包含：

- `datas`
- `code_count`
- `chunks_info`
- `trace_id`
- `raw`
- `persistence`

### `POST /api/backtest`

单标的或指数回测。

股票回测示例：

```json
{
  "backtest_mode": "single",
  "symbol": "300033",
  "start_date": "2025-05-17",
  "end_date": "2026-05-17",
  "strategy": "channel_reversal"
}
```

指数回测示例：

```json
{
  "backtest_mode": "index",
  "index_symbol": "hs300",
  "start_date": "2025-05-17",
  "end_date": "2026-05-17",
  "strategy": "channel_reversal"
}
```

返回包含：

- `summary`
- `equity_curve`
- `trades`
- `order_events`
- `execution`
- `bars`
- `query`
- `persistence`

### `POST /api/batch_backtest`

股票池批量回测。

自定义股票列表示例：

```json
{
  "backtest_mode": "batch",
  "symbols": "300033,600519",
  "start_date": "2025-05-17",
  "end_date": "2026-05-17",
  "strategy": "channel_reversal",
  "max_symbols": 20
}
```

成分股股票池示例：

```json
{
  "backtest_mode": "batch",
  "universe": "hs300",
  "start_date": "2025-05-17",
  "end_date": "2026-05-17",
  "strategy": "channel_reversal",
  "max_symbols": 20
}
```

返回包含：

- `summary.tested_count`
- `summary.avg_return`
- `summary.win_symbol_rate`
- `summary.avg_max_drawdown`
- `results`
- `errors`

### `POST /api/analyze`

根据回测结果调用大模型生成分析总结。

前端会在回测完成后自动调用。

## MySQL 持久化

### 表结构

建表脚本：

```bash
mysql -u root -p < mysql_schema.sql
```

当前设计包含三张表：

#### `securities`

证券主表。

核心字段：

- `symbol`：证券代码，例如 `300033.SZ`
- `name`：证券名称
- `asset_type`：`stock`、`index`、`fund`、`unknown`
- `exchange`：交易所后缀

#### `daily_bars`

日 K 线表。

主键：

```text
(symbol, trade_date)
```

核心字段：

- `open`
- `high`
- `low`
- `close`
- `volume`
- `amount`
- `query_text`
- `raw_json`

重复写入同一股票同一日期会更新。

#### `indicator_snapshots`

选股或指标查询结果表。

核心字段：

- `symbol`
- `snapshot_date`
- `query_hash`
- `query_text`
- `metrics_json`

`metrics_json` 保存问财返回的完整字段和值。

### 安装依赖

```bash
pip install -r requirements.txt
```

如果使用本机 Homebrew Python：

```bash
/usr/local/opt/python@3.10/bin/python3.10 -m pip install -r requirements.txt
```

### 启用持久化

全局自动持久化：

```bash
export MYSQL_PERSIST_ENABLED=1
export MYSQL_AUTO_PERSIST=1
```

仅单次请求持久化：

```json
{
  "persist": true
}
```

### MySQL 连接方式

TCP 连接：

```bash
export MYSQL_HOST=127.0.0.1
export MYSQL_PORT=3306
export MYSQL_USER=quant_user
export MYSQL_PASSWORD=your_mysql_password
export MYSQL_DATABASE=quant_backtest
```

Socket 连接：

```bash
export MYSQL_SOCKET=/tmp/quant_mysql.sock
export MYSQL_USER=quant_user
export MYSQL_PASSWORD=your_mysql_password
export MYSQL_DATABASE=quant_backtest
```

当前本机已创建专用用户：

```text
user: quant_user
password: your_mysql_password
database: quant_backtest
socket: /tmp/quant_mysql.sock
```

## 当前本机 MySQL 状态

当前环境中 3306 端口存在占用/异常，因此使用 3307 + socket 启动专用实例：

```bash
/usr/local/opt/mysql/bin/mysqld_safe \
  --datadir=/usr/local/var/mysql \
  --port=3307 \
  --socket=/tmp/quant_mysql.sock \
  --mysqlx=0
```

验证连接：

```bash
mysql --protocol=SOCKET --socket=/tmp/quant_mysql.sock -u quant_user -pyour_mysql_password \
  -e 'USE quant_backtest; SHOW TABLES;'
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `IWENCAI_API_KEY` | 问财 API Key | 必填 |
| `MINIMAX_API_KEY` | MiniMax API Key | 可选 |
| `MINIMAX_BASE_URL` | MiniMax Anthropic 兼容接口 base URL | `https://api.minimaxi.com/anthropic` |
| `MINIMAX_MODEL` | AI 分析模型 | `MiniMax-M2.7` |
| `HOST` | HTTP 服务 host | `127.0.0.1` |
| `PORT` | HTTP 服务端口 | `8000` |
| `REQUEST_TIMEOUT` | 单个 HTTP 连接超时秒数 | `30` |
| `MAX_BODY_BYTES` | JSON 请求体上限 | `1048576` |
| `RATE_LIMIT` / `RATE_WINDOW` | 单 IP 限流 | `60 / 60s` |
| `TRUSTED_PROXIES` | 可信代理头来源，如 `render` | 空 |
| `REDIS_URL` | 可选多实例限流/寻优锁 | 空（本地保护） |
| `MYSQL_PERSIST_ENABLED` | 是否允许 MySQL 持久化 | 关闭 |
| `MYSQL_AUTO_PERSIST` | 是否每次查询/回测自动写库 | 关闭 |
| `MYSQL_HOST` | MySQL host | `127.0.0.1` |
| `MYSQL_PORT` | MySQL port | `3306` |
| `MYSQL_SOCKET` | MySQL socket，设置后优先使用 | 空 |
| `MYSQL_USER` | MySQL 用户 | `root` |
| `MYSQL_PASSWORD` | MySQL 密码 | 空 |
| `MYSQL_DATABASE` | MySQL 数据库 | `quant_backtest` |

## 常见问题

### 1. 有 K 线但收益为 0

通常是策略没有触发买卖信号，不是数据缺失。

可以尝试：

- 拉长回测区间。
- 换一个策略。
- 调整策略参数。
- 换波动更大的标的或指数。

### 2. `Access denied for user 'root'@'localhost'`

建议不要用 root 做业务连接。使用已创建的专用用户：

```bash
export MYSQL_SOCKET=/tmp/quant_mysql.sock
export MYSQL_USER=quant_user
export MYSQL_PASSWORD=your_mysql_password
export MYSQL_DATABASE=quant_backtest
```

### 3. `缺少 PyMySQL`

当前服务使用哪个 Python，就要给哪个 Python 安装依赖。

本机推荐：

```bash
/usr/local/opt/python@3.10/bin/python3.10 -m pip install -r requirements.txt
```

并用同一个 Python 启动：

```bash
/usr/local/opt/python@3.10/bin/python3.10 app.py
```

### 5. AI 分析总结被截断

调整 `.env` 中的 `MINIMAX_MAX_TOKENS`，或减少传给 `quant/data/llm.py` 的 K 线数量。

### 6. 前端修改后看不到变化

重新构建 React 生产资源：

```bash
npm ci
npm run build
```

重新启动服务后强制刷新：

```text
Cmd + Shift + R
```

## 最近稳定性修复

- 修复买卖点标记错位：交易信号现在记录在交易发生当天。
- 修复卖出记录股数为 `0` 的问题。
- 修复指数回测使用名称查询导致可能无数据的问题，改为指数代码查询。
- 修复 K 线按日期单独去重导致多标数据互相覆盖的问题。
- 修复选股页面空 DOM 节点导致 `textContent` 报错的问题。
- MySQL 持久化支持 `DBUtils` 缺失时自动降级为 `PyMySQL` 直连。
- 增加 `OPTIONS` 响应，便于跨域或预检请求场景。

## 开发建议

- 策略新增放在 `quant/strategies/`，并同步 `SPECS` 注册表与测试。
- 数据源适配放在 `quant/data/`，业务编排放在 `quant/services/`。
- 页面交互放在 `web/src/`，不要直接编辑 Vite 生成的 `static/assets/`。
- 数据库结构变更先改 `mysql_schema.sql`，再同步 `quant/persistence/`。
- 密钥只放在 `.env` / 部署平台 Secret 或前端会话存储，不要硬编码。
- 批量回测建议增加行情缓存，避免重复请求问财接口。
- 策略验证建议加入样本内/样本外切分、参数网格搜索和基准对比。
- 若需要多实例共享限流、长任务排队或水平扩展，建议迁移到 ASGI + Redis 任务队列。
- 高风险改动后至少运行：

```bash
python3 -m compileall -q quant app.py app_hf.py
python3 -m pytest -q
npm run build
```
