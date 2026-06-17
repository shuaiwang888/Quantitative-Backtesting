/**
 * Backtest —— 单标的 / 指数回测
 *
 * 布局：
 *   顶部：策略选择 + 参数表
 *   中部：标的 / 日期 / 资金 / 费率 + 提交
 *   底部：6 张指标卡 + 净值曲线（SVG） + K线（SVG） + 交易明细表
 *
 * 不依赖 Plotly / 任何图表库，所有图形自画 SVG。
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { postJson, money, percent, numberOrDash, formatPercentText } from "../api.js";
import useCachedResult, { formatCacheTime } from "../hooks/useCachedResult.js";

const INDEX_OPTIONS = [
  { value: "hs300", label: "沪深300 (000300.SH)" },
  { value: "zz500", label: "中证500 (000905.SH)" },
  { value: "zz1000", label: "中证1000 (000852.SH)" },
];

// 默认近 2 年（~500 个交易日）
function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export default function Backtest({ hasIwencaiKey, hasMinimaxKey, onError, onStatus, pendingBatchNames }) {
  const _initRange = defaultDateRange();
  const [strategies, setStrategies] = useState([]);
  const [strategy, setStrategy] = useState("moving_average");
  const [backtestMode, setBacktestMode] = useState("single");
  const [symbol, setSymbol] = useState("000001.SZ");
  const [indexSymbol, setIndexSymbol] = useState("hs300");
  const [startDate, setStartDate] = useState(_initRange.start);
  const [endDate, setEndDate] = useState(_initRange.end);
  const [initialCash, setInitialCash] = useState(100000);
  const [feeRate, setFeeRate] = useState(0.0003);
  const [paramValues, setParamValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [strategiesErr, setStrategiesErr] = useState("");
  const cache = useCachedResult("backtest");
  const [result, setResult] = useState(cache.data);
  // 切到本 tab 时 cache 可能变化（跨 tab 同步），同步到 result
  useEffect(() => { if (cache.data && !result) setResult(cache.data); }, [cache.data]);

  // 拉策略列表
  useEffect(() => {
    postJson("/api/strategies", {})
      .then((d) => {
        if (d && Array.isArray(d.strategies)) {
          setStrategies(d.strategies);
        }
      })
      .catch((e) => {
        setStrategiesErr(e.message || "拉策略列表失败");
        onError?.(e);
      });
  }, [onError]);

  // 策略变化时，重置参数为默认
  useEffect(() => {
    const spec = strategies.find((s) => s.name === strategy);
    if (spec) setParamValues({ ...spec.default_params });
  }, [strategy, strategies]);

  // Dashboard 来的批量回测事件：把 names 注入到 symbol
  useEffect(() => {
    if (Array.isArray(pendingBatchNames) && pendingBatchNames.length > 0) {
      setSymbol(pendingBatchNames.join(","));
      onStatus?.("已填入股票池，请在回测模式=单标的下逐个跑（批量请用「选股」tab）");
    }
  }, [pendingBatchNames, onStatus]);

  // 热力图个股点击 → 填入 symbol
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("quant_pending_symbol");
      if (raw) {
        const { name, code } = JSON.parse(raw);
        if (name || code) {
          setSymbol(code || name);
          setBacktestMode("single");
          sessionStorage.removeItem("quant_pending_symbol");
        }
      }
    } catch {}
  }, []);

  // ---- 提交 ----
  const submit = async (e) => {
    e?.preventDefault?.();
    setLoading(true);
    setResult(null);
    try {
      const data = await postJson("/api/backtest", {
        strategy,
        backtest_mode: backtestMode,
        symbol: backtestMode === "single" ? symbol : "",
        index_symbol: backtestMode === "index" ? indexSymbol : "",
        start_date: startDate,
        end_date: endDate,
        initial_cash: Number(initialCash),
        fee_rate: Number(feeRate),
        strategy_params: paramValues,
      });
      if (data && data.success) {
        setResult(data);
        cache.save(data);
      } else {
        throw new Error(data?.error || "回测失败");
      }
    } catch (e) {
      onError?.(e);
    } finally {
      setLoading(false);
    }
  };

  const spec = strategies.find((s) => s.name === strategy);

  return (
    <section className="form-view">
      {/* ===== 策略选择 + 参数 ===== */}
      <div>
        <div className="optimize-header">
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>策略</h3>
        </div>
        {strategiesErr && <div className="error-box" style={{ marginTop: 8 }}>{strategiesErr}</div>}
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="form-field">
            <label>策略</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {strategies.map((s) => (
                <option key={s.name} value={s.name}>{s.display_name}</option>
              ))}
            </select>
            <span className="hint">单标的 / 指数共用一个策略；参数在右侧编辑</span>
          </div>
          <div className="form-field">
            <label>回测模式</label>
            <select value={backtestMode} onChange={(e) => setBacktestMode(e.target.value)}>
              <option value="single">单标的</option>
              <option value="index">指数</option>
            </select>
            <span className="hint">指数模式不需要填代码，固定拉 000300/000905/000852</span>
          </div>
        </div>

        {spec && Object.keys(spec.default_params).length > 0 && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            {Object.entries(spec.default_params).map(([k, v]) => (
              <div className="form-field" key={k}>
                <label>
                  {k}
                  <span className="hint" style={{ marginLeft: 6 }}>默认: {String(v)}</span>
                </label>
                <input
                  className="mono"
                  type="text"
                  value={String(paramValues[k] ?? v)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const num = Number(raw);
                    setParamValues({ ...paramValues, [k]: Number.isFinite(num) && raw !== "" ? num : raw });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== 标的 / 日期 / 资金 ===== */}
      <form onSubmit={submit}>
        <div className="form-grid">
          {backtestMode === "single" ? (
            <div className="form-field">
              <label>股票代码 / 名称</label>
              <input
                className="mono"
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="例：000001.SZ 或 宁德时代"
                required
              />
              <span className="hint">A 股代码 / 名称；多个用半角逗号分隔（仍只跑第一只）</span>
            </div>
          ) : (
            <div className="form-field">
              <label>指数</label>
              <select value={indexSymbol} onChange={(e) => setIndexSymbol(e.target.value)}>
                {INDEX_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-field">
            <label>开始日期</label>
            <input
              className="mono"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label>结束日期</label>
            <input
              className="mono"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label>初始资金 (元)</label>
            <input
              className="mono"
              type="number"
              step="1000"
              min="1000"
              value={initialCash}
              onChange={(e) => setInitialCash(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label>费率 (单边)</label>
            <input
              className="mono"
              type="number"
              step="0.0001"
              min="0"
              value={feeRate}
              onChange={(e) => setFeeRate(e.target.value)}
            />
            <span className="hint">A 股双边 0.03% ≈ 单边 0.0003</span>
          </div>
        </div>

        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={loading || !hasIwencaiKey && backtestMode === "single"}>
            {loading ? <><span className="loader" /> 回测中...</> : "开始回测"}
          </button>
          {!hasIwencaiKey && (
            <span className="hint" style={{ color: "var(--up-color)" }}>
              需先在右上角配置 iwencai key
            </span>
          )}
        </div>
      </form>

      {/* ===== 结果 ===== */}
      {result && (
        <BacktestResult
          result={result}
          hasMinimaxKey={hasMinimaxKey}
          onError={onError}
          onStatus={onStatus}
          cacheTs={cache.ts}
        />
      )}
    </section>
  );
}

// ---- 结果区 ----

function BacktestResult({ result, hasMinimaxKey, onError, onStatus, cacheTs }) {
  const summary = result.summary || {};
  const [analysis, setAnalysis] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");

  const runAnalysis = async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalysisErr("");
    setAnalysis("");
    try {
      const res = await postJson("/api/analyze", {
        query: result.query,
        strategy: summary.strategy,
        summary,
        trades: result.trades || [],
        bars: result.bars || [],
        equity_curve: result.equity_curve || [],
      });
      if (res && res.analysis) {
        setAnalysis(res.analysis);
        onStatus?.("AI 复盘已生成");
      } else {
        throw new Error(res?.error || "未返回复盘内容");
      }
    } catch (e) {
      setAnalysisErr(e.message || "复盘失败");
      onError?.(e);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
      <div className="optimize-header">
        <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
          回测结果
          <span className="hint" style={{ marginLeft: 12, fontSize: 11 }}>
            {summary.start_date} ~ {summary.end_date} · {summary.bar_count} K线
          </span>
        </h3>
        {cacheTs > 0 && (
          <span className="hint" style={{ fontSize: 11 }} title={new Date(cacheTs).toLocaleString()}>
            📦 已缓存 {formatCacheTime(cacheTs)}
          </span>
        )}
      </div>

      <div className="metric-grid">
        <MetricCard label="总收益" value={formatPercentText(summary.total_return)} kind={pctKind(summary.total_return)} />
        <MetricCard label="年化收益" value={formatPercentText(summary.annual_return)} kind={pctKind(summary.annual_return)} />
        <MetricCard label="基准收益" value={formatPercentText(summary.benchmark_return)} kind={pctKind(summary.benchmark_return)} />
        <MetricCard label="超额收益" value={formatPercentText(summary.excess_return)} kind={pctKind(summary.excess_return)} />
        <MetricCard label="最大回撤" value={formatPercentText(summary.max_drawdown)} kind="down" />
        <MetricCard label="夏普" value={numberOrDash(summary.sharpe_ratio, 2)} />
        <MetricCard label="胜率" value={formatPercentText(summary.win_rate)} />
        <MetricCard label="交易次数" value={String(summary.trade_count ?? 0)} />
        <MetricCard label="最终资金" value={money(summary.final_equity)} />
      </div>

      <div className="chart-panel">
        <h4>净值曲线 vs 基准</h4>
        <EquityChart equity={result.equity_curve || []} bars={result.bars || []} />
      </div>

      <div className="chart-panel">
        <h4>K线 + 买卖点</h4>
        <CandleChart bars={result.bars || []} trades={result.trades || []} />
      </div>

      <div className="chart-panel">
        <h4>交易记录 ({result.trades?.length || 0})</h4>
        <TradesTable trades={result.trades || []} />
      </div>

      {/* ===== AI 复盘 ===== */}
      <div className="chart-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h4 style={{ margin: 0 }}>AI 复盘 <span className="hint" style={{ fontSize: 11, marginLeft: 4 }}>(MiniMax M2.7)</span></h4>
          <button
            type="button"
            className="btn btn-primary"
            onClick={runAnalysis}
            disabled={analyzing}
            title={hasMinimaxKey ? "调用 MiniMax M2.7 生成中文复盘" : "需先在右上角配置 MiniMax key"}
          >
            {analyzing ? <><span className="loader" /> 生成中（约 10-30s）</> : (analysis ? "重新生成" : "AI 复盘")}
          </button>
        </div>
        {!hasMinimaxKey && (
          <div className="error-box" style={{ marginBottom: analysis ? 10 : 0 }}>
            未配置 MiniMax Key —— 请在右上角"API 密钥"里填入（每个访客自带 key，不会上传）
          </div>
        )}
        {analysisErr && <div className="error-box">{analysisErr}</div>}
        {analyzing && (
          <div className="chart-empty">
            <span className="loader" /> MiniMax M2.7 正在结合 K 线、策略参数和回测结果生成分析…
          </div>
        )}
        {analysis && !analyzing && <MarkdownView text={analysis} />}
      </div>
    </div>
  );
}

// ---- 简易 Markdown 渲染器（不引外部库） ----
// 支持：# / ## / ### 标题，**粗体**，*斜体*，`code`，```围栏```，- / * / 1. 列表，> 引用，链接

function MarkdownView({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="markdown-body"
      style={{
        fontSize: 13,
        lineHeight: 1.7,
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(src) {
  if (!src) return "";
  // 转义 HTML
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 先抽 code block
  const codeBlocks = [];
  src = src.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return ` CODE${codeBlocks.length - 1} `;
  });

  const lines = src.split("\n");
  const out = [];
  let inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code style="background:var(--bg);padding:1px 5px;border-radius:3px;font-family:var(--font-mono);font-size:12px;">${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  for (const line of lines) {
    if (/^\s*$/.test(line)) { closeLists(); out.push(""); continue; }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      const sizes = { 1: 16, 2: 15, 3: 14, 4: 13 };
      const margin = lvl === 1 ? "8px 0 6px" : "6px 0 4px";
      out.push(`<h${lvl} style="font-size:${sizes[lvl]}px;color:var(--ink);margin:${margin};font-weight:600;">${inline(h[2])}</h${lvl}>`);
      continue;
    }
    // 引用
    if (/^>\s+/.test(line)) {
      closeLists();
      out.push(`<blockquote style="margin:6px 0;padding:4px 10px;border-left:2px solid var(--accent);background:var(--accent-soft);color:var(--text-secondary);">${inline(line.replace(/^>\s+/, ""))}</blockquote>`);
      continue;
    }
    // 无序列表
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push('<ul style="margin:4px 0 4px 20px;color:var(--text-primary);">'); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    // 有序列表
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push('<ol style="margin:4px 0 4px 20px;color:var(--text-primary);">'); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeLists();
    out.push(`<p style="margin:4px 0;">${inline(line)}</p>`);
  }
  closeLists();
  let html = out.join("\n");
  // 还原 code blocks
  html = html.replace(/ CODE(\d+) /g, (_, i) => {
    const code = codeBlocks[Number(i)] || "";
    return `<pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;overflow-x:auto;margin:6px 0;font-family:var(--font-mono);font-size:12px;line-height:1.5;"><code>${esc(code)}</code></pre>`;
  });
  return html;
}

function MetricCard({ label, value, kind }) {
  const cls = kind ? `metric-card-value ${kind}` : "metric-card-value";
  return (
    <div className="metric-card">
      <div className="metric-card-label">{label}</div>
      <div className={cls}>{value}</div>
    </div>
  );
}

function pctKind(v) {
  if (v == null) return "";
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "";
}

// ---- 净值曲线 ----

function EquityChart({ equity, bars }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) setW(Math.max(400, ent.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const h = 280;
  const pad = { l: 50, r: 20, t: 20, b: 30 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const data = useMemo(() => {
    if (!equity.length || !bars.length) return null;
    const dates = equity.map((p) => p.date);
    const eq = equity.map((p) => p.equity);
    const bench = bars.map((b) => b.close);
    // 把 benchmark 归一化到 initial_cash
    const init = eq[0] || 100000;
    const benchStart = bench[0] || 1;
    const benchEq = bench.map((c) => (c / benchStart) * init);
    const allVals = [...eq, ...benchEq];
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const range = maxV - minV || 1;
    const n = dates.length;
    const x = (i) => pad.l + (i / Math.max(1, n - 1)) * innerW;
    const y = (v) => pad.t + (1 - (v - minV) / range) * innerH;
    return { dates, eq, benchEq, x, y };
  }, [equity, bars, innerW, innerH, pad.l, pad.t]);

  if (!data) return <div className="chart-empty">无数据</div>;

  const pathEq = data.eq.map((v, i) => `${i === 0 ? "M" : "L"}${data.x(i).toFixed(1)},${data.y(v).toFixed(1)}`).join(" ");
  const pathBench = data.benchEq.map((v, i) => `${i === 0 ? "M" : "L"}${data.x(i).toFixed(1)},${data.y(v).toFixed(1)}`).join(" ");

  // Y 轴 tick
  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (data.eq[0] === undefined ? 0 : 0) + i;
    const yv = (() => {
      const arr = data.eq.length ? data.eq : data.benchEq;
      const lo = Math.min(...arr), hi = Math.max(...arr);
      return lo + (hi - lo) * (1 - i / yTicks);
    })();
    return { v: yv, y: pad.t + (i / yTicks) * innerH };
  });

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <svg width={w} height={h} style={{ display: "block" }}>
        {/* 网格 */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={t.y} y2={t.y} stroke="var(--line)" strokeWidth="0.5" />
            <text x={pad.l - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--text-tertiary)">
              {Math.round(t.v).toLocaleString()}
            </text>
          </g>
        ))}
        {/* 基准 */}
        <path d={pathBench} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeDasharray="3,3" />
        {/* 净值 */}
        <path d={pathEq} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
        {/* 图例 */}
        <g fontSize="11" fill="var(--text-secondary)">
          <line x1={pad.l} y1={pad.t - 4} x2={pad.l + 18} y2={pad.t - 4} stroke="var(--accent)" strokeWidth="1.8" />
          <text x={pad.l + 24} y={pad.t - 1}>策略净值</text>
          <line x1={pad.l + 90} y1={pad.t - 4} x2={pad.l + 108} y2={pad.t - 4} stroke="var(--text-tertiary)" strokeWidth="1.2" strokeDasharray="3,3" />
          <text x={pad.l + 114} y={pad.t - 1}>基准</text>
        </g>
      </svg>
    </div>
  );
}

// ---- K线图（专业版：MA 均线 + 涨实心/跌空心 + 三角买卖点 + hover tooltip + Volume 副图） ----

function CandleChart({ bars, trades }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(900);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [showMA, setShowMA] = useState({ ma5: true, ma10: true, ma20: true });

  // 缩放 / 平移视图：viewStart / viewEnd 是 [0, n] 范围内的浮点 index
  const [view, setView] = useState({ start: 0, end: 1 });
  // 上一次 drag 的 X 与是否在拖
  const dragRef = useRef(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) setW(Math.max(400, ent.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // bars 变化（标的切换 / 重跑回测）时重置视图
  useEffect(() => {
    setView({ start: 0, end: bars.length || 1 });
    setHoverIdx(null);
  }, [bars]);

  // 主图 320 / 间距 16 / 副图 120 / 顶 30 / 底 30
  const h = 516;
  const pad = { l: 56, r: 70, t: 30, b: 30 };
  const mainTop = pad.t;
  const mainH = 320;
  const volTop = mainTop + mainH + 16;
  const volH = 120;
  const innerW = w - pad.l - pad.r;
  const innerH = mainH;

  // 按日期 trade 分桶
  const tradeMap = useMemo(() => {
    const m = new Map();
    for (const t of trades || []) {
      if (!m.has(t.date)) m.set(t.date, []);
      m.get(t.date).push(t);
    }
    return m;
  }, [trades]);

  // MA 均线（按全量 bars 计算；切片留到渲染时）
  const ma = useMemo(() => {
    const out = { ma5: [], ma10: [], ma20: [] };
    if (!bars.length) return out;
    const closeOf = (i) => Number(bars[i].close ?? 0);
    for (let i = 0; i < bars.length; i++) {
      out.ma5.push(i >= 4 ? (closeOf(i) + closeOf(i-1) + closeOf(i-2) + closeOf(i-3) + closeOf(i-4)) / 5 : null);
      out.ma10.push(i >= 9 ? Array.from({length: 10}, (_, k) => closeOf(i - k)).reduce((a, b) => a + b, 0) / 10 : null);
      out.ma20.push(i >= 19 ? Array.from({length: 20}, (_, k) => closeOf(i - k)).reduce((a, b) => a + b, 0) / 20 : null);
    }
    return out;
  }, [bars]);

  const data = useMemo(() => {
    if (!bars.length) return null;
    const n = bars.length;
    const highs = bars.map((b) => Number(b.high ?? b.close));
    const lows = bars.map((b) => Number(b.low ?? b.close));
    const maVals = [...ma.ma5, ...ma.ma10, ...ma.ma20].filter((v) => v != null);
    const maxV = Math.max(...highs, ...maVals);
    const minV = Math.min(...lows, ...maVals);
    const padRatio = (maxV - minV) * 0.05 || 1;
    const yMax = maxV + padRatio;
    const yMin = minV - padRatio;
    const range = yMax - yMin || 1;
    const step = innerW / n;
    const candleW = Math.max(2, Math.min(12, step * 0.62));
    const x = (i) => pad.l + step * (i + 0.5);
    const y = (v) => mainTop + (1 - (v - yMin) / range) * innerH;

    // Volume scale
    const vols = bars.map((b) => Number(b.volume ?? 0));
    const maxVol = Math.max(...vols, 1);
    const yVol = (v) => volTop + volH - (v / maxVol) * volH;
    const volW = Math.max(1, step * 0.62);

    return { n, x, y, candleW, yMax, yMin, yVol, volW, maxVol, step };
  }, [bars, ma, innerW, innerH, pad.l, mainTop, volTop, volH]);

  if (!data) return <div className="chart-empty">无数据</div>;

  // === 视图参数：clamp + 计算可见区 ===
  const n = data.n;
  const MIN_VIEW = 10;        // 最少显示 10 根
  const MAX_VIEW = n;         // 最多全量
  const clampView = (s, e) => {
    let ns = Math.max(0, Math.min(s, n - MIN_VIEW));
    let ne = Math.max(ns + MIN_VIEW, Math.min(e, n));
    if (ne - ns > MAX_VIEW) ne = ns + MAX_VIEW;
    return { start: ns, end: ne };
  };
  const v = clampView(view.start, view.end);
  const viewStart = v.start;
  const viewEnd = v.end;
  const viewCount = viewEnd - viewStart;
  const viewStep = innerW / viewCount;
  const viewCandleW = Math.max(2, Math.min(14, viewStep * 0.62));
  // 在视图坐标系下，bar i 的 X
  const xView = (i) => pad.l + (i - viewStart + 0.5) * viewStep;
  // 视图内可见的 bar 范围
  const firstBar = Math.max(0, Math.floor(viewStart));
  const lastBar = Math.min(n - 1, Math.ceil(viewEnd));
  // 当前缩放级别（相对全量，1 = 全量，>1 = 放大）
  const zoomLevel = n / Math.max(1, viewCount);

  // Y 轴 ticks（5 段）
  const yTicks = 5;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => ({
    v: data.yMin + (data.yMax - data.yMin) * (1 - i / yTicks),
    y: mainTop + (i / yTicks) * innerH,
  }));

  // X 轴日期：5 段（在视图范围内均匀采样）
  const xTickCount = Math.min(6, Math.max(2, Math.floor(viewCount / 20) + 2));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.round(viewStart + (i / (xTickCount - 1)) * viewCount);
    const ci = Math.max(0, Math.min(n - 1, idx));
    return { idx: ci, x: xView(ci), label: (bars[ci].date || "").slice(2, 10) };
  });

  // === 滚轮缩放（以鼠标 X 为锚点） ===
  const onWheel = (e) => {
    if (!data) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // 鼠标在视图坐标系中的位置（0..1）
    const anchorFrac = Math.max(0, Math.min(1, (px - pad.l) / innerW));
    const anchorIdx = viewStart + anchorFrac * viewCount;
    // 缩放因子：向上滚 = 放大（缩小 viewCount）
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    let newCount = viewCount * factor;
    newCount = Math.max(MIN_VIEW, Math.min(n, newCount));
    // 保持锚点 bar 不动
    let newStart = anchorIdx - anchorFrac * newCount;
    let newEnd = newStart + newCount;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > n) { newStart -= (newEnd - n); newEnd = n; newStart = Math.max(0, newStart); }
    setView(clampView(newStart, newEnd));
  };

  // === 鼠标拖拽平移 ===
  const onMouseDown = (e) => {
    if (e.button !== 0) return; // 仅左键
    dragRef.current = { startX: e.clientX, viewStart, viewEnd };
    e.currentTarget.style.cursor = "grabbing";
  };
  useEffect(() => {
    const onMoveDrag = (e) => {
      if (!dragRef.current) return;
      const { startX, viewStart: vs, viewEnd: ve } = dragRef.current;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = e.clientX - startX;
      // 把 px 差换算成 bar 数
      const barPerPx = (ve - vs) / innerW;
      const dBars = -dx * barPerPx;
      setView(clampView(vs + dBars, ve + dBars));
    };
    const onUpDrag = () => {
      if (dragRef.current && wrapRef.current) {
        wrapRef.current.querySelector("svg")?.style &&
          (wrapRef.current.querySelector("svg").style.cursor = "grab");
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMoveDrag);
    window.addEventListener("mouseup", onUpDrag);
    return () => {
      window.removeEventListener("mousemove", onMoveDrag);
      window.removeEventListener("mouseup", onUpDrag);
    };
  }, [innerW, n]);

  const resetZoom = () => setView({ start: 0, end: n });
  const zoomIn = () => {
    const center = (viewStart + viewEnd) / 2;
    const newCount = Math.max(MIN_VIEW, viewCount * 0.7);
    setView(clampView(center - newCount / 2, center + newCount / 2));
  };
  const zoomOut = () => {
    const center = (viewStart + viewEnd) / 2;
    const newCount = Math.min(n, viewCount * 1.4);
    setView(clampView(center - newCount / 2, center + newCount / 2));
  };

  // hover 处理
  const onMove = (e) => {
    if (!data) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // 鼠标位置 → bar index（基于视图）
    const frac = (px - pad.l) / innerW;
    const idx = Math.max(0, Math.min(bars.length - 1, Math.round(viewStart + frac * viewCount)));
    setHoverIdx(idx);
  };
  const onLeave = () => setHoverIdx(null);

  // hover 工具
  const hover = hoverIdx != null ? bars[hoverIdx] : null;
  const hoverTrades = hover ? (tradeMap.get(hover.date) || []) : [];
  const cx = hover ? xView(hoverIdx) : 0;
  const cy = hover ? data.y(hover.close) : 0;

  // MA 折线路径（在视图范围内切片 + 用 xView）
  const maPath = (arr) => {
    const lo = Math.max(0, Math.floor(viewStart));
    const hi = Math.min(arr.length - 1, Math.ceil(viewEnd));
    let started = false;
    let out = "";
    for (let i = lo; i <= hi; i++) {
      const v = arr[i];
      if (v == null) continue;
      const s = `${started ? "L" : "M"}${xView(i).toFixed(1)},${data.y(v).toFixed(1)}`;
      started = true;
      out += s + " ";
    }
    return out.trim();
  };
  const ma5Path = showMA.ma5 ? maPath(ma.ma5) : "";
  const ma10Path = showMA.ma10 ? maPath(ma.ma10) : "";
  const ma20Path = showMA.ma20 ? maPath(ma.ma20) : "";

  return (
    <div ref={wrapRef} style={{ width: "100%", overflowX: "auto", position: "relative" }}>
      {/* MA 切换 + 缩放控件 */}
      <div className="candle-toolbar">
        <div className="candle-toolbar-group">
          {[["ma5", "MA5", "#fbbf24"], ["ma10", "MA10", "#4ea8ff"], ["ma20", "MA20", "#c084fc"]].map(([k, label, color]) => (
            <button
              key={k}
              type="button"
              onClick={() => setShowMA({ ...showMA, [k]: !showMA[k] })}
              style={{
                padding: "2px 8px",
                fontSize: 11,
                border: `1px solid ${showMA[k] ? color : "var(--line)"}`,
                background: showMA[k] ? `${color}22` : "transparent",
                color: showMA[k] ? color : "var(--text-tertiary)",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="candle-toolbar-group candle-zoom-controls">
          <button
            type="button"
            onClick={zoomOut}
            disabled={viewCount >= n}
            title="缩小（滚轮向下也缩）"
            className="candle-zoom-btn"
          >−</button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={viewCount <= MIN_VIEW}
            title="放大（滚轮向上也放）"
            className="candle-zoom-btn"
          >+</button>
          <button
            type="button"
            onClick={resetZoom}
            disabled={viewCount >= n && viewStart <= 0}
            title="重置视图"
            className="candle-zoom-btn candle-zoom-reset"
          >⟲</button>
          <span className="candle-zoom-info" title="滚轮 = 缩放（以鼠标位置为锚点）· 拖拽 = 平移">
            {Math.round(viewCount)}/{n} 根 · {zoomLevel.toFixed(1)}×
          </span>
        </div>
      </div>

      <svg
        width={w}
        height={h}
        style={{ display: "block", cursor: dragRef.current ? "grabbing" : "grab" }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
      >
        {/* ===== 主图网格 + Y 轴 ===== */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={t.y} y2={t.y} stroke="var(--line)" strokeWidth="0.5" />
            <text x={pad.l - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--text-tertiary)" className="mono">
              {t.v.toFixed(2)}
            </text>
          </g>
        ))}

        {/* ===== Volume 副图 ===== */}
        <g>
          {/* 副图分隔线 */}
          <line x1={pad.l} x2={w - pad.r} y1={volTop - 4} y2={volTop - 4} stroke="var(--line)" strokeWidth="0.5" strokeDasharray="2,3" />
          <text x={pad.l - 6} y={volTop + 12} textAnchor="end" fontSize="9" fill="var(--text-tertiary)">VOL</text>
          {bars.slice(firstBar, lastBar + 1).map((b, j) => {
            const i = firstBar + j;
            if (i < viewStart || i > viewEnd) return null;
            const up = b.close >= b.open;
            const color = up ? "var(--up-color)" : "var(--down-color)";
            const v = Number(b.volume ?? 0);
            return (
              <rect
                key={i}
                x={xView(i) - viewCandleW / 2}
                y={data.yVol(v)}
                width={viewCandleW}
                height={Math.max(1, volTop + volH - data.yVol(v))}
                fill={color}
                opacity={0.55}
              />
            );
          })}
          {/* Volume Y 刻度（最高值） */}
          <text x={w - pad.r + 4} y={volTop + 10} fontSize="9" fill="var(--text-tertiary)" className="mono">
            {data.maxVol >= 1e8 ? (data.maxVol / 1e8).toFixed(1) + "亿" : data.maxVol >= 1e4 ? (data.maxVol / 1e4).toFixed(0) + "万" : data.maxVol}
          </text>
        </g>

        {/* ===== K线（先 wick 后 body） ===== */}
        {bars.slice(firstBar, lastBar + 1).map((b, j) => {
          const i = firstBar + j;
          if (i < viewStart || i > viewEnd) return null;
          const cx0 = xView(i);
          const yo = data.y(Number(b.open));
          const yc = data.y(Number(b.close));
          const yh = data.y(Number(b.high ?? Math.max(b.open, b.close)));
          const yl = data.y(Number(b.low ?? Math.min(b.open, b.close)));
          const up = b.close >= b.open;
          const color = up ? "var(--up-color)" : "var(--down-color)";
          const bodyTop = Math.min(yo, yc);
          const bodyH = Math.max(1, Math.abs(yc - yo));
          return (
            <g key={i}>
              {/* 影线 */}
              <line x1={cx0} x2={cx0} y1={yh} y2={yl} stroke={color} strokeWidth="1" />
              {/* 实体：A 股惯例 涨=实心红，跌=空心绿 */}
              {up ? (
                <rect
                  x={cx0 - viewCandleW / 2}
                  y={bodyTop}
                  width={viewCandleW}
                  height={bodyH}
                  fill={color}
                  stroke={color}
                  strokeWidth="0.5"
                />
              ) : (
                <rect
                  x={cx0 - viewCandleW / 2}
                  y={bodyTop}
                  width={viewCandleW}
                  height={bodyH}
                  fill="var(--bg-surface)"
                  stroke={color}
                  strokeWidth="1"
                />
              )}
            </g>
          );
        })}

        {/* ===== MA 均线 ===== */}
        {ma5Path && <path d={ma5Path} fill="none" stroke="#fbbf24" strokeWidth="1.2" opacity="0.9" />}
        {ma10Path && <path d={ma10Path} fill="none" stroke="#4ea8ff" strokeWidth="1.2" opacity="0.9" />}
        {ma20Path && <path d={ma20Path} fill="none" stroke="#c084fc" strokeWidth="1.2" opacity="0.9" />}

        {/* ===== 买卖点三角 ===== */}
        {bars.slice(firstBar, lastBar + 1).map((b, j) => {
          const i = firstBar + j;
          if (i < viewStart || i > viewEnd) return null;
          if (!tradeMap.has(b.date)) return null;
          const cx0 = xView(i);
          const yh = data.y(Number(b.high));
          const yl = data.y(Number(b.low));
          return tradeMap.get(b.date).map((t, j) => {
            const isBuy = t.side === "buy";
            // 买：在 wick 下沿外 12px 画上三角 ▲
            // 卖：在 wick 上沿外 12px 画下三角 ▼
            const cx1 = cx0 + (j - 0.5) * 10;
            const cy1 = isBuy ? yl + 14 : yh - 14;
            const size = 5;
            const color = isBuy ? "var(--down-color)" : "var(--up-color)";
            // ▲ 上三角（买） / ▼ 下三角（卖）
            const points = isBuy
              ? `${cx1},${cy1 - size} ${cx1 - size},${cy1 + size} ${cx1 + size},${cy1 + size}`
              : `${cx1},${cy1 + size} ${cx1 - size},${cy1 - size} ${cx1 + size},${cy1 - size}`;
            return (
              <g key={`${i}-${j}`}>
                <polygon
                  points={points}
                  fill={color}
                  stroke="var(--bg)"
                  strokeWidth="0.5"
                />
                <text
                  x={cx1}
                  y={isBuy ? cy1 + size + 11 : cy1 - size - 4}
                  textAnchor="middle"
                  fontSize="9"
                  fill={color}
                  className="mono"
                >
                  {isBuy ? "B" : "S"}
                </text>
              </g>
            );
          });
        })}

        {/* ===== X 轴日期 ===== */}
        {xTicks.map((t, i) => (
          <text key={i} x={t.x} y={h - 10} textAnchor="middle" fontSize="10" fill="var(--text-tertiary)" className="mono">
            {t.label}
          </text>
        ))}

        {/* ===== 右侧 Y 轴（百分比涨跌幅） ===== */}
        {ticks.map((t, i) => {
          const pct = (t.v / bars[0].close - 1) * 100;
          return (
            <text
              key={`r-${i}`}
              x={w - pad.r + 4}
              y={t.y + 4}
              fontSize="10"
              fill={pct >= 0 ? "var(--up-color)" : "var(--down-color)"}
              className="mono"
            >
              {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
            </text>
          );
        })}

        {/* ===== Hover 十字光标 ===== */}
        {hover && (
          <g pointerEvents="none">
            {/* 竖线（主图 + 副图） */}
            <line x1={cx} x2={cx} y1={mainTop} y2={volTop + volH} stroke="var(--text-tertiary)" strokeWidth="0.5" strokeDasharray="2,3" />
            {/* 横线（主图） */}
            <line x1={pad.l} x2={w - pad.r} y1={cy} y2={cy} stroke="var(--text-tertiary)" strokeWidth="0.5" strokeDasharray="2,3" />
            {/* 价格标签 */}
            <rect x={w - pad.r + 1} y={cy - 8} width={pad.r - 2} height={16} fill="var(--accent)" />
            <text x={w - pad.r + 4} y={cy + 4} fontSize="10" fill="#06121f" className="mono" fontWeight="600">
              {hover.close.toFixed(2)}
            </text>
            {/* 当前 K 框 */}
            <rect
              x={cx - viewCandleW / 2 - 1}
              y={mainTop}
              width={viewCandleW + 2}
              height={innerH}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1"
              opacity="0.4"
            />
          </g>
        )}

        {/* ===== 图例（右上） ===== */}
        <g fontSize="10" fill="var(--text-secondary)">
          {/* 涨/跌样例 */}
          <rect x={pad.l + 4} y={pad.t - 18} width="10" height="6" fill="var(--up-color)" />
          <text x={pad.l + 18} y={pad.t - 13}>涨</text>
          <rect x={pad.l + 36} y={pad.t - 18} width="10" height="6" fill="var(--bg-surface)" stroke="var(--down-color)" />
          <text x={pad.l + 50} y={pad.t - 13}>跌</text>
          {/* MA */}
          {showMA.ma5 && <><line x1={pad.l + 70} y1={pad.t - 15} x2={pad.l + 80} y2={pad.t - 15} stroke="#fbbf24" strokeWidth="1.2" /><text x={pad.l + 84} y={pad.t - 13}>MA5</text></>}
          {showMA.ma10 && <><line x1={pad.l + 116} y1={pad.t - 15} x2={pad.l + 126} y2={pad.t - 15} stroke="#4ea8ff" strokeWidth="1.2" /><text x={pad.l + 130} y={pad.t - 13}>MA10</text></>}
          {showMA.ma20 && <><line x1={pad.l + 166} y1={pad.t - 15} x2={pad.l + 176} y2={pad.t - 15} stroke="#c084fc" strokeWidth="1.2" /><text x={pad.l + 180} y={pad.t - 13}>MA20</text></>}
        </g>
      </svg>

      {/* ===== Hover tooltip（HTML 浮层） ===== */}
      {hover && (
        <div
          style={{
            position: "absolute",
            left: Math.min(cx + 12, w - 220),
            top: mainTop + 8,
            background: "var(--bg-elev)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 11,
            color: "var(--text-primary)",
            pointerEvents: "none",
            zIndex: 5,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            minWidth: 180,
            fontFamily: "var(--font-mono)",
          }}
        >
          <div style={{ color: "var(--text-tertiary)", marginBottom: 4, fontSize: 10 }}>{hover.date}</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 2 }}>
            <span style={{ color: "var(--text-secondary)" }}>开</span>
            <span>{Number(hover.open).toFixed(2)}</span>
            <span style={{ color: "var(--text-secondary)" }}>收</span>
            <span style={{ color: hover.close >= hover.open ? "var(--up-color)" : "var(--down-color)", fontWeight: 600 }}>
              {Number(hover.close).toFixed(2)}
            </span>
            <span style={{ color: "var(--text-secondary)" }}>高</span>
            <span style={{ color: "var(--up-color)" }}>{Number(hover.high).toFixed(2)}</span>
            <span style={{ color: "var(--text-secondary)" }}>低</span>
            <span style={{ color: "var(--down-color)" }}>{Number(hover.low).toFixed(2)}</span>
            <span style={{ color: "var(--text-secondary)" }}>量</span>
            <span>{Number(hover.volume).toLocaleString()}</span>
            <span style={{ color: "var(--text-secondary)" }}>MA5</span>
            <span>{ma.ma5[hoverIdx] != null ? ma.ma5[hoverIdx].toFixed(2) : "--"}</span>
            <span style={{ color: "var(--text-secondary)" }}>MA10</span>
            <span>{ma.ma10[hoverIdx] != null ? ma.ma10[hoverIdx].toFixed(2) : "--"}</span>
            <span style={{ color: "var(--text-secondary)" }}>MA20</span>
            <span>{ma.ma20[hoverIdx] != null ? ma.ma20[hoverIdx].toFixed(2) : "--"}</span>
          </div>
          {hoverTrades.length > 0 && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
              {hoverTrades.map((t, i) => (
                <div key={i} style={{ color: t.side === "buy" ? "var(--down-color)" : "var(--up-color)" }}>
                  {t.side === "buy" ? "买" : "卖"} {t.shares}股 @ {Number(t.price).toFixed(2)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- 交易明细表 ----

function TradesTable({ trades }) {
  if (!trades.length) return <div className="chart-empty">无交易</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 280 }}>
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>日期</th>
            <th>方向</th>
            <th>价格</th>
            <th>股数</th>
            <th>手续费</th>
            <th>剩余资金</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(0, 200).map((t, i) => (
            <tr key={i}>
              <td style={{ textAlign: "left" }} className="mono">{(t.date || "").slice(0, 10)}</td>
              <td>
                <span className={t.side === "buy" ? "down" : "up"} style={{ fontWeight: 500 }}>
                  {t.side === "buy" ? "买" : "卖"}
                </span>
              </td>
              <td className="mono">{money(t.price)}</td>
              <td className="mono">{t.shares}</td>
              <td className="mono">{money(t.fee)}</td>
              <td className="mono">{money(t.cash_after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length > 200 && (
        <div className="placeholder" style={{ padding: 12, fontSize: 12 }}>
          仅显示前 200 条（合计 {trades.length} 笔）
        </div>
      )}
    </div>
  );
}
