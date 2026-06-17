/**
 * SymbolChartModal —— Dashboard 点击标的弹窗
 *
 * target: { name, symbol, type: 'index' | 'stock', query }
 *
 * 流程：
 *   1. 弹窗挂载 → 调 POST /api/bars 拉近一年日 K
 *   2. 数据 → SimpleCandleChart（蜡烛 + MA + Volume + hover tooltip）
 *   3. 数据 → IndicatorPanel（MA / MACD / KDJ / RSI 4 张卡）
 *
 * 体验补全：
 *   - ESC 关闭
 *   - 遮罩点击关闭
 *   - 关闭按钮
 *   - body 滚动锁定
 *   - prefers-reduced-motion 时跳过 scaleIn
 *   - React Portal 渲染到 body，避免父级 transform/overflow 干扰
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { postJson } from "../api.js";
import { formatCacheTime } from "../hooks/useCachedResult.js";
import SimpleCandleChart from "./SimpleCandleChart.jsx";
import IndicatorPanel from "./IndicatorPanel.jsx";

export default function SymbolChartModal({ target, onClose }) {
  const [bars, setBars] = useState(null);
  const [meta, setMeta] = useState({ symbol: "", name: "" });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ts, setTs] = useState(0);

  useEffect(() => {
    if (!target) return;

    // body 滚动锁定
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // ESC 关闭
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);

    // 拉数据
    setLoading(true);
    setError(null);
    setBars(null);
    postJson("/api/bars", { query: target.query, max_pages: 3, limit: 100 })
      .then((d) => {
        if (d && d.success && Array.isArray(d.bars) && d.bars.length) {
          setBars(d.bars);
          setMeta({ symbol: d.symbol || target.symbol || "", name: d.name || target.name || "" });
          setTs(Date.now());
        } else {
          setError(d?.error || "未返回 K 线数据");
        }
      })
      .catch((e) => setError(e?.message || "请求失败"))
      .finally(() => setLoading(false));

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [target, onClose]);

  if (!target) return null;

  const typeLabel = target.type === "index" ? "指数" : "股票";

  return createPortal(
    <div className="modal symbol-modal" role="dialog" aria-modal="true">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel modal-large">
        <div className="modal-header">
          <h3>
            {target.name}
            {meta.symbol && <span className="symbol-code">· {meta.symbol}</span>}
            <span className="badge">{typeLabel}</span>
          </h3>
          <span className="ts-tag" title={ts ? new Date(ts).toLocaleString() : ""}>
            {ts > 0 ? `📦 ${formatCacheTime(ts)}` : ""}
          </span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body symbol-modal-body">
          {error ? (
            <div className="error-box">
              ⚠ {error}
              <button type="button" onClick={onClose}>关闭</button>
            </div>
          ) : !bars ? (
            <div className="skeleton-chart" aria-busy="true">
              <div className="skeleton-row" />
              <div className="skeleton-row short" />
              <div className="skeleton-row" />
            </div>
          ) : (
            <>
              <SimpleCandleChart bars={bars} />
              <IndicatorPanel bars={bars} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
