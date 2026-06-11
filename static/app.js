const statusEl = document.querySelector("#status");
const tableHead = document.querySelector("#table-head");
const tableBody = document.querySelector("#table-body");
const tableTitle = document.querySelector("#table-title");
const tableCount = document.querySelector("#table-count");
const selectorMeta = document.querySelector("#selector-meta");
const selectAllRowsBtn = document.querySelector("#selector-select-all-rows");
const rangeLabel = document.querySelector("#range-label");
const klineLabel = document.querySelector("#kline-label");
const analysisStatus = document.querySelector("#analysis-status");
const analysisContent = document.querySelector("#analysis-content");
const chart = document.querySelector("#equity-chart");
const ctx = chart.getContext("2d");
const klineChart = document.querySelector("#kline-chart");
// klineChart 在新版本是 <div>（由 Lightweight Charts 接管），只有在 <canvas> 时才能 getContext
const kctx = klineChart.tagName === "CANVAS" ? klineChart.getContext("2d") : null;
const tooltip = document.querySelector("#chart-tooltip");
let lastEquityCurve = [];
let lastBars = [];
let lastTrades = [];
let equityLayout = null;
let klineLayout = null;
let selectorRows = [];

// 参数寻优可视化的 metric 元数据。
// usePercent: true → Y 轴/单元格值要乘 100 加 % 号
// higherIsBetter: true → 用 RdYlGn（红=差绿=好），回撤/亏损类指标用 RdYlGn_r
// key 与后端 result 字段名严格一致
const OPTIMIZE_METRICS = [
  { key: "total_return",  label: "总收益",   usePercent: true,  higherIsBetter: true  },
  { key: "annual_return", label: "年化收益", usePercent: true,  higherIsBetter: true  },
  { key: "max_drawdown",  label: "最大回撤", usePercent: true,  higherIsBetter: false },
  { key: "sharpe_ratio",  label: "夏普比率", usePercent: false, higherIsBetter: true  },
  { key: "win_rate",      label: "胜率",     usePercent: true,  higherIsBetter: true  },
];

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".form-view").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}-form`).classList.add("active");
    const titles = { query: "接口数据", selector: "自然语言选股", backtest: "策略表现", dashboard: "大盘与自选股" };
    setText("#page-title", titles[tab.dataset.tab] || "策略表现");
    syncPageSections(tab.dataset.tab);
  });
});

document.querySelector("#strategy-select").addEventListener("change", syncStrategyFields);
document.querySelector("#mode-select").addEventListener("change", syncModeFields);
chart.addEventListener("mousemove", handleEquityHover);
chart.addEventListener("mouseleave", hideTooltip);
klineChart.addEventListener("mousemove", handleKlineHover);
klineChart.addEventListener("mouseleave", hideTooltip);

document.querySelector("#backtest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在拉取行情并回测...");
  const payload = formPayload(event.currentTarget);
  try {
    if (payload.backtest_mode === "batch") {
      setStatus("正在批量回测股票池...");
      const data = await postJson(window.API_BASE + "/api/batch_backtest", payload);
      renderBatchBacktest(data);
      setStatus(`完成: ${data.summary.tested_count} 只标的`);
    } else {
      const data = await postJson(window.API_BASE + "/api/backtest", payload);
      renderBacktest(data);
      setStatus(`完成: ${data.summary.bar_count} 条K线`);
      analyzeBacktest(data);
    }
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#query-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在请求数据接口...");
  const payload = formPayload(event.currentTarget);
  try {
    const data = await postJson(window.API_BASE + "/api/query", payload);
    renderRows(data.datas || [], "接口返回数据", "query-");
    setStatus(`完成: ${data.datas ? data.datas.length : 0} 条`);
  } catch (error) {
    setStatus(error.message);
  }
});

document.querySelector("#selector-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pageInput = event.currentTarget.querySelector('input[name="page"]');
  if (pageInput && !pageInput.value) pageInput.value = "1";
  await runSelectorQuery();
});

document.querySelector("#selector-prev-page").addEventListener("click", async () => {
  const pageInput = document.querySelector('#selector-form input[name="page"]');
  const current = Math.max(1, Number(pageInput.value || 1));
  if (current <= 1) {
    setStatus("已经是第一页");
    return;
  }
  pageInput.value = String(current - 1);
  await runSelectorQuery();
});

document.querySelector("#selector-next-page").addEventListener("click", async () => {
  const form = document.querySelector("#selector-form");
  const pageInput = form.querySelector('input[name="page"]');
  const limitInput = form.querySelector('input[name="limit"]');
  const current = Math.max(1, Number(pageInput.value || 1));
  const limit = Math.max(1, Number(limitInput.value || 10));
  pageInput.value = String(current + 1);
  await runSelectorQuery();
});

async function runSelectorQuery() {
  setStatus("正在执行自然语言选股...");
  const form = document.querySelector("#selector-form");
  const payload = formPayload(form);
  payload.parser_logic = true;
  try {
    const data = await postJson(window.API_BASE + "/api/query", payload);
    selectorRows = normalizeSelectorRows(data.datas || []);
    renderSelectorRows(selectorRows, data);
    setStatus(`选股完成: ${selectorRows.length} 只`);
  } catch (error) {
    setStatus(error.message);
  }
}

document.querySelector("#use-selected-symbols").addEventListener("click", () => {
  const selected = Array.from(document.querySelectorAll(".selector-check:checked"))
    .map((input) => input.value)
    .filter(Boolean);
  if (!selected.length) {
    setStatus("请先勾选股票");
    return;
  }
  document.querySelector("#mode-select").value = "batch";
  document.querySelector('textarea[name="symbols"]').value = selected.join(", ");
  syncModeFields();
  activateTab("backtest");
  setStatus(`已加入 ${selected.length} 只股票到批量回测`);
});

selectAllRowsBtn.addEventListener("click", () => {
  const checks = Array.from(document.querySelectorAll(".selector-check"));
  const shouldCheck = checks.some((input) => !input.checked);
  checks.forEach((input) => {
    input.checked = shouldCheck;
  });
});

function formPayload(form) {
  const payload = {};
  new FormData(form).forEach((value, key) => {
    payload[key] = String(value).trim();
  });
  return payload;
}

async function analyzeBacktest(data) {
  setText("#analysis-status", "生成中");
  setText("#analysis-content", "正在结合K线、策略参数和回测结果生成分析...");
  try {
    const payload = {
      query: data.query,
      strategy: data.summary?.strategy,
      summary: data.summary,
      trades: data.trades,
      bars: data.bars,
      equity_curve: data.equity_curve,
    };
    const result = await postJson(window.API_BASE + "/api/analyze", payload);
    setHtml("#analysis-content", renderMarkdown(result.analysis || "没有返回分析内容。"));
    setText("#analysis-status", "已生成");
  } catch (error) {
    setText("#analysis-content", error.message);
    setText("#analysis-status", "生成失败");
  }
}

async function postJson(url, payload) {
  // 自动注入访客在浏览器里配的 API key（localStorage → payload）。
  // payload 显式带 api_key / minimax_api_key 的会保留原值（不被覆盖）。
  if (window.quantKeys && typeof window.quantKeys.inject === "function") {
    window.quantKeys.inject(payload);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function renderBacktest(data) {
  document.querySelector("#batch-panel").classList.add("hidden");
  const summary = data.summary;
  setText("#page-title", summary.strategy || "策略表现");
  setText("#metric-return", percent(summary.total_return));
  setClass("#metric-return", summary.total_return >= 0 ? "positive" : "negative");
  setText("#metric-dd", percent(summary.max_drawdown));
  setText("#metric-equity", money(summary.final_equity));
  setText("#metric-trades", summary.trade_count);
  setText("#range-label", `${summary.start_date} 至 ${summary.end_date}`);
  setText("#kline-label", `${summary.bar_count} 根K线`);
  lastEquityCurve = data.equity_curve || [];
  lastBars = data.bars || [];
  lastTrades = data.trades || [];
  drawChart(lastEquityCurve);
  // K 线：div 模式交给 Lightweight Charts 异步渲染；canvas 模式（兼容旧版）走内置 canvas
  if (klineChart.tagName === "CANVAS") {
    drawKlineChart(lastBars, lastTrades);
  } else {
    renderKlineLightweight(lastBars, lastTrades).catch((e) => {
      console.error("lightweight-charts 渲染失败", e);
    });
  }
  renderRows(data.trades || [], "交易记录");
}

function renderBatchBacktest(data) {
  const summary = data.summary;
  setText("#page-title", "股票池批量回测");
  document.querySelector("#batch-panel").classList.remove("hidden");
  setText("#metric-return", percent(summary.avg_return));
  setClass("#metric-return", (summary.avg_return || 0) >= 0 ? "positive" : "negative");
  setText("#metric-dd", percent(summary.avg_max_drawdown));
  setText("#metric-equity", summary.tested_count);
  setText("#metric-trades", summary.error_count);
  setText("#batch-count", `${summary.tested_count} 只成功`);
  setText("#batch-avg-return", percent(summary.avg_return));
  setText("#batch-win-rate", percent(summary.win_symbol_rate));
  setText("#batch-avg-dd", percent(summary.avg_max_drawdown));
  setText("#batch-errors", summary.error_count);
  setText("#range-label", "批量结果不展示单标的曲线");
  setText("#kline-label", "批量结果不展示K线");
  drawChart([]);
  drawKlineChart([], []);
  setText("#analysis-status", "批量回测");
  setText("#analysis-content", "批量回测请优先查看汇总指标和逐标的结果；可挑选表现最好或最差的标的再做单只股票深度分析。");
  renderRows(
    (data.results || []).map((row) => ({
      代码: row.symbol,
      名称: row.name,
      总收益: percent(row.total_return),
      基准收益: percent(row.benchmark_return),
      超额收益: percent(row.excess_return),
      最大回撤: percent(row.max_drawdown),
      交易次数: row.trade_count,
      胜率: row.win_rate == null ? "--" : percent(row.win_rate),
      K线数: row.bar_count,
    })),
    "股票池逐标的结果"
  );
}

function resetMetrics() {
  ["#metric-return", "#metric-dd", "#metric-equity", "#metric-trades"].forEach((selector) => {
    setText(selector, "--");
    setClass(selector, "");
  });
}

function renderRows(rows, title, tablePrefix = "") {
  setText(`#${tablePrefix}table-title`, title);
  setText(`#${tablePrefix}table-count`, `${rows.length} 条`);
  
  const headEl = document.getElementById(`${tablePrefix}table-head`) || tableHead;
  const bodyEl = document.getElementById(`${tablePrefix}table-body`) || tableBody;
  
  headEl.innerHTML = "";
  bodyEl.innerHTML = "";

  if (!rows.length) {
    bodyEl.innerHTML = "<tr><td>暂无数据</td></tr>";
    return;
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  ).slice(0, 12);
  headEl.innerHTML = `<tr>${columns.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr>`;
  bodyEl.innerHTML = rows
    .map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>`)
    .join("");
}

function renderSelectorRows(rows, meta = {}) {
  setText("#selector-table-title", "选股结果");
  const total = Number(meta.code_count || rows.length);
  const page = Number(document.querySelector('#selector-form input[name="page"]')?.value || 1);
  const limit = Number(document.querySelector('#selector-form input[name="limit"]')?.value || 10);
  const totalPages = total > 0 ? Math.ceil(total / Math.max(1, limit)) : 1;
  setText("#selector-table-count", `${rows.length} / ${total} 只`);
  if (selectorMeta) selectorMeta.classList.remove("hidden");
  setHtml(
    "#selector-meta",
    `<div><span>code_count</span><strong>${escapeHtml(total)}</strong></div>
    <div><span>当前页</span><strong>${escapeHtml(`${page} / ${totalPages}`)}</strong></div>
    <div><span>chunks_info</span><strong>${escapeHtml(formatChunksInfo(meta.chunks_info))}</strong></div>
  `
  );
  document.getElementById("selector-table-head").innerHTML = "";
  document.getElementById("selector-table-body").innerHTML = "";
  document.querySelector("#selector-select-all-rows").classList.toggle("hidden", rows.length === 0);

  if (!rows.length) {
    document.getElementById("selector-table-body").innerHTML = "<tr><td>暂无数据</td></tr>";
    return;
  }

  const dataColumns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row.raw || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const columns = ["选择", ...dataColumns];
  document.getElementById("selector-table-head").innerHTML = `<tr>${columns.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr>`;
  document.getElementById("selector-table-body").innerHTML = rows
    .map(
      (row) => `<tr>
        <td><input class="selector-check" type="checkbox" value="${escapeHtml(row.code)}" checked></td>
        ${dataColumns.map((key) => `<td>${escapeHtml(row.raw[key])}</td>`).join("")}
      </tr>`
    )
    .join("");
}

function formatChunksInfo(value) {
  if (Array.isArray(value)) return value.join("；");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value !== "string") return value ?? "--";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join("；") : value;
  } catch {
    return value || "--";
  }
}

function normalizeSelectorRows(rows) {
  return rows
    .map((row) => {
      const code = pickValue(row, ["股票代码", "代码", "证券代码", "code"], ["代码", "code"]);
      const name = pickValue(row, ["股票简称", "股票名称", "名称", "name"], ["简称", "名称", "name"]);
      const price = pickValue(row, ["最新价", "现价", "收盘价", "close"], ["最新价", "现价", "收盘", "close"]);
      const change = pickValue(row, ["涨跌幅", "最新涨跌幅", "change"], ["涨跌幅", "change"]);
      return { code, name, price, change, raw: row };
    })
    .filter((row) => row.code);
}

function pickValue(row, exactKeys, fuzzyKeys) {
  for (const key of exactKeys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  const entries = Object.entries(row || {});
  const found = entries.find(([key, value]) => {
    const lowered = String(key).toLowerCase();
    return value !== undefined && value !== null && value !== "" && fuzzyKeys.some((token) => lowered.includes(token.toLowerCase()));
  });
  return found ? found[1] : "";
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === name);
  });
  document.querySelectorAll(".form-view").forEach((item) => item.classList.remove("active"));
  document.querySelector(`#${name}-form`).classList.add("active");
  const titles = { query: "接口数据", selector: "自然语言选股", backtest: "策略表现" };
  setText("#page-title", titles[name] || "策略表现");
  syncPageSections(name);
}

function syncPageSections(tabName) {
  const isBacktest = tabName === "backtest";
  const isDashboard = tabName === "dashboard";
  const isQuery = tabName === "query";
  const isSelector = tabName === "selector";
  
  document.querySelectorAll(".backtest-only").forEach((section) => {
    section.classList.toggle("hidden", !isBacktest);
  });
  
  document.querySelectorAll(".dashboard-only").forEach((section) => {
    section.classList.toggle("hidden", !isDashboard);
  });

  document.querySelectorAll(".query-only").forEach((section) => {
    section.classList.toggle("hidden", !isQuery);
  });

  document.querySelectorAll(".selector-only").forEach((section) => {
    section.classList.toggle("hidden", !isSelector);
  });

  if (!isBacktest) hideTooltip();
  
  // 首次切换到 dashboard 自动刷新数据（如果为空的话）
  if (isDashboard) {
    const timeSpan = document.getElementById("market-update-time").textContent;
    if (timeSpan === "等待查询") {
      refreshDashboard();
    }
  }
}

function drawChart(points) {
  lastEquityCurve = points;
  const rect = chart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  chart.width = Math.max(600, Math.floor(rect.width * scale));
  chart.height = Math.floor(320 * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const width = chart.width / scale;
  const height = chart.height / scale;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111823"; // bg-surface
  ctx.fillRect(0, 0, width, height);

  const pad = { left: 54, right: 18, top: 18, bottom: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  equityLayout = { width, height, pad, innerW, innerH };

  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  if (!points.length) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px JetBrains Mono, Consolas, monospace";
    ctx.fillText("运行回测后显示权益曲线", pad.left, pad.top + 28);
    return;
  }

  const values = points.map((point) => Number(point.equity));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  ctx.strokeStyle = "#00f0ff";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = pad.left + (innerW * index) / Math.max(1, points.length - 1);
    const y = pad.top + innerH - ((Number(point.equity) - min) / span) * innerH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px JetBrains Mono, Consolas, monospace";
  ctx.fillText(money(max), 6, pad.top + 6);
  ctx.fillText(money(min), 6, pad.top + innerH);
  ctx.fillText(points[0].date, pad.left, height - 10);
  ctx.fillText(points[points.length - 1].date, Math.max(pad.left, width - 100), height - 10);
}

function drawKlineChart(bars, trades) {
  // div 模式下没有 canvas 上下文，K 线由 Lightweight Charts 接管
  if (!kctx) return;
  lastBars = bars;
  lastTrades = trades;
  const rect = klineChart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  klineChart.width = Math.max(680, Math.floor(rect.width * scale));
  klineChart.height = Math.floor(380 * scale);
  kctx.setTransform(scale, 0, 0, scale, 0, 0);

  const width = klineChart.width / scale;
  const height = klineChart.height / scale;
  const pad = { left: 58, right: 22, top: 18, bottom: 38 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  klineLayout = { width, height, pad, innerW, innerH };

  kctx.clearRect(0, 0, width, height);
  kctx.fillStyle = "#111823";
  kctx.fillRect(0, 0, width, height);

  kctx.strokeStyle = "#1e293b";
  kctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    kctx.beginPath();
    kctx.moveTo(pad.left, y);
    kctx.lineTo(width - pad.right, y);
    kctx.stroke();
  }

  if (!bars.length) {
    kctx.fillStyle = "#94a3b8";
    kctx.font = "14px JetBrains Mono, Consolas, monospace";
    kctx.fillText("运行回测后显示K线与买卖点", pad.left, pad.top + 28);
    return;
  }

  const highs = bars.map((bar) => Number(bar.high ?? bar.close));
  const lows = bars.map((bar) => Number(bar.low ?? bar.close));
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;
  const step = innerW / bars.length;
  const candleW = Math.max(3, Math.min(12, step * 0.62));
  const tradeByDate = new Map();

  trades.forEach((trade) => {
    if (!tradeByDate.has(trade.date)) tradeByDate.set(trade.date, []);
    tradeByDate.get(trade.date).push(trade);
  });

  bars.forEach((bar, index) => {
    const open = Number(bar.open ?? bar.close);
    const close = Number(bar.close);
    const high = Number(bar.high ?? Math.max(open, close));
    const low = Number(bar.low ?? Math.min(open, close));
    const x = pad.left + step * index + step / 2;
    const yHigh = priceY(high, min, span, pad, innerH);
    const yLow = priceY(low, min, span, pad, innerH);
    const yOpen = priceY(open, min, span, pad, innerH);
    const yClose = priceY(close, min, span, pad, innerH);
    const rising = close >= open;
    const color = rising ? "#ff3366" : "#00e572";

    kctx.strokeStyle = color;
    kctx.fillStyle = color;
    kctx.beginPath();
    kctx.moveTo(x, yHigh);
    kctx.lineTo(x, yLow);
    kctx.stroke();

    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(2, Math.abs(yOpen - yClose));
    if (rising) {
      kctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    } else {
      kctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
    }

    const dayTrades = tradeByDate.get(bar.date) || [];
    dayTrades.forEach((trade) => {
      const isBuy = trade.side === "买入";
      const markerY = isBuy ? yLow + 16 : yHigh - 16;
      drawTradeMarker(kctx, x, markerY, isBuy);
    });
  });

  kctx.fillStyle = "#94a3b8";
  kctx.font = "12px JetBrains Mono, Consolas, monospace";
  kctx.fillText(money(max), 6, pad.top + 6);
  kctx.fillText(money(min), 6, pad.top + innerH);
  kctx.fillText(bars[0].date, pad.left, height - 12);
  kctx.fillText(bars[bars.length - 1].date, Math.max(pad.left, width - 100), height - 12);
  drawLegend(kctx, width, pad.top);
}

function handleEquityHover(event) {
  if (!lastEquityCurve.length || !equityLayout) {
    hideTooltip();
    return;
  }
  const { x } = canvasPoint(event, chart);
  const { pad, innerW } = equityLayout;
  const index = nearestIndex(x, pad.left, innerW, lastEquityCurve.length);
  const point = lastEquityCurve[index];
  showTooltip(event, [
    ["日期", point.date],
    ["权益", money(point.equity)],
    ["收盘", money(point.close)],
    ["持仓", point.position],
    ["信号", signalText(point.signal)],
  ]);
}

function handleKlineHover(event) {
  if (!lastBars.length || !klineLayout) {
    hideTooltip();
    return;
  }
  const { x } = canvasPoint(event, klineChart);
  const { pad, innerW } = klineLayout;
  const index = Math.max(0, Math.min(lastBars.length - 1, Math.floor((x - pad.left) / (innerW / lastBars.length))));
  const bar = lastBars[index];
  const trades = lastTrades.filter((trade) => trade.date === bar.date);
  const tradeText = trades.length
    ? trades.map((trade) => `${trade.side} ${trade.shares}股 @ ${money(trade.price)}`).join(" / ")
    : "无";
  showTooltip(event, [
    ["日期", bar.date],
    ["开盘", money(bar.open ?? bar.close)],
    ["最高", money(bar.high ?? bar.close)],
    ["最低", money(bar.low ?? bar.close)],
    ["收盘", money(bar.close)],
    ["成交量", money(bar.volume)],
    ["交易", tradeText],
  ]);
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function nearestIndex(x, left, width, count) {
  const ratio = (x - left) / Math.max(1, width);
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

function showTooltip(event, rows) {
  const [first, ...rest] = rows;
  tooltip.innerHTML = `<strong>${escapeHtml(first[1])}</strong>${rest
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
    .join("")}`;
  tooltip.style.display = "block";

  const margin = 14;
  const rect = tooltip.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;
  if (left + rect.width > window.innerWidth - margin) {
    left = event.clientX - rect.width - margin;
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = event.clientY - rect.height - margin;
  }
  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function hideTooltip() {
  tooltip.style.display = "none";
}

function signalText(signal) {
  if (signal === "buy") return "买入";
  if (signal === "sell") return "卖出";
  return "持有";
}

function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let quoteLines = [];
  let tableLines = [];
  let codeLines = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      html.push(`<ul>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      listItems = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      html.push(`<blockquote>${quoteLines.map((item) => `<p>${inlineMarkdown(item)}</p>`).join("")}</blockquote>`);
      quoteLines = [];
    }
  };
  const flushTable = () => {
    if (tableLines.length) {
      html.push(renderMarkdownTable(tableLines));
      tableLines = [];
    }
  };
  const flushCode = () => {
    if (codeLines.length) {
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = [];
    }
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushBlocks();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }

    if (!line.trim()) {
      flushBlocks();
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    if (/^\|.+\|$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      tableLines.push(line.trim());
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      flushTable();
      listItems.push((bullet || ordered)[1]);
      return;
    }

    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      flushTable();
      quoteLines.push(quote[1]);
      return;
    }

    flushList();
    flushQuote();
    flushTable();
    paragraph.push(line.trim());
  });

  if (inCode) flushCode();
  flushBlocks();
  return html.join("");
}

function renderMarkdownTable(lines) {
  const rows = lines
    .filter((line) => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return `<div class="markdown-table-wrap"><table><thead><tr>${head
    .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function priceY(price, min, span, pad, innerH) {
  return pad.top + innerH - ((price - min) / span) * innerH;
}

function drawTradeMarker(context, x, y, isBuy) {
  context.save();
  context.fillStyle = isBuy ? "#ff3366" : "#00e572";
  context.beginPath();
  if (isBuy) {
    context.moveTo(x, y - 8);
    context.lineTo(x - 7, y + 6);
    context.lineTo(x + 7, y + 6);
  } else {
    context.moveTo(x, y + 8);
    context.lineTo(x - 7, y - 6);
    context.lineTo(x + 7, y - 6);
  }
  context.closePath();
  context.fill();
  context.fillStyle = "#0b0f19";
  context.font = "10px JetBrains Mono, Consolas, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(isBuy ? "B" : "S", x, y + (isBuy ? 2 : -1));
  context.restore();
}

function drawLegend(context, width, y) {
  context.save();
  context.font = "12px JetBrains Mono, Consolas, monospace";
  context.fillStyle = "#ff3366";
  context.fillRect(width - 170, y, 10, 10);
  context.fillStyle = "#94a3b8";
  context.fillText("上涨", width - 154, y + 10);
  context.strokeStyle = "#00e572";
  context.strokeRect(width - 104, y, 10, 10);
  context.fillStyle = "#94a3b8";
  context.fillText("下跌", width - 88, y + 10);
  context.restore();
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

function setHtml(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.innerHTML = value;
}

function setClass(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.className = value;
}

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function numberOrDash(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

function formatPercentText(value) {
  if (value === null || value === undefined || value === "--" || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("resize", () => {
  drawChart(lastEquityCurve);
  drawKlineChart(lastBars, lastTrades);
});
setDefaultDateRange();
syncStrategyFields();
syncModeFields();
syncPageSections("dashboard");
drawChart([]);
drawKlineChart([], []);

function syncStrategyFields() {
  const strategy = document.querySelector("#strategy-select").value;
  document.querySelectorAll("[data-strategy-field]").forEach((input) => {
    const visible = input.dataset.strategyField.split(/\s+/).includes(strategy);
    input.closest("label").style.display = visible ? "grid" : "none";
  });
}

function syncModeFields() {
  const mode = document.querySelector("#mode-select").value;
  document.querySelectorAll("[data-mode-field]").forEach((input) => {
    const visible = input.dataset.modeField === mode;
    input.closest("label").style.display = visible ? "grid" : "none";
  });
}
// ======================== Dashboard 逻辑 ========================

// 获取本地存储的自选股列表
function getWatchlist() {
  const w = localStorage.getItem("quant_watchlist");
  return w ? JSON.parse(w) : ["宁德时代", "同花顺", "比亚迪"]; // 默认几只作为演示
}

// 渲染自选股与大盘数据
async function refreshDashboard(silent = false) {
  if (!silent) setStatus("正在刷新大盘与自选股数据...");
  
  const watchlist = getWatchlist();
  const watchQuery = watchlist.length
    ? `${watchlist.join(" ")} 最新价、涨跌幅、开盘价、收盘价、量比、换手率`
    : "";
  
  try {
    // 并发查询大盘和自选股
    const [marketData, watchData] = await Promise.all([
      postJson(window.API_BASE + "/api/query", { query: "上证指数 深证成指 创业板指 最新行情", limit: 3 }),
      watchQuery
        ? postJson(window.API_BASE + "/api/query", { query: watchQuery, limit: Math.max(1, watchlist.length) })
        : Promise.resolve({ datas: [] })
    ]);
    
    // 更新大盘卡片
    const marketContainer = document.getElementById("market-indices-container");
    if (marketData.datas && marketData.datas.length > 0) {
      marketContainer.textContent = "";
      marketData.datas.forEach(row => {
        const fuzzyFind = (keywords) => {
          if (!Array.isArray(keywords)) keywords = [keywords];
          for (const kw of keywords) {
            const matchedKey = Object.keys(row).find(k => k.includes(kw));
            if (matchedKey && row[matchedKey] !== null) {
               return row[matchedKey];
            }
          }
          return "--";
        };

        const name = row["股票简称"] || row["指数简称"] || "--";
        let price = fuzzyFind(["最新价", "收盘价"]);
        let pct = fuzzyFind(["涨跌幅", "涨幅"]);
        
        if (typeof price === "object") price = Object.values(price)[0] || "--";
        if (typeof pct === "object") pct = Object.values(pct)[0] || "--";
        
        let pctColor = "var(--text-primary)";
        if (parseFloat(pct) > 0) pctColor = "var(--risk-color)";
        else if (parseFloat(pct) < 0) pctColor = "var(--safe-color)";
        
        marketContainer.appendChild(createMarketCard(name, money(price), formatPercentText(pct), pctColor));
      });
      
      const now = new Date();
      document.getElementById("market-update-time").textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} 更新`;
    }
    
    // 更新自选股列表
    const watchBody = document.getElementById("watchlist-body");
    
    let currentWatchlist = watchlist;
    document.getElementById("watchlist-count").textContent = `${currentWatchlist.length} 只`;
    
    if (watchData.datas && watchData.datas.length > 0) {
      watchBody.textContent = "";
      watchData.datas.forEach(row => {
        const code = row["code"] || row["股票代码"] || "--";
        const name = row["股票简称"] || "--";
        
        // 模糊匹配字段，因为问财返回的 key 往往带有日期或复权信息后辍 (例: "收盘价:不复权[20240506]")
        const fuzzyFind = (keywords) => {
          if (!Array.isArray(keywords)) keywords = [keywords];
          for (const kw of keywords) {
            const matchedKey = Object.keys(row).find(k => k.includes(kw));
            if (matchedKey && row[matchedKey] !== null) {
               return row[matchedKey];
            }
          }
          return "--";
        };

        let price = fuzzyFind(["最新价", "收盘价"]);
        let pct = fuzzyFind(["涨跌幅"]);
        let open = fuzzyFind(["开盘价"]);
        let close = fuzzyFind(["收盘价"]);
        let volumeRatio = fuzzyFind(["量比"]);
        let turnover = fuzzyFind(["换手率"]);

        // 如果获取到的是对象形态，进一步解包
        if (typeof pct === "object") pct = Object.values(pct)[0] || "--";
        if (typeof price === "object") price = Object.values(price)[0] || "--";
        if (typeof open === "object") open = Object.values(open)[0] || "--";
        if (typeof close === "object") close = Object.values(close)[0] || "--";
        if (typeof volumeRatio === "object") volumeRatio = Object.values(volumeRatio)[0] || "--";
        if (typeof turnover === "object") turnover = Object.values(turnover)[0] || "--";

        let pctColor = "inherit";
        if (parseFloat(pct) > 0) pctColor = "var(--risk-color)";
        else if (parseFloat(pct) < 0) pctColor = "var(--safe-color)";

        watchBody.appendChild(createWatchlistRow({
          code,
          name,
          price: money(price),
          pct: formatPercentText(pct),
          open: money(open),
          close: money(close),
          volumeRatio: numberOrDash(volumeRatio, 2),
          turnover: formatPercentText(turnover),
          pctColor,
        }));
      });
      
      document.querySelectorAll(".btn-remove-watchlist").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const symbolToRemove = e.target.dataset.symbol;
          const newW = getWatchlist().filter(w => w !== symbolToRemove);
          localStorage.setItem("quant_watchlist", JSON.stringify(newW));
          refreshDashboard();
        });
      });
    } else {
      renderTableMessage(watchBody, watchlist.length ? "未能获取到行情数据，请检查自选股名称或稍后再试" : "暂无自选股，请在左侧添加", 9);
    }
    
    if (!silent) setStatus("首页数据已更新");
  } catch (err) {
    if (watchlist.length === 0) {
      renderTableMessage(document.getElementById("watchlist-body"), "暂无自选股，请在左侧添加", 9);
      if (!silent) setStatus("已清空");
    } else {
      if (!silent) setStatus("刷新失败: " + err.message);
    }
  }
}

function createMarketCard(name, price, pct, pctColor) {
  const card = document.createElement("div");
  card.style.padding = "16px";
  card.style.background = "var(--bg-surface)";
  card.style.borderRadius = "8px";
  card.style.border = "1px solid var(--border-color)";
  card.style.textAlign = "center";

  const nameEl = document.createElement("div");
  nameEl.style.fontSize = "14px";
  nameEl.style.color = "var(--text-secondary)";
  nameEl.style.marginBottom = "8px";
  nameEl.textContent = name;

  const priceEl = document.createElement("div");
  priceEl.style.fontSize = "24px";
  priceEl.style.fontWeight = "600";
  priceEl.style.color = pctColor;
  priceEl.textContent = price;

  const pctEl = document.createElement("div");
  pctEl.style.fontSize = "14px";
  pctEl.style.color = pctColor;
  pctEl.textContent = pct;

  card.append(nameEl, priceEl, pctEl);
  return card;
}

function createWatchlistRow(row) {
  const tr = document.createElement("tr");
  appendCell(tr, row.code, { family: "monospace" });
  appendCell(tr, row.name);
  appendCell(tr, row.price, { color: row.pctColor, weight: "500" });
  appendCell(tr, row.pct, { color: row.pctColor });
  appendCell(tr, row.open);
  appendCell(tr, row.close);
  appendCell(tr, row.volumeRatio);
  appendCell(tr, row.turnover);

  const actionCell = document.createElement("td");
  const button = document.createElement("button");
  button.className = "inline-action btn-remove-watchlist";
  button.dataset.symbol = row.name;
  button.type = "button";
  button.textContent = "删除";
  actionCell.appendChild(button);
  tr.appendChild(actionCell);
  return tr;
}

function appendCell(tr, text, options = {}) {
  const td = document.createElement("td");
  td.textContent = text;
  if (options.className) td.className = options.className;
  if (options.family) td.style.fontFamily = options.family;
  if (options.color) td.style.color = options.color;
  if (options.weight) td.style.fontWeight = options.weight;
  tr.appendChild(td);
}

function renderTableMessage(tbody, message, colspan) {
  if (!tbody) return;
  tbody.textContent = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colspan;
  td.style.textAlign = "center";
  td.style.color = "var(--text-tertiary)";
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// 绑定添加自选股事件
document.getElementById("btn-add-watchlist-side").addEventListener("click", () => {
  const input = document.getElementById("new-watchlist-symbol");
  const symbol = input.value.trim();
  if (!symbol) return;
  
  const w = getWatchlist();
  if (!w.includes(symbol)) {
    w.push(symbol);
    localStorage.setItem("quant_watchlist", JSON.stringify(w));
    refreshDashboard();
  }
  input.value = "";
});

// 手动刷新按钮
const btnRefreshDash = document.getElementById("btn-refresh-dashboard");
if (btnRefreshDash) {
  btnRefreshDash.addEventListener("click", refreshDashboard);
}

// 快捷批量回测自选股
const btnBatchWatchlist = document.getElementById("btn-batch-backtest-watchlist");
if (btnBatchWatchlist) {
  btnBatchWatchlist.addEventListener("click", () => {
    const w = getWatchlist();
    if (w.length === 0) {
      alert("自选股为空，请先添加");
      return;
    }
    // 切换到回测标签页，填入参数
    const tabBacktest = document.querySelector('.tab[data-tab="backtest"]');
    if (tabBacktest) tabBacktest.click();
    
    const modeSelect = document.querySelector("#mode-select");
    modeSelect.value = "batch";
    syncModeFields();
    
    const universeSelect = document.querySelector('select[name="universe"]');
    universeSelect.value = "custom";
    
    const symbolsArea = document.querySelector('textarea[name="symbols"]');
    symbolsArea.value = w.join(", ");
    
    // 触发回测
    document.querySelector("#backtest-form").dispatchEvent(new Event("submit"));
  });
}
function setDefaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);

  const startInput = document.querySelector('input[name="start_date"]');
  const endInput = document.querySelector('input[name="end_date"]');
  if (startInput && !startInput.value) startInput.value = formatDate(start);
  if (endInput && !endInput.value) endInput.value = formatDate(end);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}



  

  const btnOptimize = document.getElementById("btn-optimize");
  if (btnOptimize) {
    btnOptimize.addEventListener("click", async () => {
      setStatus("正在进行参数网格寻优...");
      const form = document.querySelector("#backtest-form");
      const payload = formPayload(form);
      const strategy = payload.strategy;

      let param_ranges = {};

      if (strategy === "moving_average") {
        param_ranges = { fast_window: [3, 5, 7], slow_window: [15, 20, 30] };
      } else if (strategy === "momentum_atr") {
        param_ranges = { breakout_window: [15, 20, 25], atr_multiplier: [1.5, 2.0, 2.5] };
      } else if (strategy === "ma_rsi") {
        param_ranges = { fast_window: [5, 10], slow_window: [20, 30], rsi_window: [6, 14], buy_rsi: [30, 40], sell_rsi: [60, 70] };
      } else if (strategy === "channel_reversal") {
        param_ranges = { channel_window: [5, 6, 10, 15], stop_loss_pct: [0.03, 0.05, 0.08] };
      } else if (strategy === "volume_shadow_break") {
        param_ranges = {
          volume_window: [2, 3, 4],
          volume_multiplier: [1.1, 1.2, 1.3, 1.4],
          sell_volume_multiplier: [1.01, 1.03, 1.05],
          upper_shadow_ratio: [0.1, 0.15, 0.2],
          lower_shadow_ratio: [0.2, 0.3, 0.4],
          ma_window: [3, 5, 8]
        };
      }

      payload.param_ranges = param_ranges;

      // 寻优前给用户一个可见的预估（避免默认 972 组合撞墙）
      const nCombos = Object.values(param_ranges).reduce((acc, arr) => acc * (arr?.length || 1), 1);
      const MAX_DEFAULT = 2000;
      const nJobs = navigator.hardwareConcurrency || 4;
      // 经验值：单组合 ~30-80ms（含 IO 拉取），并行 4-16 核
      const estMs = Math.ceil((nCombos * 50) / Math.max(2, nJobs / 2));
      const estSec = Math.max(1, Math.round(estMs / 1000));
      const warn = nCombos > MAX_DEFAULT
        ? `\n\n⚠️ 超过默认上限 ${MAX_DEFAULT}，将一并发送 max_combinations=${Math.ceil(nCombos * 1.2)}`
        : "";
      if (!window.confirm(
        `即将进行参数网格寻优：\n` +
        `• 策略：${strategy}\n` +
        `• 组合数：${nCombos}\n` +
        `• 预估耗时：约 ${estSec} 秒${warn}\n\n` +
        `是否继续？`
      )) {
        setStatus("已取消寻优");
        return;
      }
      // 客户端传一个略大于组合数的覆盖值，避免后端再校验失败
      if (nCombos > MAX_DEFAULT) {
        payload.max_combinations = Math.ceil(nCombos * 1.2);
      }

      try {
        const res = await postJson(window.API_BASE + "/api/optimize", payload);

        setText("#table-title", "参数网格寻优结果 (总收益逆序)");
        setText("#table-count", `${res.optimization_results.length} 条组合，${(res.optimization_errors || []).length} 条失败`);

        const thead = document.querySelector("#table-head");
        const tbody = document.querySelector("#table-body");

        thead.innerHTML = `<tr><th>参数组合</th><th>总收益</th><th>年化收益</th><th>最大回撤</th><th>夏普比率</th><th>胜率</th><th>交易次数</th></tr>`;
        tbody.innerHTML = "";

        res.optimization_results.forEach(r => {
          const tr = document.createElement("tr");
          appendCell(tr, JSON.stringify(r.params));
          appendCell(tr, percent(r.total_return), { className: r.total_return >= 0 ? "up" : "down" });
          appendCell(tr, percent(r.annual_return), { className: r.annual_return >= 0 ? "up" : "down" });
          appendCell(tr, percent(r.max_drawdown));
          appendCell(tr, numberOrDash(r.sharpe_ratio, 2));
          appendCell(tr, percent(r.win_rate));
          appendCell(tr, r.trade_count ?? "--");
          tbody.appendChild(tr);
        });

        // 新增：参数寻优热力图
        try {
          renderOptimizeResult(res);
        } catch (e) {
          console.error("寻优热力图渲染失败", e);
        }

        setStatus(`寻优完成 · ${res.combinations} 组合 · ${res.parallel ? "并行 " + res.n_jobs + " 核" : "顺序"}`);
      } catch (err) {
        setStatus(`寻优失败: ${err.message}`);
      }
    });
  }

// --- 盘中定时刷新首页数据 ---
function isTradingTime() {
  const now = new Date();
  const day = now.getDay();
  // 排除周末
  if (day === 0 || day === 6) return false;
  
  const time = now.getHours() * 100 + now.getMinutes();
  // 盘中：9点半到11点半 (930-1130)
  const isMorning = time >= 930 && time <= 1130;
  // 盘中：1点半到3点半 (1330-1530)
  const isAfternoon = time >= 1330 && time <= 1530;
  
  return isMorning || isAfternoon;
}

// 每隔1分钟执行一次
setInterval(() => {
  if (isTradingTime()) {
    const activeTab = document.querySelector('.tab.active');
    const isDashActive = activeTab && activeTab.dataset.tab === 'dashboard';
    // 如果不在首页，静默刷新以免打扰用户看回测状态
    refreshDashboard(!isDashActive);
  }
}, 60 * 1000);

// --- 记忆功能：记住表单数据 ---
const FORMS_TO_REMEMBER = ["backtest-form", "query-form", "selector-form"];
const BACKTEST_FORM_VERSION = "2026-05-21-volume-shadow-tuned";
const VOLUME_SHADOW_DEFAULTS = {
  volume_window: "3",
  volume_multiplier: "1.1",
  sell_volume_multiplier: "1.05",
  upper_shadow_ratio: "0.1",
  lower_shadow_ratio: "0.2",
  ma_window: "3",
};

function saveFormState(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const payload = {};
  new FormData(form).forEach((value, key) => {
    payload[key] = String(value).trim();
  });
  localStorage.setItem(`quant_form_${formId}`, JSON.stringify(payload));
}

function restoreFormState(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const saved = localStorage.getItem(`quant_form_${formId}`);
  if (!saved) return;
  try {
    const payload = JSON.parse(saved);
    if (formId === "backtest-form") {
      const savedVersion = localStorage.getItem("quant_backtest_form_version");
      if (savedVersion !== BACKTEST_FORM_VERSION) {
        Object.assign(payload, VOLUME_SHADOW_DEFAULTS);
        localStorage.setItem("quant_backtest_form_version", BACKTEST_FORM_VERSION);
        localStorage.setItem(`quant_form_${formId}`, JSON.stringify(payload));
      }
    }
    Object.keys(payload).forEach(key => {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        input.value = payload[key];
      }
    });
  } catch (e) {
    console.error("恢复表单数据失败", e);
  }
}

FORMS_TO_REMEMBER.forEach(formId => {
  const form = document.getElementById(formId);
  if (form) {
    // 初始恢复
    restoreFormState(formId);
    // 监听变化
    form.addEventListener("change", () => saveFormState(formId));
    form.addEventListener("input", () => saveFormState(formId));
  }
});
// 初始化完成后更新一次依赖联动
syncModeFields();
syncStrategyFields();


// =============================================================================
// TradingView Lightweight Charts K 线（CDN 失败时回退到 drawKlineChart）
// =============================================================================

let _lwcChart = null;
let _lwcCandleSeries = null;
let _lwcVolumeSeries = null;
let _lwcResizeHooked = false;
let _lwcReadyPromise = null;
let _lwcResizeObserver = null;

function _hasLightweightCharts() {
  return typeof window.LightweightCharts !== "undefined" || typeof LightweightCharts !== "undefined";
}

// 等待 lightweight-charts 脚本加载完成（defer 模式在 DOMContentLoaded 前完成）
function _ensureLightweightCharts() {
  if (_hasLightweightCharts()) return Promise.resolve(true);
  if (_lwcReadyPromise) return _lwcReadyPromise;
  _lwcReadyPromise = new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (_hasLightweightCharts()) return resolve(true);
      if (Date.now() - start > 5000) return resolve(false);
      setTimeout(check, 80);
    };
    check();
  });
  return _lwcReadyPromise;
}

function _lwcCreate() {
  if (!_hasLightweightCharts()) return false;
  const lib = window.LightweightCharts || LightweightCharts;
  const container = document.getElementById("kline-chart");
  if (!container) return false;
  container.innerHTML = "";
  const initialWidth = Math.max(800, container.clientWidth || 0);
  _lwcChart = lib.createChart(container, {
    width: initialWidth,
    height: 460,
    layout: { background: { color: "#111823" }, textColor: "#94a3b8" },
    grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
    timeScale: { borderColor: "#1e293b", timeVisible: false, secondsVisible: false },
    rightPriceScale: { borderColor: "#1e293b" },
  });
  _lwcCandleSeries = _lwcChart.addCandlestickSeries({
    upColor: "#ff3366",
    downColor: "#00e572",
    wickColor: "#94a3b8",
    borderColor: "#94a3b8",
  });
  _lwcVolumeSeries = null;
  return true;
}

async function renderKlineLightweight(bars, trades) {
  if (!bars || !bars.length) {
    if (typeof drawKlineChart === "function") drawKlineChart([], []);
    return;
  }
  const ready = await _ensureLightweightCharts();
  if (!ready || !_lwcCreate()) {
    // CDN 不可用：div 模式下插入提示；canvas 模式回退内置绘制
    if (klineChart.tagName !== "CANVAS") {
      klineChart.innerHTML =
        '<p class="placeholder" style="padding:32px;text-align:center;color:var(--text-tertiary);">K 线加载失败：第三方 CDN 不可用，请检查网络后刷新。</p>';
    } else {
      drawKlineChart(bars, trades || []);
    }
    return;
  }
  const candleData = bars.map((bar) => {
    // lightweight-charts 时间戳用 YYYY-MM-DD 字符串（业务日）或 Unix 秒
    const date = String(bar.date);
    const o = Number(bar.open ?? bar.close);
    const c = Number(bar.close);
    const h = Number(bar.high ?? Math.max(o, c));
    const l = Number(bar.low ?? Math.min(o, c));
    return { time: date, open: o, high: h, low: l, close: c };
  });
  try {
    _lwcCandleSeries.setData(candleData);
  } catch (e) {
    console.error("[K线] setData 失败", e);
    klineChart.innerHTML =
      '<p class="placeholder" style="padding:32px;color:var(--text-tertiary);">K 线数据写入失败：' +
      String(e && e.message ? e.message : e) + '</p>';
    return;
  }

  const volData = bars.map((bar) => {
    const v = Number(bar.volume ?? 0);
    const c = Number(bar.close);
    const o = Number(bar.open ?? c);
    return {
      time: String(bar.date),
      value: v,
      color: c >= o ? "rgba(255,51,102,0.55)" : "rgba(0,229,114,0.55)",
    };
  });
  if (_lwcVolumeSeries) {
    try { _lwcVolumeSeries.setData(volData); } catch (e) { console.warn("volData setData 失败", e); }
  }

  // 买卖点标记
  const markers = [];
  const tradeByDate = new Map();
  (trades || []).forEach((t) => {
    if (!tradeByDate.has(t.date)) tradeByDate.set(t.date, []);
    tradeByDate.get(t.date).push(t);
  });
  candleData.forEach((cd) => {
    const dayTrades = tradeByDate.get(cd.time) || [];
    dayTrades.forEach((t, idx) => {
      markers.push({
        time: cd.time,
        position: t.side === "买入" ? "belowBar" : "aboveBar",
        color: t.side === "买入" ? "#ff3366" : "#00e572",
        shape: t.side === "买入" ? "arrowUp" : "arrowDown",
        text: t.side,
        // 同一时间多笔交易做垂直偏移
      });
    });
  });
  try {
    if (markers.length) {
      _lwcCandleSeries.setMarkers(markers);
    } else {
      _lwcCandleSeries.setMarkers([]);
    }
  } catch (e) {
    console.warn("[K线] setMarkers 失败（不影响主 K 线）", e);
  }
  try {
    _lwcChart.timeScale().fitContent();
  } catch (e) {
    console.error("[K线] fitContent 失败", e);
  }

  // 关键修复：LWC 4.x 会跳过视口外 chart 的绘制。
  // 第一次 renderBacktest 触发时容器可能还在切 tab / 还没 layout 完成，
  // 需要先把 K 线区域滚到视口内并强制 applyOptions 触发重绘。
  const kcEl = document.getElementById("kline-chart");
  if (kcEl) {
    const rect = kcEl.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      kcEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  // 延迟 100ms 等 scrollIntoView 启动 + LWC 检测可见性变化，再 applyOptions
  setTimeout(() => {
    if (_lwcChart && kcEl) {
      const w = Math.max(800, kcEl.clientWidth || 0);
      _lwcChart.applyOptions({ width: w, height: 460 });
      _lwcChart.timeScale().fitContent();
    }
  }, 100);
  // Resize handling: 监听 window resize + 容器尺寸变化 (tab 切换、panel 展开)
  if (!_lwcResizeHooked) {
    window.addEventListener("resize", () => {
      if (_lwcChart) {
        const c = document.getElementById("kline-chart");
        if (c) _lwcChart.applyOptions({ width: Math.max(800, c.clientWidth || 0) });
      }
    });
    if (!_lwcResizeObserver && "ResizeObserver" in window) {
      _lwcResizeObserver = new ResizeObserver((entries) => {
        if (!_lwcChart) return;
        for (const entry of entries) {
          const w = Math.max(800, entry.contentRect.width || 0);
          _lwcChart.applyOptions({ width: w });
        }
      });
      _lwcResizeObserver.observe(document.getElementById("kline-chart"));
    }
    _lwcResizeHooked = true;
  }
}


// =============================================================================
// Plotly 参数寻优热力图（lazy-load: 4.5MB 不进首屏，点击寻优才加载）
// =============================================================================

let _plotlyLoadPromise = null;

function _ensurePlotly() {
  if (typeof window.Plotly !== "undefined") return Promise.resolve(true);
  if (_plotlyLoadPromise) return _plotlyLoadPromise;
  _plotlyLoadPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.async = true;
    script.onload = () => resolve(typeof window.Plotly !== "undefined");
    script.onerror = () => resolve(false);
    // 30s 加载超时
    setTimeout(() => resolve(typeof window.Plotly !== "undefined"), 30000);
    document.head.appendChild(script);
  });
  return _plotlyLoadPromise;
}

function _renderPlotlyHeatmap(container, data, heatmap, metricLabel) {
  const x = heatmap.x_values.map((v) => String(v));
  const y = heatmap.y_values.map((v) => String(v));
  const z = heatmap.z_values.map((row) =>
    row.map((v) => (v == null ? null : v * 100))
  );
  const trace = {
    x, y, z,
    type: "heatmap",
    colorscale: "RdYlGn",
    reversescale: metricLabel.includes("回撤"),
    hovertemplate: `${heatmap.x_key}=%{x}<br>${heatmap.y_key}=%{y}<br>${metricLabel}=%{z:.2f}%<extra></extra>`,
    colorbar: { title: { text: metricLabel, side: "right" } },
  };
  const layout = {
    title: `${data.strategy} · ${metricLabel} 热力图<br><sub>${data.combinations} 组合 · ${data.parallel ? "并行 " + data.n_jobs + " 核" : "顺序"}</sub>`,
    xaxis: { title: heatmap.x_key, side: "top" },
    yaxis: { title: heatmap.y_key, autorange: "reversed" },
    paper_bgcolor: "#0b1320",
    plot_bgcolor: "#0b1320",
    font: { color: "#e2e8f0" },
    margin: { l: 80, r: 20, t: 80, b: 20 },
  };
  window.Plotly.newPlot(container, [trace], layout, {
    responsive: true,
    displaylogo: false,
  });
}

async function renderOptimizeResult(data) {
  const container = document.getElementById("optimize-result");
  const toggle = document.getElementById("optimize-metric-toggle");
  if (!container) return;
  container.innerHTML = "";
  if (!data || !data.optimization_results || data.optimization_results.length === 0) {
    container.innerHTML = '<p class="placeholder">点击"参数寻优"按钮，搜索最佳参数组合并以热力图可视化。</p>';
    if (toggle) toggle.hidden = true;
    return;
  }

  const firstParams = data.optimization_results[0].params || {};
  const nParams = Object.keys(firstParams).length;
  // 3+ 参时 toggle 没意义（没有热力图可切）
  if (toggle) toggle.hidden = (nParams >= 3);

  // 状态栏
  const statusParts = [
    `${data.combinations} 组合`,
    data.parallel ? `并行 ${data.n_jobs} 核` : "顺序",
  ];
  if (data.best_by_calmar && data.best_by_return &&
      JSON.stringify(data.best_by_calmar) !== JSON.stringify(data.best_by_return)) {
    statusParts.push("Calmar 最佳与收益最佳不同");
  }
  setText("#optimize-status", statusParts.join(" · "));

  // 分派到 1 / 2 / 3+ 参的不同渲染器
  if (nParams === 1) {
    await _renderOptimizeLineChart(container, data);
  } else if (nParams === 2) {
    await _renderOptimizeHeatmapV2(container, data);
  } else {
    _renderOptimizeImportance(container, data);
    _renderOptimizeRobustTable(container, data);
  }

  // 1 / 2 参下方都附带完整指标表，3+ 参的 RobusTable 已经是 Top 10
  if (nParams <= 2) {
    const sep = document.createElement("div");
    sep.className = "optimize-subtitle";
    sep.textContent = `完整指标表（按总收益降序 · ⭐ 收益最高 · 🎯 Calmar 最高）`;
    container.appendChild(sep);
    _renderOptimizeTable(container, data);
  }
}

// ---- 1 参数折线图 ----
async function _renderOptimizeLineChart(container, data) {
  const results = data.optimization_results;
  const key = Object.keys(results[0].params)[0];
  const xs = results.map((r) => r.params[key]);

  // 不同 metric → 数值数组
  const yByMetric = {};
  OPTIMIZE_METRICS.forEach((m) => {
    yByMetric[m.key] = results.map((r) => r[m.key]);
  });

  // 双重最佳：results[0] = total_return 最高；top_robust[0] = Calmar 最高
  const bestReturn = results[0];
  const bestCalmar = (data.top_robust && data.top_robust[0]) || bestReturn;
  const isDual = bestCalmar !== bestReturn;

  const trace = (metric) => ({
    x: xs,
    y: yByMetric[metric.key].map((v) =>
      v == null ? null : (metric.usePercent ? v * 100 : v)
    ),
    type: "scatter",
    mode: "lines+markers",
    name: metric.label,
    line: { color: metric.higherIsBetter ? "#00f0ff" : "#ff3366", width: 2 },
    marker: { size: 7 },
    hovertemplate: `${key}=%{x}<br>${metric.label}=%{y:.2f}${metric.usePercent ? "%" : ""}<extra></extra>`,
  });

  const annotations = [];
  if (bestReturn && bestReturn.total_return != null) {
    annotations.push({
      x: bestReturn.params[key],
      y: bestReturn.total_return * 100,
      text: "⭐ 收益最高",
      showarrow: true, arrowcolor: "#fcee0a", arrowhead: 2,
      font: { color: "#fcee0a", size: 12 },
      ax: 0, ay: -45,
    });
  }
  if (isDual && bestCalmar && bestCalmar.total_return != null) {
    annotations.push({
      x: bestCalmar.params[key],
      y: bestCalmar.total_return * 100,
      text: "🎯 Calmar 最高",
      showarrow: true, arrowcolor: "#00f0ff", arrowhead: 2,
      font: { color: "#00f0ff", size: 12 },
      ax: 0, ay: 45,
    });
  }

  const ready = await _ensurePlotly();
  if (!ready || !window.Plotly) {
    _renderOptimizeTable(container, data);
    return;
  }

  const div = document.createElement("div");
  div.style.height = "320px";
  container.appendChild(div);

  const baseLayout = (metric) => ({
    title: `${data.strategy} · ${metric.label} vs ${key}<br>` +
           `<sub>${data.combinations} 组合 · ⭐ 收益最高 · 🎯 Calmar 最高</sub>`,
    paper_bgcolor: "#0b1320", plot_bgcolor: "#0b1320",
    font: { color: "#e2e8f0" },
    xaxis: { title: key, gridcolor: "#1e293b" },
    yaxis: {
      title: metric.label + (metric.usePercent ? " %" : ""),
      gridcolor: "#1e293b",
      zerolinecolor: "#334155",
    },
    annotations,
    margin: { t: 80, l: 60, r: 20, b: 50 },
  });

  await window.Plotly.newPlot(
    div, [trace(OPTIMIZE_METRICS[0])], baseLayout(OPTIMIZE_METRICS[0]),
    { responsive: true, displaylogo: false }
  );

  // 切换 metric：react 而不是 newPlot，保留 zoom/pan 状态
  _attachMetricToggle((metric) => {
    window.Plotly.react(div, [trace(metric)], baseLayout(metric), {
      responsive: true, displaylogo: false,
    });
  });
}

// ---- 2 参数热力图（带 metric toggle） ----
async function _renderOptimizeHeatmapV2(container, data) {
  const ready = await _ensurePlotly();
  if (!ready || !window.Plotly) {
    _renderOptimizeTable(container, data);
    return;
  }

  const div = document.createElement("div");
  div.style.height = "420px";
  container.appendChild(div);

  const bestReturn = data.optimization_results[0];
  const bestCalmar = (data.top_robust && data.top_robust[0]) || bestReturn;
  const isDual = bestCalmar !== bestReturn;

  const render = (metric) => {
    const heatmap = data[`heatmap_${metric.key}`];
    if (!heatmap) return;
    const x = heatmap.x_values.map(String);
    const y = heatmap.y_values.map(String);
    const z = heatmap.z_values.map((row) =>
      row.map((v) => (v == null ? null : (metric.usePercent ? v * 100 : v)))
    );
    const traces = [{
      x, y, z, type: "heatmap",
      colorscale: metric.higherIsBetter ? "RdYlGn" : "RdYlGn_r",
      reversescale: !metric.higherIsBetter,
      hovertemplate:
        `${heatmap.x_key}=%{x}<br>${heatmap.y_key}=%{y}<br>` +
        `${metric.label}=%{z:.2f}${metric.usePercent ? "%" : ""}<extra></extra>`,
      colorbar: { title: { text: metric.label, side: "right" } },
    }];
    const annotations = [];
    if (bestReturn && bestReturn.params) {
      annotations.push({
        x: String(bestReturn.params[heatmap.x_key]),
        y: String(bestReturn.params[heatmap.y_key]),
        text: "⭐", showarrow: false,
        font: { size: 22, color: "#fcee0a" },
      });
    }
    if (isDual && bestCalmar && bestCalmar.params) {
      annotations.push({
        x: String(bestCalmar.params[heatmap.x_key]),
        y: String(bestCalmar.params[heatmap.y_key]),
        text: "🎯", showarrow: false,
        font: { size: 20, color: "#00f0ff" },
      });
    }
    window.Plotly.react(div, traces, {
      title: `${data.strategy} · ${metric.label} 热力图<br>` +
             `<sub>${data.combinations} 组合 · ⭐ 收益最高 · 🎯 Calmar 最高</sub>`,
      xaxis: { title: heatmap.x_key, side: "top" },
      yaxis: { title: heatmap.y_key, autorange: "reversed" },
      paper_bgcolor: "#0b1320", plot_bgcolor: "#0b1320",
      font: { color: "#e2e8f0" },
      annotations,
      margin: { t: 80, l: 80, r: 20, b: 20 },
    }, { responsive: true, displaylogo: false });
  };

  render(OPTIMIZE_METRICS[0]);
  _attachMetricToggle(render);
}

// ---- 3+ 参数：参数重要性条形图 ----
function _renderOptimizeImportance(container, data) {
  const importance = data.param_importance || [];
  if (!importance.length) return;

  const title = document.createElement("div");
  title.className = "optimize-subtitle";
  title.textContent = "参数重要性（哪个参数最影响总收益？）";
  container.appendChild(title);

  const wrap = document.createElement("div");
  wrap.className = "importance-wrap";
  container.appendChild(wrap);

  // 按 importance 降序展示
  const sorted = importance.slice().sort((a, b) => b.importance - a.importance);
  sorted.forEach((item) => {
    const bar = document.createElement("div");
    bar.className = "importance-bar";
    const detail = item.values
      .map((v, i) => `${v}=${pct(item.means[i])}`)
      .join("，");
    bar.title = `${item.param} · 重要性 ${item.importance.toFixed(2)}\n各取值平均收益: ${detail}`;
    bar.innerHTML =
      `<div class="name">${escapeHtml(item.param)}</div>` +
      `<div class="track"><div class="fill" style="width: ${(item.importance * 100).toFixed(1)}%"></div></div>` +
      `<div class="val">${item.importance.toFixed(2)}</div>`;
    wrap.appendChild(bar);
  });
}

// ---- 3+ 参数：Top 10 鲁棒表（按 Calmar 排序） ----
function _renderOptimizeRobustTable(container, data) {
  const top = data.top_robust || [];
  if (!top.length) return;

  const title = document.createElement("div");
  title.className = "optimize-subtitle";
  title.textContent = "Top 10 鲁棒组合（按 Calmar 排序）";
  container.appendChild(title);

  const bestReturn = data.best_by_return;
  const bestCalmar = data.best_by_calmar;

  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr>" +
    "<th>#</th><th>参数</th><th>总收益</th><th>最大回撤</th>" +
    "<th>Calmar</th><th>夏普</th><th>胜率</th><th>交易数</th>" +
    "</tr></thead><tbody></tbody>";
  const tbody = table.querySelector("tbody");

  top.forEach((r, i) => {
    const tr = document.createElement("tr");
    const isReturnBest = bestReturn && _paramsEqual(r.params, bestReturn);
    const isCalmarBest = bestCalmar && _paramsEqual(r.params, bestCalmar);
    if (isReturnBest) tr.classList.add("best-combo");
    if (isCalmarBest) tr.classList.add("calmar", "best-combo");

    let rankCell = `<td>${i + 1}`;
    if (isReturnBest) rankCell += ' <span class="gold-star" title="总收益最高">⭐</span>';
    if (isCalmarBest) rankCell += ' <span class="cyan-star" title="Calmar 最高">🎯</span>';
    rankCell += "</td>";

    tr.innerHTML = rankCell +
      `<td><code>${escapeHtml(JSON.stringify(r.params))}</code></td>` +
      `<td class="${(r.total_return != null && r.total_return >= 0) ? "up" : "down"}">${pct(r.total_return)}</td>` +
      `<td>${pct(r.max_drawdown)}</td>` +
      `<td><b>${r.calmar.toFixed(2)}</b></td>` +
      `<td>${numberOrDash(r.sharpe_ratio, 2)}</td>` +
      `<td>${pct(r.win_rate)}</td>` +
      `<td>${r.trade_count ?? "--"}</td>`;
    tbody.appendChild(tr);
  });
  container.appendChild(table);
}

// ---- 完整指标表（1 / 2 参下方使用 + Plotly 失败 fallback） ----
function _renderOptimizeTable(container, data) {
  const results = data.optimization_results || [];
  if (!results.length) {
    container.innerHTML = '<p class="placeholder">无可用结果</p>';
    return;
  }
  const bestReturn = data.best_by_return;
  const bestCalmar = data.best_by_calmar;

  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr>" +
    "<th>参数</th><th>总收益</th><th>年化</th><th>最大回撤</th>" +
    "<th>夏普</th><th>胜率</th><th>交易数</th>" +
    "</tr></thead><tbody></tbody>";
  const tbody = table.querySelector("tbody");

  results.forEach((r) => {
    const tr = document.createElement("tr");
    const isReturnBest = bestReturn && _paramsEqual(r.params, bestReturn);
    const isCalmarBest = bestCalmar && _paramsEqual(r.params, bestCalmar);
    if (isReturnBest) tr.classList.add("best-combo");
    if (isCalmarBest) tr.classList.add("calmar", "best-combo");

    let paramsCell = `<code>${escapeHtml(JSON.stringify(r.params))}</code>`;
    if (isReturnBest) paramsCell = '<span class="gold-star">⭐</span>' + paramsCell;
    if (isCalmarBest) paramsCell = '<span class="cyan-star">🎯</span>' + paramsCell;

    tr.innerHTML = `<td>${paramsCell}</td>` +
      `<td class="${(r.total_return != null && r.total_return >= 0) ? "up" : "down"}">${pct(r.total_return)}</td>` +
      `<td class="${(r.annual_return != null && r.annual_return >= 0) ? "up" : "down"}">${pct(r.annual_return)}</td>` +
      `<td>${pct(r.max_drawdown)}</td>` +
      `<td>${numberOrDash(r.sharpe_ratio, 2)}</td>` +
      `<td>${pct(r.win_rate)}</td>` +
      `<td>${r.trade_count ?? "--"}</td>`;
    tbody.appendChild(tr);
  });
  container.appendChild(table);
}

// 比较两个 param 字典（键顺序无关）。用于"最佳"标记对齐。
function _paramsEqual(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => String(a[k]) === String(b[k]));
}

// 把 section-title 上的按钮组接到 onChange（切换时 react 重画）
function _attachMetricToggle(onChange) {
  const toggle = document.getElementById("optimize-metric-toggle");
  if (!toggle) return;
  toggle.querySelectorAll("button[data-metric]").forEach((btn) => {
    btn.onclick = () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const metric = OPTIMIZE_METRICS.find((m) => m.key === btn.dataset.metric);
      if (metric) onChange(metric);
    };
  });
}

function pct(v) {
  if (v == null || isNaN(v)) return "-";
  return (v * 100).toFixed(2) + "%";
}


// =============================================================================
// 在 renderBacktest 末尾挂接 lightweight K 线
// =============================================================================

// 旧版 renderBacktest 末尾已经自己调了 K 线渲染（div 走 LWC、canvas 走内置），
// 这里不再重复调用，避免 CDN 失败时反复回退到 drawKlineChart。


// ============================================================
// 访客 API 密钥：模态框 / 状态指示器 / 横幅
// 依赖：window.quantKeys (config.js) 提供的 load/save/clear/mask
// ============================================================

(function () {
  const BANNER_DISMISSED = "quant_banner_dismissed";

  function $(sel) { return document.querySelector(sel); }

  function updateIndicator() {
    const btn = $("#btn-keys");
    if (!btn) return;
    const k = window.quantKeys.load();
    if (k.iwencai || k.minimax) {
      btn.classList.remove("keys-status--unset");
      btn.classList.add("keys-status--set");
      const dot = btn.querySelector(".keys-status-text");
      if (dot) dot.textContent = "密钥✓";
      btn.title =
        "问财: " + (k.iwencai ? window.quantKeys.mask(k.iwencai) : "(未填)") +
        "\nMiniMax: " + (k.minimax ? window.quantKeys.mask(k.minimax) : "(未填)") +
        "\n点击修改";
    } else {
      btn.classList.remove("keys-status--set");
      btn.classList.add("keys-status--unset");
      const dot = btn.querySelector(".keys-status-text");
      if (dot) dot.textContent = "API 密钥";
      btn.title = "未配置 API 密钥，点击配置";
    }
  }

  function updateBanner() {
    const banner = $("#keys-banner");
    if (!banner) return;
    if (window.quantKeys.isConfigured()) {
      banner.hidden = true;
      return;
    }
    try {
      if (localStorage.getItem(BANNER_DISMISSED) === "1") {
        banner.hidden = true;
        return;
      }
    } catch (_e) { /* ignore */ }
    banner.hidden = false;
  }

  function openModal() {
    const modal = $("#keys-modal");
    if (!modal) return;
    const k = window.quantKeys.load();
    const iw = $("#input-iwencai-key");
    const mn = $("#input-minimax-key");
    if (iw) iw.value = k.iwencai || "";
    if (mn) mn.value = k.minimax || "";
    renderMasked();
    modal.hidden = false;
    setTimeout(() => { if (iw) iw.focus(); }, 50);
  }

  function closeModal() {
    const modal = $("#keys-modal");
    if (modal) modal.hidden = true;
  }

  function renderMasked() {
    const k = window.quantKeys.load();
    const m1 = $("#mask-iwencai");
    const m2 = $("#mask-minimax");
    if (m1) m1.textContent = k.iwencai ? window.quantKeys.mask(k.iwencai) : "";
    if (m2) m2.textContent = k.minimax ? window.quantKeys.mask(k.minimax) : "";
  }

  function saveFromModal() {
    const iw = ($("#input-iwencai-key")?.value || "").trim();
    const mn = ($("#input-minimax-key")?.value || "").trim();
    if (!iw) {
      alert("问财 OpenAPI Key 是必填项（用于查数据 / 回测）。");
      return;
    }
    window.quantKeys.save({ iwencai: iw, minimax: mn });
    updateIndicator();
    updateBanner();
    closeModal();
    setStatus("✓ API 密钥已保存到本浏览器");
  }

  function clearFromModal() {
    if (!confirm("确认清除本浏览器保存的所有 API 密钥？")) return;
    window.quantKeys.clear();
    const iw = $("#input-iwencai-key");
    const mn = $("#input-minimax-key");
    if (iw) iw.value = "";
    if (mn) mn.value = "";
    renderMasked();
    updateIndicator();
    updateBanner();
    closeModal();
    setStatus("已清除本浏览器 API 密钥");
  }

  // 接线 —— 关键：app.js 在 <body> 末尾，DOM 解析完才执行，
  // 此时 DOMContentLoaded 已经 fire 了，用 addEventListener 永远等不到。
  // 改用 readyState 判断：已就绪就直接跑，未就绪（head 内 defer）才等事件。
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  ready(() => {
    updateIndicator();
    updateBanner();

    const btnKeys = $("#btn-keys");
    if (btnKeys) btnKeys.addEventListener("click", openModal);

    const btnSave = $("#btn-save-keys");
    if (btnSave) btnSave.addEventListener("click", saveFromModal);

    const btnClear = $("#btn-clear-keys");
    if (btnClear) btnClear.addEventListener("click", clearFromModal);

    // 关闭按钮（背景 / X / 取消）
    document.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", closeModal);
    });

    // ESC 关闭
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const modal = $("#keys-modal");
        if (modal && !modal.hidden) closeModal();
      }
    });

    // 横幅关闭
    const bannerClose = $("#btn-banner-dismiss");
    if (bannerClose) {
      bannerClose.addEventListener("click", () => {
        const banner = $("#keys-banner");
        if (banner) banner.hidden = true;
        try { localStorage.setItem(BANNER_DISMISSED, "1"); } catch (_e) {}
      });
    }

    // 输入框聚焦时清空（方便修改）
    ["input-iwencai-key", "input-minimax-key"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("focus", () => {
        // 只在确实已有值时清空（避免空打开 modal 时被清掉）
        if (el.value) el.value = "";
      });
    });

    // 暴露给手动测试（控制台可调 openKeysModal() / saveKeys()）
    window.__quantKeysModal = { open: openModal, save: saveFromModal, clear: clearFromModal };
  });
})();
