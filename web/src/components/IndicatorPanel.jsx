/**
 * IndicatorPanel —— 4 个技术指标卡 (MA / MACD / KDJ / RSI)
 */

import { useMemo } from "react";
import { maTrend, macd, kdj, rsi, fmt, NEUTRAL } from "../utils/indicators.js";

export default function IndicatorPanel({ bars }) {
  const closes = useMemo(() => bars.map((b) => b.close), [bars]);
  const highs = useMemo(() => bars.map((b) => b.high ?? b.close), [bars]);
  const lows = useMemo(() => bars.map((b) => b.low ?? b.close), [bars]);

  const maData = useMemo(() => maTrend(closes), [closes]);
  const macdData = useMemo(() => macd(closes), [closes]);
  const kdjData = useMemo(() => kdj(highs, lows, closes), [highs, lows, closes]);
  const rsiData = useMemo(() => rsi(closes), [closes]);

  return (
    <div className="indicator-panel">
      <IndicatorCard
        title="MA"
        subtitle="趋势"
        items={[
          { label: "MA5",  value: fmt(maData.m5[maData.m5.length - 1]) },
          { label: "MA10", value: fmt(maData.m10[maData.m10.length - 1]) },
          { label: "MA20", value: fmt(maData.m20[maData.m20.length - 1]) },
          { label: "信号", value: maData.trend, color: maData.color },
        ]}
      />
      <IndicatorCard
        title="MACD"
        subtitle="动量"
        items={[
          { label: "DIF",  value: fmt(macdData.latest.dif, 3) },
          { label: "DEA",  value: fmt(macdData.latest.dea, 3) },
          { label: "BAR",  value: fmt(macdData.latest.hist, 3),
            color: (macdData.latest.hist ?? 0) >= 0 ? "var(--up-color)" : "var(--down-color)" },
          { label: "信号", value: macdData.latest.cross, color: macdData.latest.color },
        ]}
      />
      <IndicatorCard
        title="KDJ"
        subtitle="超买超卖"
        items={[
          { label: "K", value: fmt(kdjData.latest.k, 1) },
          { label: "D", value: fmt(kdjData.latest.d, 1) },
          { label: "J", value: fmt(kdjData.latest.j, 1),
            color: (kdjData.latest.j ?? 50) > 100 ? "var(--down-color)" :
                   (kdjData.latest.j ?? 50) < 0 ? "var(--up-color)" : NEUTRAL },
          { label: "状态", value: kdjData.latest.status, color: kdjData.latest.color },
        ]}
      />
      <IndicatorCard
        title="RSI"
        subtitle="14 日"
        items={[
          { label: "RSI", value: fmt(rsiData.latest.value, 1),
            color: rsiData.latest.color },
          { label: "状态", value: rsiData.latest.status, color: rsiData.latest.color },
        ]}
      />
    </div>
  );
}

function IndicatorCard({ title, subtitle, items }) {
  return (
    <div className="indicator-card">
      <div className="indicator-card-title">
        <span>{title}</span>
        <span className="indicator-card-sub">{subtitle}</span>
      </div>
      {items.map((it, i) => (
        <div key={i} className="indicator-row">
          <span className="indicator-label">{it.label}</span>
          <span className="indicator-value" style={{ color: it.color || NEUTRAL }}>
            {it.value}
          </span>
        </div>
      ))}
    </div>
  );
}
