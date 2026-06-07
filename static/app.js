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
const kctx = klineChart.getContext("2d");
const tooltip = document.querySelector("#chart-tooltip");
let lastEquityCurve = [];
let lastBars = [];
let lastTrades = [];
let equityLayout = null;
let klineLayout = null;
let selectorRows = [];

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
      const data = await postJson("/api/batch_backtest", payload);
      renderBatchBacktest(data);
      setStatus(`完成: ${data.summary.tested_count} 只标的`);
    } else {
      const data = await postJson("/api/backtest", payload);
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
    const data = await postJson("/api/query", payload);
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
    const data = await postJson("/api/query", payload);
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
    const result = await postJson("/api/analyze", payload);
    setHtml("#analysis-content", renderMarkdown(result.analysis || "没有返回分析内容。"));
    setText("#analysis-status", "已生成");
  } catch (error) {
    setText("#analysis-content", error.message);
    setText("#analysis-status", "生成失败");
  }
}

async function postJson(url, payload) {
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
  drawKlineChart(lastBars, lastTrades);
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
      postJson("/api/query", { query: "上证指数 深证成指 创业板指 最新行情", limit: 3 }),
      watchQuery
        ? postJson("/api/query", { query: watchQuery, limit: Math.max(1, watchlist.length) })
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
      
      try {
        const res = await postJson("/api/optimize", payload);
        
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
          appendCell(tr, r.trades ?? "--");
          tbody.appendChild(tr);
        });
        
        setStatus("寻优完成，请查看记录表格");
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
