/**
 * Heatmap —— A 股行业 treemap 热力图（仿同花顺 L1+L2）
 *
 * 两层结构（自画 SVG，无外部图表库）：
 *   L1：同花顺一级行业（30+ 个），方块大小 = 行业总市值
 *   L2：每个行业内的代表股（3-5 只），方块大小 = 个股市值
 *   颜色：涨跌幅 → 红(涨)/灰(平)/绿(跌) 渐变（-4% ~ +4%）
 *
 * 数据获取：
 *   Query 1: "同花顺一级行业 涨跌幅 总市值 行业代码" → L1
 *   Query 2: "市值前100 股票代码 股票简称 涨跌幅 总市值 行业" → L2
 *   都失败 → 用内置 51 个同花顺行业 fallback
 *
 * 交互：
 *   - hover：tooltip 显示行业/股票名 + 涨跌幅 + 市值
 *   - click：触发 quant:jump-selector，跳到选股 tab
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { postJson, formatPercentText, fuzzyFind, runWithConcurrency } from "../api.js";

// 同花顺一级行业 51 个（数据 fallback / iwencai 拉不到时用）
const THS_INDUSTRIES_FALLBACK = [
  { name: "银行",     code: "BK0475" },
  { name: "证券",     code: "BK0473" },
  { name: "保险",     code: "BK0474" },
  { name: "多元金融", code: "BK0477" },
  { name: "房地产",   code: "BK0451" },
  { name: "汽车整车", code: "BK0481" },
  { name: "汽车零部件", code: "BK0482" },
  { name: "白色家电", code: "BK0456" },
  { name: "黑色家电", code: "BK0457" },
  { name: "白酒",     code: "BK0439" },
  { name: "食品饮料", code: "BK0438" },
  { name: "医药商业", code: "BK0440" },
  { name: "化学制药", code: "BK0441" },
  { name: "中药",     code: "BK0442" },
  { name: "生物制品", code: "BK0443" },
  { name: "医疗器械", code: "BK0444" },
  { name: "医疗服务", code: "BK0445" },
  { name: "半导体",   code: "BK0448" },
  { name: "元件",     code: "BK0449" },
  { name: "消费电子", code: "BK0450" },
  { name: "通信设备", code: "BK0446" },
  { name: "通信服务", code: "BK0447" },
  { name: "计算机",   code: "BK0425" },
  { name: "软件开发", code: "BK0426" },
  { name: "互联网",   code: "BK0427" },
  { name: "传媒",     code: "BK0428" },
  { name: "游戏",     code: "BK0429" },
  { name: "钢铁",     code: "BK0471" },
  { name: "有色金属", code: "BK0478" },
  { name: "煤炭",     code: "BK0437" },
  { name: "石油石化", code: "BK0464" },
  { name: "基础化工", code: "BK0433" },
  { name: "建筑材料", code: "BK0420" },
  { name: "建筑装饰", code: "BK0421" },
  { name: "电力设备", code: "BK0458" },
  { name: "电池",     code: "BK0459" },
  { name: "光伏设备", code: "BK0460" },
  { name: "工程机械", code: "BK0422" },
  { name: "通用设备", code: "BK0423" },
  { name: "国防军工", code: "BK0424" },
  { name: "物流",     code: "BK0430" },
  { name: "航运港口", code: "BK0431" },
  { name: "航空运输", code: "BK0432" },
  { name: "环保",     code: "BK0436" },
  { name: "公用事业", code: "BK0435" },
  { name: "电力",     code: "BK0421" },
  { name: "燃气",     code: "BK0420" },
  { name: "零售",     code: "BK0483" },
  { name: "贸易",     code: "BK0484" },
  { name: "纺织服饰", code: "BK0434" },
  { name: "美容护理", code: "BK0453" },
  { name: "农林牧渔", code: "BK0433" },
  { name: "教育",     code: "BK0740" },
  { name: "旅游酒店", code: "BK0485" },
];

// ---------------- Squarified Treemap ----------------
// Bruls/Huijbregts/Van Wijk 2000
// 输入：items [{weight, ...}], rect {x, y, w, h}
function squarify(items, rect) {
  const total = items.reduce((s, it) => s + (it.weight || 0), 0);
  if (total <= 0 || !items.length) return [];
  const sorted = [...items].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const result = [];
  let x = rect.x, y = rect.y, w = rect.w, h = rect.h;

  const sumArr = (arr) => arr.reduce((s, it) => s + (it.weight || 0), 0);
  const minArr = (arr) => Math.min(...arr.map((it) => it.weight || 0));
  const maxArr = (arr) => Math.max(...arr.map((it) => it.weight || 0));

  const worstRatio = (row, s) => {
    if (s === 0) return Infinity;
    const ss = Math.min(w, h);
    const wmin = minArr(row);
    const wmax = maxArr(row);
    return Math.max(
      (ss * ss * wmax) / (s * s),
      (s * s) / (ss * ss * wmin)
    );
  };

  const layoutRow = (row) => {
    const s = sumArr(row);
    if (s === 0) return;
    if (w >= h) {
      const colW = s / h;
      let cy = y;
      for (const it of row) {
        const ch = (it.weight || 0) / colW;
        result.push({ x, y: cy, w: colW, h: ch, item: it });
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = s / w;
      let cx = x;
      for (const it of row) {
        const cw = (it.weight || 0) / rowH;
        result.push({ x: cx, y, w: cw, h: rowH, item: it });
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
  };

  let row = [];
  let rowSum = 0;
  while (sorted.length) {
    const it = sorted[0];
    const newRow = [...row, it];
    const newSum = rowSum + (it.weight || 0);
    if (row.length === 0) {
      row = newRow;
      rowSum = newSum;
      sorted.shift();
      continue;
    }
    if (worstRatio(newRow, newSum) <= worstRatio(row, rowSum)) {
      row = newRow;
      rowSum = newSum;
      sorted.shift();
    } else {
      layoutRow(row);
      row = [];
      rowSum = 0;
    }
  }
  if (row.length) layoutRow(row);
  return result;
}

// 递归布局：L1 方块内嵌 L2 方块
// 输入：nodes [{weight, pct, name, children?: [...]}], rect
// 输出：[{rect, node, level, isL1}, ...]（已平铺；每个 L1 内嵌其 L2 children）
function layoutTwoLevel(industries, rect) {
  const validL1 = industries.filter((it) => (it.weight || 0) > 0);
  if (!validL1.length) return [];
  const l1Cells = squarify(validL1, rect);
  const out = [];
  for (const c of l1Cells) {
    // L1 节点（行业）
    out.push({ rect: { x: c.x, y: c.y, w: c.w, h: c.h }, node: c.item, level: 1 });
    // L2 children（行业内股票）
    if (c.item.children && c.item.children.length) {
      const validL2 = c.item.children.filter((s) => (s.weight || 0) > 0);
      // 给 L2 留出顶部 L1 标签区（约 18px）—— 仅当 L1 块够大
      const labelH = (c.w >= 80 && c.h >= 50) ? 18 : 0;
      const inner = { x: c.x + 1, y: c.y + 1 + labelH, w: Math.max(0, c.w - 2), h: Math.max(0, c.h - 2 - labelH) };
      const l2Cells = squarify(validL2, inner);
      for (const cc of l2Cells) {
        out.push({ rect: cc, node: cc.item, level: 2, parent: c.item });
      }
    }
  }
  return out;
}

// ---------------- 颜色（仿同花顺色阶，-4% ~ +4%） ----------------
const PCT_MIN = -4;
const PCT_MAX = 4;
function pctColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return "#3a4356";  // 无数据 - 中性灰
  const t = Math.max(-1, Math.min(1, (pct - 0) / PCT_MAX));
  // 4 段插值：深红 → 红 → 灰 → 绿 → 深绿
  // A 股惯例 涨红跌绿
  let r, g, b;
  if (t > 0) {
    // 灰 #3a4356 → 绿 #00a854
    r = Math.round(0x3a + (0x00 - 0x3a) * t);
    g = Math.round(0x43 + (0xa8 - 0x43) * t);
    b = Math.round(0x56 + (0x54 - 0x56) * t);
  } else {
    const k = -t;
    // 灰 #3a4356 → 红 #d8253a
    r = Math.round(0x3a + (0xd8 - 0x3a) * k);
    g = Math.round(0x43 + (0x25 - 0x43) * k);
    b = Math.round(0x56 + (0x3a - 0x56) * k);
  }
  return `rgb(${r},${g},${b})`;
}

function pctTextColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return "#aab3c5";
  const t = Math.abs(pct) / PCT_MAX;
  return t > 0.5 ? "#fff" : "#e6edf3";
}

// ---------------- 组件 ----------------

export default function Heatmap({ data, loading, onError, onRefresh, cacheTs, formatCacheTime, hasKey }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState(null);
  const [activeTime, setActiveTime] = useState("now");

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) setW(Math.max(400, ent.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const h = 720;  // 两层 treemap 需要更高
  const cells = useMemo(() => {
    if (!data || !data.length) return [];
    return layoutTwoLevel(data, { x: 0, y: 0, w, h });
  }, [data, w]);

  const l1Count = data ? data.length : 0;
  const l2Count = data ? data.reduce((s, it) => s + (it.children?.length || 0), 0) : 0;

  return (
    <div className="chart-panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>
          A 股行业热力
          <span className="hint" style={{ marginLeft: 8, fontSize: 11 }}>（同花顺一级行业 · 大小 = 总市值 · 颜色 = 涨跌幅）</span>
        </h4>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {cacheTs > 0 && (
            <span className="hint" style={{ fontSize: 11 }} title={new Date(cacheTs).toLocaleString()}>
              📦 已缓存 {formatCacheTime(cacheTs)}
            </span>
          )}
          <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? <><span className="loader" /> 拉取中</> : "刷新"}
          </button>
        </div>
      </div>

      {!data || !data.length ? (
        <div className="chart-empty" style={{ height: 360 }}>
          {!hasKey
            ? "未配置 iwencai key，无法拉取行业数据"
            : loading
              ? "正在拉取行业涨跌幅…"
              : '暂无数据，点「刷新」试试（需 iwencai key 支持行业聚合查询）'}
        </div>
      ) : (
        <>
          <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
            <svg width={w} height={h} style={{ display: "block", borderRadius: 4, background: "#0b1426" }}>
              {cells.map((c, i) => {
                const isL1 = c.level === 1;
                const r = c.rect;
                const fill = pctColor(c.node.pct);
                const textColor = pctTextColor(c.node.pct);
                return (
                  <g
                    key={i}
                    onMouseEnter={(e) => {
                      const rect = wrapRef.current.getBoundingClientRect();
                      setHover({ ...c.node, level: c.level, parent: c.parent, mx: e.clientX - rect.left, my: e.clientY - rect.top });
                    }}
                    onMouseMove={(e) => {
                      const rect = wrapRef.current.getBoundingClientRect();
                      setHover((h0) => h0 ? { ...h0, mx: e.clientX - rect.left, my: e.clientY - rect.top } : null);
                    }}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => {
                      // 行业（L1）→ 跳到选股；股票（L2）→ 跳到回测单标的
                      if (isL1) {
                        window.dispatchEvent(new CustomEvent("quant:jump-selector", { detail: { name: c.node.name, code: c.node.code } }));
                      } else if (c.node.code) {
                        window.dispatchEvent(new CustomEvent("quant:jump-selector", { detail: { name: c.node.name, code: c.node.code, single: true } }));
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <rect
                      x={r.x + 1}
                      y={r.y + 1}
                      width={Math.max(0, r.w - 2)}
                      height={Math.max(0, r.h - 2)}
                      fill={fill}
                      stroke="#0b1426"
                      strokeWidth="1.5"
                    />
                    {isL1 && r.w > 60 && r.h > 18 && (
                      <text
                        x={r.x + 5}
                        y={r.y + 13}
                        fontSize={Math.min(13, r.w / 7)}
                        fill="var(--text-primary)"
                        className="mono"
                        fontWeight="600"
                        opacity="0.9"
                        style={{ pointerEvents: "none" }}
                      >
                        {c.node.name}
                      </text>
                    )}
                    {!isL1 && r.w > 36 && r.h > 22 && (
                      <>
                        <text
                          x={r.x + r.w / 2}
                          y={r.y + r.h / 2 - 2}
                          textAnchor="middle"
                          fontSize={Math.min(12, r.w / 4.5)}
                          fill={textColor}
                          className="mono"
                          fontWeight="600"
                          style={{ pointerEvents: "none" }}
                        >
                          {c.node.name}
                        </text>
                        {c.node.pct != null && r.h > 32 && (
                          <text
                            x={r.x + r.w / 2}
                            y={r.y + r.h / 2 + 12}
                            textAnchor="middle"
                            fontSize={Math.min(11, r.w / 5.5)}
                            fill={textColor}
                            className="mono"
                            opacity="0.95"
                            style={{ pointerEvents: "none" }}
                          >
                            {formatPercentText(c.node.pct)}
                          </text>
                        )}
                      </>
                    )}
                  </g>
                );
              })}
            </svg>

            {hover && (
              <div
                style={{
                  position: "absolute",
                  left: Math.min((hover.mx || 0) + 14, w - 240),
                  top: Math.max(0, (hover.my || 0) - 8),
                  background: "var(--bg-elev)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 11,
                  color: "var(--text-primary)",
                  pointerEvents: "none",
                  zIndex: 5,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                  minWidth: 200,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div style={{ color: "var(--ink)", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  {hover.level === 2 && hover.parent ? `${hover.parent.name} · ${hover.name}` : hover.name}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 2 }}>
                  <span style={{ color: "var(--text-secondary)" }}>代码</span>
                  <span>{hover.code || "--"}</span>
                  <span style={{ color: "var(--text-secondary)" }}>涨跌幅</span>
                  <span style={{ color: (hover.pct ?? 0) >= 0 ? "var(--down-color)" : "var(--up-color)", fontWeight: 600 }}>
                    {formatPercentText(hover.pct)}
                  </span>
                  {hover.weight > 0 && (
                    <>
                      <span style={{ color: "var(--text-secondary)" }}>权重</span>
                      <span>{formatMcap(hover.weight)}</span>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--line)", color: "var(--text-tertiary)", fontSize: 10 }}>
                  点击 → {hover.level === 1 ? "选股 tab 自动填入该行业" : "选股 tab 自动填入该股票"}
                </div>
              </div>
            )}
          </div>

          {/* 底部：时间轴占位 + 色阶图例 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span className="inline-action" style={{ background: "var(--bg-surface)", color: "var(--text-tertiary)", borderColor: "var(--line)", fontSize: 11 }}>
                关闭复盘
              </span>
              {["09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00"].map((t) => (
                <button
                  key={t}
                  type="button"
                  className="inline-action"
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    color: t === activeTime ? "var(--accent)" : "var(--text-tertiary)",
                    borderColor: t === activeTime ? "var(--accent)" : "var(--line)",
                    background: t === activeTime ? "var(--accent-soft)" : "transparent",
                  }}
                  onClick={() => t === "15:00" && setActiveTime(t)}
                  disabled={t !== "15:00"}
                  title={t !== "15:00" ? "历史回放需要历史数据快照（暂未启用）" : ""}
                >
                  {t}
                </button>
              ))}
              <span className="hint" style={{ fontSize: 11, marginLeft: 8 }}>{l1Count} 行业 · {l2Count} 股票</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-tertiary)" }}>
              {[-4, -3, -2, -1, 0, 1, 2, 3, 4].map((p) => (
                <span
                  key={p}
                  style={{
                    background: pctColor(p),
                    color: pctTextColor(p),
                    padding: "3px 6px",
                    borderRadius: 3,
                    fontFamily: "var(--font-mono)",
                    minWidth: 28,
                    textAlign: "center",
                  }}
                >
                  {p > 0 ? `+${p}` : p}%
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- 数据获取（两阶段：热度前 10 行业 → 每行业 top 10 成分股） ----------------

export async function fetchIndustryHeatmap(hasIwencaiKey) {
  if (!hasIwencaiKey) return { items: [], fallback: true };

  // 阶段 1：拉今日热度前 10 的行业
  const L1_QUERIES = [
    "同花顺行业热度榜 涨跌幅 行业代码",
    "今日热门行业 涨跌幅 行业代码 流通市值",
    "同花顺热门行业 涨跌幅 行业代码",
    "申万一级行业 涨跌幅 总市值 行业代码",
  ];
  let l1 = null;
  for (const q of L1_QUERIES) {
    try {
      const res = await postJson("/api/query", { query: q, limit: 15 });
      if (res && Array.isArray(res.datas) && res.datas.length >= 5) {
        const items = res.datas
          .map((row) => {
            const name = row["同花顺一级行业"] || row["同花顺行业"] || row["申万一级行业"] || row["行业名称"] || row["行业简称"];
            const code = row["行业代码"] || row["代码"];
            const pct = parseFloat(fuzzyFind(row, ["涨跌幅", "涨幅"]));
            const mcap = parseFloat(fuzzyFind(row, ["流通市值", "总市值"]));
            return { name: String(name || "").trim(), code, pct: Number.isFinite(pct) ? pct : null, weight: Number.isFinite(mcap) && mcap > 0 ? mcap : 0 };
          })
          .filter((it) => it.name && it.name !== "--" && it.name !== "nan" && !/^[\d]+$/.test(it.name));
        if (items.length >= 5) {
          l1 = items.slice(0, 10);
          break;
        }
      }
    } catch (e) { /* try next */ }
  }

  if (!l1 || l1.length === 0) {
    // fallback：51 行业（无 L2 子项，保证至少能看到行业名）
    return {
      items: THS_INDUSTRIES_FALLBACK.slice(0, 15).map((it) => ({ ...it, pct: null, weight: 1, children: [] })),
      fallback: true,
    };
  }

  // 阶段 2：对每个行业并发拉 top 10 成分股（流通市值 / 涨跌幅 / 股票代码 / 股票简称）
  // 用 Semaphore(5) 限流，避免打爆 iwencai QPS
  const stocksByIndustry = {};
  await runWithConcurrency(l1, 5, async (ind) => {
    try {
      const q = `同花顺一级行业 ${ind.name} 成分股 股票代码 股票简称 涨跌幅 流通市值`;
      const res = await postJson("/api/query", { query: q, limit: 10 });
      if (res && Array.isArray(res.datas) && res.datas.length > 0) {
        const stocks = res.datas
          .map((row) => {
            const code = row["股票代码"] || row["code"];
            const name = row["股票简称"];
            const pct = parseFloat(fuzzyFind(row, ["涨跌幅", "涨幅"]));
            const mcap = parseFloat(fuzzyFind(row, ["流通市值", "总市值"]));
            if (!name) return null;
            return { name: String(name).trim(), code, pct: Number.isFinite(pct) ? pct : null, weight: Number.isFinite(mcap) && mcap > 0 ? mcap : 0 };
          })
          .filter(Boolean);
        // 排序取 top 10（按流通市值降序）
        stocks.sort((a, b) => b.weight - a.weight);
        stocksByIndustry[ind.name] = stocks.slice(0, 10);
      }
    } catch (e) { /* skip */ }
  });

  // 拼装：行业 + 子项；行业 weight 兜底 = 子项市值之和
  const items = l1.map((ind) => {
    const children = stocksByIndustry[ind.name] || [];
    const childSum = children.reduce((s, x) => s + (x.weight || 0), 0);
    return {
      ...ind,
      weight: ind.weight > 0 ? ind.weight : (childSum > 0 ? childSum : 1),
      children,
    };
  });

  return { items, fallback: false, queriedAt: Date.now() };
}

export function formatMcap(v) {
  if (v == null || !Number.isFinite(v)) return "--";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "万亿";
  if (v >= 1e8) return (v / 1e8).toFixed(0) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return v.toString();
}
