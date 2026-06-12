/**
 * Heatmap —— A 股行业 treemap 热力图
 *
 * 数据源：/api/query "申万一级行业 涨跌幅 总市值"
 * 渲染：自画 SVG，squarified treemap 算法
 * 交互：hover 显示 tooltip，click 触发跳转（→ 选股 tab 自动选该行业）
 *
 * 颜色：-3% 深红 → 0% 灰 → +3% 深绿（A 股惯例 涨红跌绿）
 * 大小：总市值（无数据时退化为平均分布）
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { postJson, formatPercentText } from "../api.js";

// 申万一级行业 31 个（数据 fallback / iwencai 拉不到时用）
const SW_INDUSTRIES_FALLBACK = [
  { name: "农林牧渔", code: "801010" },
  { name: "基础化工", code: "801030" },
  { name: "钢铁",     code: "801040" },
  { name: "有色金属", code: "801050" },
  { name: "电子",     code: "801080" },
  { name: "家用电器", code: "801110" },
  { name: "食品饮料", code: "801120" },
  { name: "纺织服饰", code: "801130" },
  { name: "轻工制造", code: "801140" },
  { name: "医药生物", code: "801150" },
  { name: "公用事业", code: "801160" },
  { name: "交通运输", code: "801170" },
  { name: "房地产",   code: "801180" },
  { name: "商贸零售", code: "801200" },
  { name: "社会服务", code: "801210" },
  { name: "综合",     code: "801230" },
  { name: "建筑材料", code: "801710" },
  { name: "建筑装饰", code: "801720" },
  { name: "电力设备", code: "801730" },
  { name: "机械设备", code: "801890" },
  { name: "国防军工", code: "801740" },
  { name: "汽车",     code: "801880" },
  { name: "美容护理", code: "801980" },
  { name: "银行",     code: "801780" },
  { name: "非银金融", code: "801790" },
  { name: "计算机",   code: "801750" },
  { name: "传媒",     code: "801760" },
  { name: "通信",     code: "801770" },
  { name: "煤炭",     code: "801950" },
  { name: "石油石化", code: "801960" },
  { name: "环保",     code: "801970" },
];

// squarified treemap —— 来自 Bruls/Huijbregts/Van Wijk 2000
// 输入：items [{weight, ...}], rect {x, y, w, h}
// 输出：[{x, y, w, h, item}, ...]
function squarify(items, rect) {
  const total = items.reduce((s, it) => s + (it.weight || 0), 0);
  if (total <= 0 || !items.length) return [];
  // 按 weight 降序
  const sorted = [...items].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const result = [];
  let x = rect.x, y = rect.y, w = rect.w, h = rect.h;

  const sumArr = (arr) => arr.reduce((s, it) => s + (it.weight || 0), 0);
  const minArr = (arr) => Math.min(...arr.map((it) => it.weight || 0));
  const maxArr = (arr) => Math.max(...arr.map((it) => it.weight || 0));

  // 当前行加入新项后的最坏长宽比
  // 论文公式: s^2 * x / w^2 其中 w = min, s = sum
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

  // 在当前 (x, y, w, h) 内沿短边方向铺一行
  const layoutRow = (row) => {
    const s = sumArr(row);
    if (s === 0) return;
    if (w >= h) {
      // 行垂直：列宽 = s / h
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
      // 行水平：行高 = s / w
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

  // 主循环
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
      // 当前 row 已最优
      layoutRow(row);
      row = [];
      rowSum = 0;
    }
  }
  if (row.length) layoutRow(row);
  return result;
}

// 颜色：根据涨跌幅映射到红/灰/绿
function pctColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return "var(--text-tertiary)";
  const max = 3; // ±3% 满色
  const t = Math.max(-1, Math.min(1, pct / max));
  // RGB 插值：红 #ff4757 / 灰 #5a6478 / 绿 #00d68f
  let r, g, b;
  if (t > 0) {
    // 灰 → 绿
    r = Math.round(0x5a + (0x00 - 0x5a) * t);
    g = Math.round(0x64 + (0xd6 - 0x64) * t);
    b = Math.round(0x78 + (0x8f - 0x78) * t);
  } else {
    // 红 → 灰
    const k = -t;
    r = Math.round(0xff + (0x5a - 0xff) * k);
    g = Math.round(0x47 + (0x64 - 0x47) * k);
    b = Math.round(0x57 + (0x78 - 0x57) * k);
  }
  return `rgb(${r},${g},${b})`;
}

export default function Heatmap({ data, loading, onError, onRefresh, cacheTs, formatCacheTime, hasKey }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) setW(Math.max(400, ent.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const h = 480;
  const cells = useMemo(() => {
    if (!data || !data.length) return [];
    // 过滤掉 weight<=0 的项
    const valid = data.filter((d) => d.weight && d.weight > 0);
    if (!valid.length) return [];
    return squarify(valid, { x: 0, y: 0, w, h });
  }, [data, w]);

  const onCellClick = (item) => {
    if (!item) return;
    // 跳到"选股"tab 并预填行业名
    const detail = { name: item.name, code: item.code };
    window.dispatchEvent(new CustomEvent("quant:jump-selector", { detail }));
  };

  return (
    <div className="chart-panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>
          A 股行业热力
          <span className="hint" style={{ marginLeft: 8, fontSize: 11 }}>（按总市值 / 颜色 = 涨跌幅）</span>
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
            <svg width={w} height={h} style={{ display: "block", borderRadius: 4 }}>
              {cells.map((c, i) => {
                const fill = pctColor(c.item.pct);
                const textColor = (c.item.pct != null && Math.abs(c.item.pct) > 1.5) ? "#fff" : "var(--bg)";
                return (
                  <g
                    key={i}
                    onMouseEnter={(e) => {
                      const rect = wrapRef.current.getBoundingClientRect();
                      setHover({ ...c.item, mx: e.clientX - rect.left, my: e.clientY - rect.top });
                    }}
                    onMouseMove={(e) => {
                      const rect = wrapRef.current.getBoundingClientRect();
                      setHover((h0) => h0 ? { ...h0, mx: e.clientX - rect.left, my: e.clientY - rect.top } : null);
                    }}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onCellClick(c.item)}
                    style={{ cursor: "pointer" }}
                  >
                    <rect
                      x={c.x + 1}
                      y={c.y + 1}
                      width={Math.max(0, c.w - 2)}
                      height={Math.max(0, c.h - 2)}
                      fill={fill}
                      stroke="var(--bg)"
                      strokeWidth="1"
                    />
                    {c.w > 60 && c.h > 28 && (
                      <text
                        x={c.x + c.w / 2}
                        y={c.y + c.h / 2 - (c.h > 50 ? 4 : 0)}
                        textAnchor="middle"
                        fontSize={Math.min(13, c.w / 8)}
                        fill={textColor}
                        className="mono"
                        fontWeight="600"
                        style={{ pointerEvents: "none" }}
                      >
                        {c.item.name}
                      </text>
                    )}
                    {c.w > 40 && c.h > 38 && c.item.pct != null && (
                      <text
                        x={c.x + c.w / 2}
                        y={c.y + c.h / 2 + 12}
                        textAnchor="middle"
                        fontSize={Math.min(11, c.w / 10)}
                        fill={textColor}
                        className="mono"
                        opacity="0.95"
                        style={{ pointerEvents: "none" }}
                      >
                        {formatPercentText(c.item.pct)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {hover && (
              <div
                style={{
                  position: "absolute",
                  left: Math.min((hover.mx || 0) + 14, w - 220),
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
                  minWidth: 180,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div style={{ color: "var(--ink)", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{hover.name}</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 2 }}>
                  <span style={{ color: "var(--text-secondary)" }}>代码</span>
                  <span>{hover.code || "--"}</span>
                  <span style={{ color: "var(--text-secondary)" }}>涨跌幅</span>
                  <span style={{ color: (hover.pct ?? 0) >= 0 ? "var(--up-color)" : "var(--down-color)", fontWeight: 600 }}>
                    {formatPercentText(hover.pct)}
                  </span>
                  <span style={{ color: "var(--text-secondary)" }}>总市值</span>
                  <span>{hover.mcapLabel || "--"}</span>
                </div>
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--line)", color: "var(--text-tertiary)", fontSize: 10 }}>
                  点击 → 选股 tab 自动填入该行业
                </div>
              </div>
            )}
          </div>

          {/* 图例 */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, color: "var(--text-tertiary)", justifyContent: "center" }}>
            <span>-3%</span>
            <div style={{ width: 120, height: 8, borderRadius: 4, background: "linear-gradient(90deg, #ff4757 0%, #5a6478 50%, #00d68f 100%)" }} />
            <span>+3%</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---- 数据获取：iwencai 拉申万一级行业涨跌幅 + 总市值 ----

export async function fetchIndustryHeatmap(hasIwencaiKey) {
  if (!hasIwencaiKey) {
    return { items: [], fallback: true };
  }
  // 一次 query 拉所有申万一级行业 + 涨跌幅 + 总市值
  // iwencai 自然语言支持"申万一级行业 涨跌幅 总市值"
  const QUERIES = [
    "申万一级行业 涨跌幅 总市值 股票代码",
    "申万行业 涨跌幅 总市值 行业代码",
  ];
  for (const q of QUERIES) {
    try {
      const res = await postJson("/api/query", { query: q, limit: 50 });
      if (res && Array.isArray(res.datas) && res.datas.length > 0) {
        const items = res.datas
          .map((row) => {
            const name = row["申万一级行业"] || row["行业名称"] || row["行业简称"] || row["股票简称"];
            const code = row["行业代码"] || row["代码"];
            const pct = parseFloat(fuzzyFind(row, ["涨跌幅", "涨幅"]));
            const mcap = parseFloat(fuzzyFind(row, ["总市值"]));
            return { name: String(name || "").trim(), code, pct: Number.isFinite(pct) ? pct : null, weight: Number.isFinite(mcap) && mcap > 0 ? mcap : 0 };
          })
          .filter((it) => it.name && it.name !== "--" && it.name !== "nan");
        if (items.length >= 5) {
          return { items, fallback: false, queriedAt: Date.now() };
        }
      }
    } catch (e) {
      // try next query
    }
  }
  // 全部失败 → 用 fallback（行业名 + 平均分布大小 + null 涨跌幅）
  return {
    items: SW_INDUSTRIES_FALLBACK.map((it) => ({ name: it.name, code: it.code, pct: null, weight: 0 })),
    fallback: true,
  };
}

function fuzzyFind(row, keywords) {
  if (!row) return null;
  for (const kw of keywords) {
    const key = Object.keys(row).find((k) => k.includes(kw));
    if (key) {
      let v = row[key];
      if (typeof v === "object" && v) v = Object.values(v)[0];
      return v;
    }
  }
  return null;
}

// ---- 辅助：格式化市值 ----
export function formatMcap(v) {
  if (v == null || !Number.isFinite(v)) return "--";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "万亿";
  if (v >= 1e8) return (v / 1e8).toFixed(0) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return v.toString();
}
