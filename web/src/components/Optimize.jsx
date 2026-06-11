/**
 * Optimize —— 参数寻优
 *
 * 后端响应（quant/services/optimize.py run_grid_search）：
 *   - optimization_results: [{ params, summary }, ...]
 *   - optimization_errors: [{ params, error }, ...]
 *   - heatmap_total_return / heatmap_annual_return / heatmap_max_drawdown
 *     / heatmap_sharpe_ratio / heatmap_win_rate / heatmap_trade_count  (2 参时)
 *   - best_by_return / best_by_calmar
 *   - top_robust: [{ params, calmar, summary }, ...]   按 Calmar 降序前 10
 *   - param_importance: [{ param, importance, values, means }, ...]   0..1 已归一化
 *
 * 维度分派：
 *   1 参 → 折线图（每个 x 选最佳 y）+ 完整结果表
 *   2 参 → 热力图（metric toggle 切换 6 个指标）+ 完整结果表
 *   3+ 参 → 参数重要性条形图 + Top 10 鲁棒表 + 完整结果表
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { postJson, money, percent, numberOrDash, formatPercentText } from "../api.js";

const METRICS = [
  { key: "total_return",  label: "总收益",   fmt: formatPercentText, higherIsBetter: true },
  { key: "annual_return", label: "年化收益", fmt: formatPercentText, higherIsBetter: true },
  { key: "max_drawdown",  label: "最大回撤", fmt: formatPercentText, higherIsBetter: false },
  { key: "sharpe_ratio",  label: "夏普",     fmt: (v) => numberOrDash(v, 2), higherIsBetter: true },
  { key: "win_rate",      label: "胜率",     fmt: formatPercentText, higherIsBetter: true },
  { key: "trade_count",   label: "交易数",   fmt: (v) => String(v ?? 0), higherIsBetter: true },
];

const metricByKey = (k) => METRICS.find((m) => m.key === k) || METRICS[0];

export default function Optimize({ hasIwencaiKey, onError, onStatus }) {
  const [strategies, setStrategies] = useState([]);
  const [strategy, setStrategy] = useState("moving_average");
  const [symbol, setSymbol] = useState("000001.SZ");
  const [startDate, setStartDate] = useState("2024-01-01");
  const [endDate, setEndDate] = useState("2024-12-31");
  // 每参数对应的"取值列表" (从 default_grid 拉默认，用户可改)
  const [paramRanges, setParamRanges] = useState({});
  const [metric, setMetric] = useState("total_return");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // 拉策略
  useEffect(() => {
    postJson("/api/strategies", {})
      .then((d) => setStrategies(d?.strategies || []))
      .catch((e) => onError?.(e));
  }, [onError]);

  // 策略变化：初始化 paramRanges 为 default_grid
  useEffect(() => {
    const spec = strategies.find((s) => s.name === strategy);
    if (spec) setParamRanges({ ...spec.default_grid });
  }, [strategy, strategies]);

  const spec = strategies.find((s) => s.name === strategy);
  const paramKeys = Object.keys(paramRanges);
  const nParams = paramKeys.length;

  const submit = async (e) => {
    e?.preventDefault?.();
    setLoading(true);
    setResult(null);
    try {
      const data = await postJson("/api/optimize", {
        strategy,
        param_ranges: paramRanges,
        start_date: startDate,
        end_date: endDate,
        query: "",
        symbol,
        limit: 100,
        max_pages: 10,
      });
      if (data && Array.isArray(data.optimization_results)) {
        setResult(data);
        const n = data.combinations;
        onStatus?.(`寻优完成：${n} 组合 · ${data.parallel ? `并行 ${data.n_jobs} 核` : "顺序"}`);
      } else {
        throw new Error(data?.error || "寻优失败");
      }
    } catch (e) {
      onError?.(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="form-view">
      {/* ===== 参数网格（输入） ===== */}
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label>策略</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {strategies.map((s) => (
                <option key={s.name} value={s.name}>{s.display_name}</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label>股票代码 / 名称</label>
            <input
              className="mono"
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="例：000001.SZ"
              required
            />
          </div>
          <div className="form-field">
            <label>开始日期</label>
            <input className="mono" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div className="form-field">
            <label>结束日期</label>
            <input className="mono" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
        </div>

        {spec && paramKeys.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="optimize-header">
              <h3 style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>参数网格（逗号分隔）</h3>
              <span className="hint">
                组合数 = ∏ len(values)：<b style={{ color: "var(--accent)" }}>{countCombinations(paramRanges)}</b>
              </span>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              {paramKeys.map((k) => (
                <div className="form-field" key={k}>
                  <label>{k}</label>
                  <input
                    className="mono"
                    type="text"
                    value={csvJoin(paramRanges[k])}
                    onChange={(e) => {
                      const arr = csvSplit(e.target.value).map((s) => {
                        const n = Number(s);
                        return Number.isFinite(n) && s.trim() !== "" ? n : s;
                      });
                      setParamRanges({ ...paramRanges, [k]: arr });
                    }}
                  />
                  <span className="hint">{spec.default_grid?.[k] ? "默认: " + csvJoin(spec.default_grid[k]) : "用逗号分隔多值"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={loading || !hasIwencaiKey}>
            {loading ? <><span className="loader" /> 寻优中...</> : "开始寻优"}
          </button>
          {!hasIwencaiKey && <span className="hint" style={{ color: "var(--up-color)" }}>需先在右上角配置 iwencai key</span>}
        </div>
      </form>

      {/* ===== 寻优结果 ===== */}
      {result && <OptimizeResult data={result} nParams={nParams} metric={metric} setMetric={setMetric} />}
    </section>
  );
}

// ---- 工具 ----

function csvJoin(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((v) => String(v)).join(",");
}
function csvSplit(s) {
  return String(s).split(/[,，\s]+/).filter(Boolean);
}
function countCombinations(ranges) {
  let n = 1;
  for (const v of Object.values(ranges)) {
    if (Array.isArray(v) && v.length > 0) n *= v.length;
  }
  return n;
}

// ---- 结果区 ----

function OptimizeResult({ data, nParams, metric, setMetric }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
      <div className="optimize-header">
        <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>寻优结果</h3>
        <span className="metric-toggle" hidden={nParams !== 1 && nParams !== 2}>
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={m.key === metric ? "active" : ""}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </span>
      </div>

      {nParams === 1 && <ParamLineChart data={data} metric={metric} />}
      {nParams === 2 && <ParamHeatmap data={data} metric={metric} />}
      {nParams >= 3 && <ParamImportance data={data} />}

      {nParams >= 2 && <TopRobustTable data={data} />}
      {nParams >= 1 && <FullResultsTable data={data} />}

      {data.optimization_errors?.length > 0 && (
        <div className="error-box">
          失败 {data.optimization_errors.length} 个组合：
          <pre style={{ margin: "6px 0 0", fontSize: 11, whiteSpace: "pre-wrap" }}>
            {data.optimization_errors.slice(0, 5).map((e) => `${JSON.stringify(e.params)}: ${e.error}`).join("\n")}
            {data.optimization_errors.length > 5 && `\n... 另有 ${data.optimization_errors.length - 5} 个`}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---- 1 参：折线图 ----

function ParamLineChart({ data, metric }) {
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

  const results = data.optimization_results || [];
  if (!results.length) return <div className="chart-empty">无结果</div>;
  const m = metricByKey(metric);
  const xKey = Object.keys(results[0].params || {})[0];
  const pts = results.map((r) => ({ x: r.params[xKey], y: r[metric], params: r.params }));
  // X 排序
  pts.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));

  const h = 280;
  const pad = { l: 50, r: 20, t: 30, b: 40 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const ys = pts.map((p) => p.y).filter((v) => v != null);
  const minV = Math.min(...ys);
  const maxV = Math.max(...ys);
  const range = maxV - minV || 1;
  const n = pts.length;
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const xVals = pts.map((p) => p.x);
  const xPos = (i) => pad.l + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yPos = (v) => pad.t + (1 - (v - minV) / range) * innerH;

  // 最佳
  const bestReturn = pts.find((p) => JSON.stringify(p.params) === JSON.stringify(data.best_by_return));
  const bestCalmar = (data.top_robust || [])[0];

  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(p.y ?? minV).toFixed(1)}`).join(" ");
  // y ticks
  const yTicks = 4;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => ({
    v: minV + (maxV - minV) * (1 - i / yTicks),
    y: pad.t + (i / yTicks) * innerH,
  }));

  return (
    <div className="chart-panel" ref={wrapRef}>
      <h4>{m.label} vs {xKey}</h4>
      <svg width={w} height={h} style={{ display: "block" }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={t.y} y2={t.y} stroke="var(--line)" strokeWidth="0.5" />
            <text x={pad.l - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--text-tertiary)">
              {isNum(t.v) ? (t.v * (m.key === "sharpe_ratio" || m.key === "trade_count" ? 1 : 100)).toFixed(1) : ""}
              {m.key !== "sharpe_ratio" && m.key !== "trade_count" ? "%" : ""}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
        {pts.map((p, i) => (
          <circle key={i} cx={xPos(i)} cy={yPos(p.y ?? minV)} r="3" fill="var(--accent)" />
        ))}
        {bestReturn && (
          <g>
            <circle cx={xPos(pts.indexOf(bestReturn))} cy={yPos(bestReturn.y)} r="7" fill="none" stroke="var(--gold)" strokeWidth="2" />
            <text x={xPos(pts.indexOf(bestReturn))} y={yPos(bestReturn.y) - 12} textAnchor="middle" fontSize="14" fill="var(--gold)">⭐</text>
          </g>
        )}
        {bestCalmar && bestCalmar.params && JSON.stringify(bestCalmar.params) !== JSON.stringify(data.best_by_return) && (
          (() => {
            const i = pts.findIndex((p) => JSON.stringify(p.params) === JSON.stringify(bestCalmar.params));
            if (i < 0) return null;
            return (
              <g>
                <circle cx={xPos(i)} cy={yPos(pts[i].y)} r="6" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="2,2" />
                <text x={xPos(i)} y={yPos(pts[i].y) + 20} textAnchor="middle" fontSize="14" fill="var(--accent)">🎯</text>
              </g>
            );
          })()
        )}
        {/* X 轴标签 */}
        {pts.map((p, i) => (
          <text key={i} x={xPos(i)} y={h - 8} textAnchor="middle" fontSize="10" fill="var(--text-tertiary)">
            {String(p.x)}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ---- 2 参：热力图 ----

function ParamHeatmap({ data, metric }) {
  const heat = data[`heatmap_${metric}`];
  const m = metricByKey(metric);
  if (!heat) return <div className="chart-empty">无热力图数据</div>;

  const xs = heat.x_values.map(String);
  const ys = heat.y_values.map(String);
  const zRaw = heat.z_values;
  // 颜色归一化：null 跳过；higherIsBetter 决定方向
  const flat = zRaw.flat().filter((v) => v != null && Number.isFinite(v));
  if (!flat.length) return <div className="chart-empty">热力图无有效数据</div>;
  const minV = Math.min(...flat);
  const maxV = Math.max(...flat);
  const range = maxV - minV || 1;
  // 0..1 normalize，然后按方向决定颜色映射
  const norm = (v) => {
    if (v == null) return null;
    const t = (v - minV) / range;
    return m.higherIsBetter ? t : 1 - t;  // higher is better → 蓝青，worse → 红
  };
  const color = (v) => {
    const t = norm(v);
    if (t == null) return "var(--bg-elev)";
    // 渐变 红(#ff4757) → 灰 → 蓝青(#4ea8ff)
    if (t < 0.5) {
      const k = t / 0.5;
      return mix("var(--up-color)", "var(--text-tertiary)", k);
    } else {
      const k = (t - 0.5) / 0.5;
      return mix("var(--text-tertiary)", "var(--accent)", k);
    }
  };
  const cellW = 80;
  const cellH = 28;
  const padL = 90;
  const padT = 50;
  const w = padL + xs.length * cellW + 30;
  const h = padT + ys.length * cellH + 40;

  const bestReturn = data.best_by_return;
  const bestCalmar = data.best_by_calmar;
  const findCell = (params) => {
    if (!params) return null;
    const i = xs.indexOf(String(params[heat.x_key]));
    const j = ys.indexOf(String(params[heat.y_key]));
    if (i < 0 || j < 0) return null;
    return { i, j };
  };

  return (
    <div className="chart-panel" style={{ overflowX: "auto" }}>
      <h4>{heat.x_key} × {heat.y_key} → {m.label}</h4>
      <svg width={w} height={h} style={{ display: "block" }}>
        {/* Y 轴标签 */}
        {ys.map((y, j) => (
          <text key={j} x={padL - 6} y={padT + j * cellH + cellH / 2 + 4} textAnchor="end" fontSize="11" fill="var(--text-secondary)" className="mono">
            {y}
          </text>
        ))}
        {/* X 轴标签（顶部） */}
        {xs.map((x, i) => (
          <text key={i} x={padL + i * cellW + cellW / 2} y={padT - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)" className="mono">
            {x}
          </text>
        ))}
        {/* 单元格 */}
        {zRaw.map((row, j) => row.map((v, i) => {
          const fill = color(v);
          const cx = padL + i * cellW;
          const cy = padT + j * cellH;
          return (
            <g key={`${j}-${i}`}>
              <rect x={cx} y={cy} width={cellW - 1} height={cellH - 1} fill={fill} />
              <text x={cx + cellW / 2} y={cy + cellH / 2 + 4} textAnchor="middle" fontSize="11" fill={norm(v) > 0.5 ? "#06121f" : "var(--ink)"} className="mono">
                {v == null ? "—" : m.key === "sharpe_ratio" || m.key === "trade_count" ? Number(v).toFixed(m.key === "sharpe_ratio" ? 2 : 0) : (v * 100).toFixed(2) + "%"}
              </text>
            </g>
          );
        }))}
        {/* 最佳标记 */}
        {(() => {
          const c1 = findCell(bestReturn);
          if (!c1) return null;
          return (
            <text x={padL + c1.i * cellW + cellW - 6} y={padT + c1.j * cellH + 14} fontSize="14" fill="var(--gold)">⭐</text>
          );
        })()}
        {(() => {
          if (!bestCalmar || JSON.stringify(bestCalmar) === JSON.stringify(bestReturn)) return null;
          const c = findCell(bestCalmar);
          if (!c) return null;
          return (
            <text x={padL + c.i * cellW + cellW - 6} y={padT + c.j * cellH + cellH - 4} fontSize="13" fill="var(--accent)">🎯</text>
          );
        })()}
        {/* 图例 */}
        <g fontSize="11" fill="var(--text-tertiary)">
          <rect x={padL} y={h - 24} width={14} height={10} fill="var(--up-color)" />
          <text x={padL + 18} y={h - 15}>最差</text>
          <rect x={padL + 60} y={h - 24} width={14} height={10} fill="var(--text-tertiary)" />
          <text x={padL + 78} y={h - 15}>中位</text>
          <rect x={padL + 120} y={h - 24} width={14} height={10} fill="var(--accent)" />
          <text x={padL + 138} y={h - 15}>最佳</text>
          <text x={w - 100} y={h - 15}>⭐ 收益最佳 · 🎯 Calmar 最佳</text>
        </g>
      </svg>
    </div>
  );
}

// CSS 变量到 RGB 简版（用于 mix）
function mix(c1, c2, t) {
  const rgb = {
    "var(--up-color)": [255, 71, 87],
    "var(--down-color)": [0, 214, 143],
    "var(--accent)": [78, 168, 255],
    "var(--text-tertiary)": [90, 100, 120],
    "var(--bg-elev)": [24, 34, 58],
  };
  const a = rgb[c1] || [128, 128, 128];
  const b = rgb[c2] || [128, 128, 128];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ---- 3+ 参：参数重要性 ----

function ParamImportance({ data }) {
  const imp = data.param_importance || [];
  if (!imp.length) return null;
  return (
    <div className="chart-panel">
      <h4>参数重要性（哪个参数最影响{metricByKey("total_return").label}？）</h4>
      <div className="importance-wrap">
        {imp.map((it) => (
          <div
            className="importance-bar"
            key={it.param}
            title={it.param + "\n重要性 = " + it.importance.toFixed(3) +
              "\n各取值均值: " + it.values.map((v, i) => `${v} → ${(it.means[i] * 100).toFixed(2)}%`).join("\n          ")}
          >
            <div className="name">{it.param}</div>
            <div className="track">
              <div className="fill" style={{ width: `${(it.importance * 100).toFixed(1)}%` }} />
            </div>
            <div className="val">{it.importance.toFixed(2)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Top 10 鲁棒表 ----

function TopRobustTable({ data }) {
  const top = data.top_robust || [];
  if (!top.length) return null;
  return (
    <div>
      <h4 style={{ margin: "8px 0", color: "var(--ink)", fontSize: 13 }}>Top 10 鲁棒组合（按 Calmar 排序）</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "center" }}>排名</th>
              <th style={{ textAlign: "left" }}>参数</th>
              <th>总收益</th>
              <th>最大回撤</th>
              <th>Calmar</th>
              <th>夏普</th>
              <th>胜率</th>
              <th>交易数</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r, i) => {
              const isRet = JSON.stringify(r.params) === JSON.stringify(data.best_by_return);
              const isCal = JSON.stringify(r.params) === JSON.stringify(data.best_by_calmar);
              return (
                <tr key={i} className={`${isRet ? "best-combo" : ""}${isCal ? " calmar" : ""}`}>
                  <td style={{ textAlign: "center" }}>
                    {i + 1}
                    {isRet && <span className="gold-star" title="总收益最高">⭐</span>}
                    {isCal && <span className="cyan-star" title="Calmar 最高">🎯</span>}
                  </td>
                  <td style={{ textAlign: "left" }} className="mono">
                    {Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </td>
                  <td className={pctCls(r.total_return)}>{formatPercentText(r.total_return)}</td>
                  <td>{formatPercentText(r.max_drawdown)}</td>
                  <td><b>{r.calmar.toFixed(2)}</b></td>
                  <td>{numberOrDash(r.sharpe_ratio, 2)}</td>
                  <td>{formatPercentText(r.win_rate)}</td>
                  <td>{r.trade_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- 完整结果表 ----

function FullResultsTable({ data }) {
  const results = data.optimization_results || [];
  if (!results.length) return null;
  return (
    <div>
      <h4 style={{ margin: "8px 0", color: "var(--ink)", fontSize: 13 }}>全部 {results.length} 组合</h4>
      <div className="table-wrap" style={{ maxHeight: 360 }}>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>参数</th>
              <th>总收益</th>
              <th>年化</th>
              <th>最大回撤</th>
              <th>夏普</th>
              <th>胜率</th>
              <th>交易数</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const isRet = JSON.stringify(r.params) === JSON.stringify(data.best_by_return);
              const isCal = JSON.stringify(r.params) === JSON.stringify(data.best_by_calmar);
              return (
                <tr key={i} className={`${isRet ? "best-combo" : ""}${isCal ? " calmar" : ""}`}>
                  <td style={{ textAlign: "left" }} className="mono">
                    {isRet && <span className="gold-star">⭐</span>}
                    {isCal && <span className="cyan-star">🎯</span>}
                    {Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </td>
                  <td className={pctCls(r.total_return)}>{formatPercentText(r.total_return)}</td>
                  <td className={pctCls(r.annual_return)}>{formatPercentText(r.annual_return)}</td>
                  <td>{formatPercentText(r.max_drawdown)}</td>
                  <td>{numberOrDash(r.sharpe_ratio, 2)}</td>
                  <td>{formatPercentText(r.win_rate)}</td>
                  <td>{r.trade_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pctCls(v) {
  if (v == null) return "";
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "";
}
