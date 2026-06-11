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

const INDEX_OPTIONS = [
  { value: "hs300", label: "沪深300 (000300.SH)" },
  { value: "zz500", label: "中证500 (000905.SH)" },
  { value: "zz1000", label: "中证1000 (000852.SH)" },
];

export default function Backtest({ hasIwencaiKey, onError, onStatus, pendingBatchNames }) {
  const [strategies, setStrategies] = useState([]);
  const [strategy, setStrategy] = useState("moving_average");
  const [backtestMode, setBacktestMode] = useState("single");
  const [symbol, setSymbol] = useState("000001.SZ");
  const [indexSymbol, setIndexSymbol] = useState("hs300");
  const [startDate, setStartDate] = useState("2024-01-01");
  const [endDate, setEndDate] = useState("2024-12-31");
  const [initialCash, setInitialCash] = useState(100000);
  const [feeRate, setFeeRate] = useState(0.0003);
  const [paramValues, setParamValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [strategiesErr, setStrategiesErr] = useState("");

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
      {result && <BacktestResult result={result} />}
    </section>
  );
}

// ---- 结果区 ----

function BacktestResult({ result }) {
  const summary = result.summary || {};
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
        回测结果
        <span className="hint" style={{ marginLeft: 12, fontSize: 11 }}>
          {summary.start_date} ~ {summary.end_date} · {summary.bar_count} K线
        </span>
      </h3>

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
    </div>
  );
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

// ---- K线图 ----

function CandleChart({ bars, trades }) {
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

  const h = 360;
  const pad = { l: 50, r: 60, t: 20, b: 30 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const tradeMap = useMemo(() => {
    const m = new Map();
    for (const t of trades || []) {
      if (!m.has(t.date)) m.set(t.date, []);
      m.get(t.date).push(t);
    }
    return m;
  }, [trades]);

  const data = useMemo(() => {
    if (!bars.length) return null;
    const n = bars.length;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const maxV = Math.max(...highs);
    const minV = Math.min(...lows);
    const range = maxV - minV || 1;
    const candleW = Math.max(1, (innerW / n) * 0.6);
    const x = (i) => pad.l + ((i + 0.5) / n) * innerW;
    const y = (v) => pad.t + (1 - (v - minV) / range) * innerH;
    return { n, x, y, candleW, maxV, minV };
  }, [bars, innerW, innerH, pad.l, pad.t]);

  if (!data) return <div className="chart-empty">无数据</div>;

  // Y 轴 ticks
  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => ({
    v: data.minV + (data.maxV - data.minV) * (1 - i / yTicks),
    y: pad.t + (i / yTicks) * innerH,
  }));

  return (
    <div ref={wrapRef} style={{ width: "100%", overflowX: "auto" }}>
      <svg width={w} height={h} style={{ display: "block" }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={t.y} y2={t.y} stroke="var(--line)" strokeWidth="0.5" />
            <text x={pad.l - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--text-tertiary)">
              {t.v.toFixed(2)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = data.x(i);
          const yo = data.y(b.open);
          const yc = data.y(b.close);
          const yh = data.y(b.high);
          const yl = data.y(b.low);
          const up = b.close >= b.open;
          const color = up ? "var(--up-color)" : "var(--down-color)";
          const bodyTop = Math.min(yo, yc);
          const bodyH = Math.max(1, Math.abs(yc - yo));
          return (
            <g key={i}>
              {/* 影线 */}
              <line x1={cx} x2={cx} y1={yh} y2={yl} stroke={color} strokeWidth="0.8" />
              {/* 实体 */}
              <rect
                x={cx - data.candleW / 2}
                y={bodyTop}
                width={data.candleW}
                height={bodyH}
                fill={color}
                opacity={up ? 0.85 : 0.85}
              />
              {/* 买卖点 */}
              {tradeMap.has(b.date) && tradeMap.get(b.date).map((t, j) => (
                <g key={j}>
                  <circle
                    cx={cx + (j - 0.5) * 6}
                    cy={t.side === "buy" ? data.y(b.low) - 8 : data.y(b.high) + 8}
                    r="3"
                    fill={t.side === "buy" ? "var(--down-color)" : "var(--up-color)"}
                    stroke="var(--bg)" strokeWidth="0.5"
                  />
                </g>
              ))}
            </g>
          );
        })}
        {/* X 轴日期（首尾 + 中间） */}
        {(() => {
          if (!bars.length) return null;
          const idxs = [0, Math.floor(bars.length / 2), bars.length - 1].filter((i) => i >= 0);
          return idxs.map((i) => (
            <text key={i} x={data.x(i)} y={h - 8} textAnchor="middle" fontSize="10" fill="var(--text-tertiary)">
              {(bars[i].date || "").slice(0, 10)}
            </text>
          ));
        })()}
        {/* 图例 */}
        <g fontSize="11" fill="var(--text-secondary)">
          <circle cx={w - pad.r + 12} cy={pad.t + 4} r="3" fill="var(--down-color)" />
          <text x={w - pad.r + 20} y={pad.t + 7}>买</text>
          <circle cx={w - pad.r + 12} cy={pad.t + 20} r="3" fill="var(--up-color)" />
          <text x={w - pad.r + 20} y={pad.t + 23}>卖</text>
        </g>
      </svg>
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
