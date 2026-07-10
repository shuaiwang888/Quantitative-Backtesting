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
- 稳定性保护：前端关键 DOM 写入已做空节点保护，避免页面缓存或局部结构变动导致选股流程中断。

## 项目结构

```text
.
├── app.py                 # 启动入口（薄壳：加载 .env、启动 quant.server）
├── start.sh               # 启动脚本
├── requirements.txt       # Python 依赖
├── pytest.ini             # pytest 配置
├── mysql_schema.sql       # MySQL 建库建表脚本
├── .github/workflows/     # CI（pytest 多 Python 版本）
│
├── quant/                 # 主包
│   ├── config.py          # 集中式配置（Settings dataclass）
│   ├── errors.py          # 错误码体系
│   ├── logging_setup.py   # 结构化日志
│   ├── server/            # HTTP 层（handler / middleware / responses）
│   ├── services/          # 业务编排（query / backtest / batch / optimize / analyze）
│   ├── strategies/        # 5 个策略 + 单一来源 SPECS 注册表
│   ├── indicators/        # MA / ATR / RSI / 滚动高/低，全部 O(n) 预计算
│   ├── data/              # 问财 + LLM + K 线规范化
│   └── persistence/       # MySQL 池（线程安全状态机）+ 仓库
│
├── tests/                 # pytest 套件（106 个测试）
│
└── static/                # 前端（未改动）
    ├── index.html
    ├── app.js
    └── styles.css
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
3. `astock_api.py` 调用问财接口。
4. `backtester.py` 将问财返回数据规范化为 K 线并执行策略。
5. 前端展示指标、图表、交易记录。
6. 若开启持久化，`db.py` 写入 MySQL。
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

- `db.py` 会优先使用 `DBUtils` 连接池；如果当前环境没有安装 `DBUtils`，会自动降级为 `PyMySQL` 直连。
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
curl -s -o /tmp/quant_app_check.js http://127.0.0.1:8000/app.js
rg "function setText|selector-meta|code_count" /tmp/quant_app_check.js
```

浏览器端建议使用强制刷新：

```text
Cmd + Shift + R
```

## 部署到云端（GitHub Pages + Hugging Face Space）

GitHub Pages 只托管静态前端，Python 后端部署到 Hugging Face Space。当前仓库已经内置两条 GitHub Actions：

- `.github/workflows/pages.yml`：push 到 `main` 后构建 `web/` 并发布到 GitHub Pages。
- `.github/workflows/huggingface.yml`：push 到 `main` 后把后端文件同步到 HF Space。

推荐架构：

```
访客浏览器 → GitHub Pages (静态前端) → Hugging Face Space (Gradio 后端) → iwencai / MiniMax
                                          ↑ 没有 owner 的 key
                              访客在浏览器填自己的 key（localStorage）
```

**关键设计**：后端**不持有 owner 的 key**。访客首次打开页面时，在左上方"API 密钥"按钮里填入自己的问财 key（MiniMax 可选），key 只保存在访客自己的浏览器 localStorage，每次 POST 时由 `config.js` 注入到 `payload.api_key` / `payload.minimax_api_key`。后端读到这些字段就用访客的，否则用 env var 的（如果有）。这样部署到公网后，**owner 完全不用暴露自己的密钥**。

### 一、部署后端到 Hugging Face Space

1. 在 Hugging Face 创建 Space：`appQQQ/Quantitative-Backtesting-backend`。
2. Space SDK 选择 **Gradio**，入口文件由 workflow 生成的 Space README 指定为 `app_hf.py`。
3. 在 GitHub repo → Settings → Secrets and variables → Actions 中配置：
   - `HF_TOKEN`：Hugging Face write token，账号必须有该 Space 的写权限。
4. Space Settings → Variables and secrets 可选配置：
   - `IWENCAI_API_KEY`：可选，owner 兜底问财 key；不填时访客必须在前端填写自己的 key。
   - `MINIMAX_API_KEY`：可选，owner 兜底 MiniMax key。
   - `CORS_ORIGIN`：建议填 `https://shuaiwang888.github.io`。
   - `PORT`：`7860`。
   - `MYSQL_PERSIST_ENABLED`：`0`。
5. push 到 `main` 后，`Deploy HF Space` workflow 会上传后端并触发 Space rebuild。
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

`config.js` 会把 URL 存到 localStorage，以后免带参数。本地开发保持 `?api=` 为空即同源。

### 四、访客配置自己的 API 密钥

首次访问时，**左上方"API 密钥"按钮是红色脉冲状态**，页面顶部还有横幅提醒。点击按钮 → 弹出模态框 → 填入自己的问财 OpenAPI Key（必填）+ MiniMax Key（可选）→ 保存。

- key 只存在访客浏览器 `localStorage.quant_keys`，绝不上传到任何地方
- 关闭浏览器后仍在；点模态框里的"清除"按钮才能删
- 后续所有 `/api/*` 请求自动带上 `api_key` / `minimax_api_key`
- 后端优先用访客的 key，没有时再 fallback 到 Settings / env var

### 安全原则

| 风险 | 缓解 |
|---|---|
| `.env` 进 git | 已 gitignore；CI / Render 都不读 .env |
| API key 进 yaml | `sync: false` 阻止 Render 从 .env 同步，改为 dashboard 手动填 |
| Owner key 进 Render | **可选**；不填则 backend 完全无 owner key，访客必须自带 |
| API key 进 Pages | Pages 只托管静态文件，无密钥 |
| 访客 key 泄漏 | key 只在访客浏览器 localStorage；HTTPS 才能防中间人 |
| CORS 滥用 | 部署后建议把 `CORS_ORIGIN` 收窄到 Pages 域名 |
| 公开部署被刷 API | 用 `RATE_LIMIT` + `RATE_WINDOW` 限流；考虑加 `API_KEY` 静态鉴权 |
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

- 使用收盘价成交。
- 买入尽量使用可用现金。
- A 股按 `100` 股整数手下单。
- 卖出时一次性卖出全部持仓。
- 买入和卖出均扣手续费。
- 默认手续费率为 `0.0003`。
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

### 4. `cli.py` 缺失

`astock_api.py` 依赖 `cli.py` 中的问财请求函数。确保项目根目录存在 `cli.py`。

### 5. AI 分析总结被截断

当前 `llm_analyzer.py` 已将 `max_tokens` 提高到 `4096`，并要求模型输出简洁完整。如仍被截断，可继续提高 `max_tokens` 或减少输入的 K 线数量。

### 6. 选股时报 `Cannot set properties of null (setting 'textContent')`

通常是浏览器还加载了旧版 `app.js`，或页面结构和脚本版本不一致。

处理方式：

```bash
rm -rf __pycache__ /private/tmp/astock-pycache
```

重新启动服务后，在浏览器执行强制刷新：

```text
Cmd + Shift + R
```

当前 `static/app.js` 已对关键 DOM 写入做保护，正常情况下不会再因为单个节点不存在而中断选股。

### 7. 页面修改后看不到变化

优先确认服务返回的新脚本是否包含最新代码：

```bash
curl -s http://127.0.0.1:8000/app.js | rg "function setText|selector-meta"
```

如果命令能搜到，但浏览器还是旧表现，就是浏览器缓存。强制刷新或清理站点缓存即可。

## 最近稳定性修复

- 修复买卖点标记错位：交易信号现在记录在交易发生当天。
- 修复卖出记录股数为 `0` 的问题。
- 修复指数回测使用名称查询导致可能无数据的问题，改为指数代码查询。
- 修复 K 线按日期单独去重导致多标数据互相覆盖的问题。
- 修复选股页面空 DOM 节点导致 `textContent` 报错的问题。
- MySQL 持久化支持 `DBUtils` 缺失时自动降级为 `PyMySQL` 直连。
- 增加 `OPTIONS` 响应，便于跨域或预检请求场景。

## 开发建议

- 策略新增优先放在 `backtester.py`。
- 数据源适配优先放在 `astock_api.py`。
- 页面交互优先放在 `static/app.js`。
- 数据库结构变更先改 `mysql_schema.sql`，再同步 `db.py`。
- 密钥建议后续迁移到 `.env`，不要硬编码在 README、脚本或 shell 历史中。
- 批量回测建议增加行情缓存，避免重复请求问财接口。
- 策略验证建议加入样本内/样本外切分、参数网格搜索和基准对比。
- 后端规模继续扩大时，可以从 `http.server` 迁移到 FastAPI，获得更好的参数校验、接口文档和异步任务管理。
- 高风险改动后至少运行：

```bash
PYTHONPYCACHEPREFIX=/private/tmp/astock-pycache python3 -m py_compile app.py backtester.py astock_api.py db.py llm_analyzer.py
node --check static/app.js
```
