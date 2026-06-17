/**
 * SimpleCandleChart —— 简化版 K 线（无买卖点、无交易 tooltip）
 *
 * 用于 Dashboard 弹窗快速看图。视觉与 Backtest 的 CandleChart 保持一致。
 * viewBox: 0 0 720 380（蜡烛区 700x280 + Volume 100）
 */

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { ma } from "../utils/indicators.js";

const W = 720;
const H = 380;
const PAD_L = 8;       // 左侧留 Y 轴价格
const PAD_R = 56;      // 右侧留 Y 轴涨跌幅
const PAD_T = 12;
const CANDLE_H = 260;
const VOL_H = 80;
const CANDLE_BOTTOM = PAD_T + CANDLE_H;
const VOL_TOP = CANDLE_BOTTOM + 8;

const COLORS = {
  up: "var(--up-color)",
  down: "var(--down-color)",
  grid: "var(--line)",
  text: "var(--text-tertiary)",
  ma5: "#fbbf24",
  ma10: "#4ea8ff",
  ma20: "#c084fc",
  crosshair: "var(--accent)",
};

export default function SimpleCandleChart({ bars }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(W);
  const [hoverIdx, setHoverIdx] = useState(-1);

  // 容器宽度自适应
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 200) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // MA5/10/20
  const ma5 = useMemo(() => ma(bars.map((b) => b.close), 5), [bars]);
  const ma10 = useMemo(() => ma(bars.map((b) => b.close), 10), [bars]);
  const ma20 = useMemo(() => ma(bars.map((b) => b.close), 20), [bars]);

  // 价格范围
  const { priceMin, priceMax, volMax } = useMemo(() => {
    let pMin = Infinity, pMax = -Infinity, vMax = 0;
    for (const b of bars) {
      const lo = b.low ?? b.close;
      const hi = b.high ?? b.close;
      if (lo < pMin) pMin = lo;
      if (hi > pMax) pMax = hi;
      if (b.volume != null && b.volume > vMax) vMax = b.volume;
    }
    // 把 MA 折线也算进范围
    [ma5, ma10, ma20].forEach((arr) => {
      for (const v of arr) {
        if (v == null) continue;
        if (v < pMin) pMin = v;
        if (v > pMax) pMax = v;
      }
    });
    if (!Number.isFinite(pMin) || !Number.isFinite(pMax)) {
      pMin = 0; pMax = 1;
    }
    const range = pMax - pMin || 1;
    return {
      priceMin: pMin - range * 0.02,
      priceMax: pMax + range * 0.02,
      volMax: vMax || 1,
    };
  }, [bars, ma5, ma10, ma20]);

  const basePrice = bars[0]?.close ?? priceMin;

  const n = bars.length;
  if (n === 0) {
    return <div className="candle-empty">暂无 K 线数据</div>;
  }

  const plotW = width - PAD_L - PAD_R;
  const slot = plotW / n;
  const candleW = Math.max(1, Math.min(slot * 0.7, 12));
  const yScale = (price) => {
    const t = (price - priceMin) / (priceMax - priceMin);
    return PAD_T + (1 - t) * CANDLE_H;
  };
  const vScale = (vol) => {
    return VOL_TOP + (1 - vol / volMax) * VOL_H;
  };

  // MA 折线 path
  const maPath = (arr) => {
    let d = "";
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      const x = PAD_L + i * slot + slot / 2;
      const y = yScale(arr[i]);
      d += (d === "" ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    }
    return d.trim();
  };

  // hover 坐标
  const onMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.floor((x - PAD_L) / slot);
    if (idx >= 0 && idx < n) setHoverIdx(idx);
    else setHoverIdx(-1);
  }, [n, slot]);

  const onLeave = useCallback(() => setHoverIdx(-1), []);

  const hover = hoverIdx >= 0 ? bars[hoverIdx] : null;
  const hx = hover ? PAD_L + hoverIdx * slot + slot / 2 : 0;

  return (
    <div className="candle-chart" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        {/* 网格横线（4 等分） */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = PAD_T + t * CANDLE_H;
          const price = priceMax - t * (priceMax - priceMin);
          const pct = ((price - basePrice) / basePrice) * 100;
          return (
            <g key={t}>
              <line
                x1={PAD_L} y1={y} x2={width - PAD_R} y2={y}
                stroke={COLORS.grid} strokeWidth={0.5} strokeDasharray="2 3" opacity={0.5}
              />
              <text
                x={width - PAD_R + 4} y={y + 3}
                fontSize={9} fill={COLORS.text} fontFamily="var(--font-mono)"
              >
                {price.toFixed(2)}
              </text>
              <text
                x={width - PAD_R + 32} y={y + 3}
                fontSize={9}
                fill={pct >= 0 ? COLORS.up : COLORS.down}
                fontFamily="var(--font-mono)"
              >
                {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
              </text>
            </g>
          );
        })}

        {/* 蜡烛 */}
        {bars.map((b, i) => {
          const x = PAD_L + i * slot + slot / 2;
          const o = b.open, h = b.high, l = b.low, c = b.close;
          // 兼容 iwencai 偶尔首根 bar OHLC 缺失 → 灰色占位
          if (o == null || h == null || l == null || c == null) {
            return (
              <g key={i}>
                <line
                  x1={x} y1={PAD_T + CANDLE_H / 2} x2={x} y2={PAD_T + CANDLE_H / 2 + 4}
                  stroke={COLORS.text} strokeWidth={1}
                />
              </g>
            );
          }
          const up = c >= o;
          const fill = up ? COLORS.up : COLORS.down;
          const stroke = fill;
          const yo = yScale(o);
          const yc = yScale(c);
          const yh = yScale(h);
          const yl = yScale(l);
          const top = Math.min(yo, yc);
          const bodyH = Math.max(1, Math.abs(yc - yo));
          return (
            <g key={i}>
              {/* 影线 */}
              <line
                x1={x} y1={yh} x2={x} y2={yl}
                stroke={stroke} strokeWidth={1}
              />
              {/* 实体（A 股：涨实心 / 跌空心） */}
              {up ? (
                <rect
                  x={x - candleW / 2} y={top}
                  width={candleW} height={bodyH}
                  fill={fill}
                />
              ) : (
                <rect
                  x={x - candleW / 2} y={top}
                  width={candleW} height={bodyH}
                  fill="none" stroke={stroke} strokeWidth={1}
                />
              )}
              {/* Volume */}
              {b.volume != null && (
                <rect
                  x={x - candleW / 2} y={vScale(b.volume)}
                  width={candleW} height={VOL_TOP + VOL_H - vScale(b.volume)}
                  fill={fill} opacity={0.55}
                />
              )}
            </g>
          );
        })}

        {/* MA 折线 */}
        <path d={maPath(ma5)} fill="none" stroke={COLORS.ma5} strokeWidth={1.2} />
        <path d={maPath(ma10)} fill="none" stroke={COLORS.ma10} strokeWidth={1.2} />
        <path d={maPath(ma20)} fill="none" stroke={COLORS.ma20} strokeWidth={1.2} />

        {/* MA 图例 */}
        <g transform={`translate(${PAD_L + 4}, ${PAD_T + 10})`}>
          <rect width={130} height={14} fill="var(--bg-elev)" opacity={0.8} rx={2} />
          <text x={6} y={10} fontSize={9} fill={COLORS.ma5} fontFamily="var(--font-mono)">MA5</text>
          <text x={40} y={10} fontSize={9} fill={COLORS.ma10} fontFamily="var(--font-mono)">MA10</text>
          <text x={82} y={10} fontSize={9} fill={COLORS.ma20} fontFamily="var(--font-mono)">MA20</text>
        </g>

        {/* 十字光标 */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hx} y1={PAD_T} x2={hx} y2={VOL_TOP + VOL_H}
              stroke={COLORS.crosshair} strokeWidth={0.5} strokeDasharray="2 2"
            />
            <line
              x1={PAD_L} y1={yScale(hover.close)} x2={width - PAD_R} y2={yScale(hover.close)}
              stroke={COLORS.crosshair} strokeWidth={0.5} strokeDasharray="2 2"
            />
            <rect
              x={width - PAD_R + 2} y={yScale(hover.close) - 7} width={PAD_R - 4} height={14}
              fill="var(--bg-elev)" opacity={0.95} rx={2}
            />
            <text
              x={width - PAD_R + 6} y={yScale(hover.close) + 3}
              fontSize={10} fill="var(--text-primary)" fontFamily="var(--font-mono)"
            >
              {Number(hover.close).toFixed(2)}
            </text>
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="candle-tooltip"
          style={{
            left: Math.min(Math.max(8, hx + 8), width - 220),
            top: 8,
          }}
        >
          <div style={{ color: "var(--accent)", marginBottom: 2 }}>{hover.date}</div>
          <div>开 <b style={{ color: "var(--text-primary)" }}>{Number(hover.open).toFixed(2)}</b></div>
          <div>高 <b style={{ color: COLORS.up }}>{Number(hover.high).toFixed(2)}</b></div>
          <div>低 <b style={{ color: COLORS.down }}>{Number(hover.low).toFixed(2)}</b></div>
          <div>收 <b style={{ color: "var(--text-primary)" }}>{Number(hover.close).toFixed(2)}</b></div>
          {hover.volume != null && (
            <div>量 <b style={{ color: "var(--text-primary)" }}>{Number(hover.volume).toLocaleString("zh-CN")}</b></div>
          )}
          <div style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4, fontSize: 10 }}>
            <span style={{ color: COLORS.ma5 }}>MA5={fmt(ma5[hoverIdx])}</span>{"  "}
            <span style={{ color: COLORS.ma10 }}>MA10={fmt(ma10[hoverIdx])}</span>{"  "}
            <span style={{ color: COLORS.ma20 }}>MA20={fmt(ma20[hoverIdx])}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "--";
  return Number(v).toFixed(2);
}
