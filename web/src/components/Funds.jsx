/**
 * Funds —— 热门板块资金流向（前 20）
 *
 * 数据：iwencai 自然语言 `热门板块前20 资金流向`
 *   返回 20 条板块（指数），每条字段：
 *     - 指数简称（如 "AI智能体"）
 *     - 指数代码（如 "886099.TI"）
 *     - 板块热度[YYYYMMDD]
 *     - 资金净流入额[YYYYMMDD]（净额，正/负）
 *   注：这个 query 模板不返回涨跌幅和领涨股，所以展示元素要相应精简。
 * 展示：5×4 = 20 个方块，每块：
 *   - 板块名（指数简称，大字）
 *   - 资金净流入额（红绿着色，单位亿）
 *   - 板块热度（小字，灰色）
 *   - 指数代码（小字，右下角）
 *   - 点击方块 → 弹板块指数 K 线详情（SymbolChartModal）
 *
 * 缓存：5 分钟 TTL（资金数据频繁变化，比 Dashboard 短）
 */

import { useState, useEffect, useCallback } from "react";
import { postJson, fuzzyFind } from "../api.js";
import useCachedResult, { formatCacheTime } from "../hooks/useCachedResult.js";
import SymbolChartModal from "./SymbolChartModal.jsx";

const CACHE_NS = "funds_hot_sectors";
// 与 Dashboard 一致：不设 TTL（一直缓存），只有用户点"刷新"才重拉

/** 把数字格式化成 "X.XX 亿" / "X.XX 万"。例：7751563000 → "77.52 亿" */
function formatYi(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "--";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return v.toFixed(0);
}

/** 把大数字格式化成 "187K" / "1.2M"。例：187540 → "187.5K" */
function formatK(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "--";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)} K`;
  return v.toFixed(0);
}

export default function Funds({ onError, onStatus }) {
  const cache = useCachedResult(CACHE_NS);  // 无 TTL，与 Dashboard 风格一致
  const [data, setData] = useState(() => {
    const c = cache.data;
    return Array.isArray(c?.datas) ? c.datas : [];
  });
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState("");
  const [chartTarget, setChartTarget] = useState(null);

  /**
   * 构造板块 K 线弹窗的 target。
   * 注意：必须用板块指数代码（如 "886078.TI"）而不是简称，
   *   否则 iwencai 会返回成分股列表而不是板块指数 K 线。
   */
  const openSectorChart = (row) => {
    const name = fuzzyFind(row, ["指数简称", "板块名称"]) ?? "--";
    const code = fuzzyFind(row, ["指数代码", "板块代码"]) ?? "";
    if (!code || code === "--") {
      onError?.(new Error("板块指数代码缺失，无法拉 K 线"));
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - 1);
    const fmt = (d) => d.toISOString().slice(0, 10);
    setChartTarget({
      name,
      symbol: code,
      type: "index",
      query: `${code} ${fmt(start)}到${fmt(end)} 每日行情 交易日期 开盘价 最高价 最低价 收盘价 成交量`,
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setLastError("");
    try {
      const res = await postJson("/api/query", {
        // 固定问句：热门板块前20 + 资金流向
        query: "热门板块前20 资金流向",
        limit: 20,
      });
      if (res && Array.isArray(res.datas)) {
        setData(res.datas);
        cache.save(res);
        onStatus?.(`资金已更新：${res.datas.length} 板块`);
      } else {
        const msg = res?.error || "返回数据格式异常";
        setLastError(msg);
        onError?.(new Error(msg));
      }
    } catch (e) {
      setLastError(e?.message || "请求失败");
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [onError, onStatus, cache]);

  // 首次挂载：缓存为空 → 拉一次
  useEffect(() => {
    if (!cache.hasCache && data.length === 0 && !loading) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="funds">
      <div className="section-title">
        <h3>热门板块资金流向（前 20）</h3>
        <span className="title-right">
          {cache.ts > 0 && (
            <span
              className="update-time"
              title={new Date(cache.ts).toLocaleString()}
            >
              📦 已缓存 {formatCacheTime(cache.ts)}
            </span>
          )}
          <button
            className="btn btn-primary"
            type="button"
            onClick={refresh}
            disabled={loading}
            style={{ padding: "6px 16px", fontSize: 12 }}
          >
            {loading ? <><span className="loader" /> 拉取中...</> : "刷新"}
          </button>
        </span>
      </div>

      {lastError && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          ⚠ {lastError}
          <button type="button" onClick={refresh} style={{ marginLeft: 12 }}>
            重试
          </button>
        </div>
      )}

      {data.length === 0 && !loading && !lastError && (
        <p className="placeholder">暂无板块数据，点"刷新"加载</p>
      )}

      <div className="sector-grid">
        {data.map((row, i) => {
          // iwencai 返回字段（带日期后缀）：
          //   指数简称 / 指数代码 / 板块热度[YYYYMMDD] / 资金净流入额[YYYYMMDD]
          const name = fuzzyFind(row, ["指数简称", "板块名称"]) ?? "--";
          const code = fuzzyFind(row, ["指数代码", "板块代码"]) ?? "";
          const flowNum = parseFloat(
            fuzzyFind(row, ["资金净流入额", "资金净流入"])
          );
          const heatNum = parseFloat(fuzzyFind(row, ["板块热度", "热度"]));
          // 颜色按资金净流入正/负（红涨绿跌）
          const flowColor = Number.isFinite(flowNum)
            ? flowNum > 0
              ? "var(--up-color)"
              : flowNum < 0
              ? "var(--down-color)"
              : "var(--text-secondary)"
            : "var(--text-secondary)";
          return (
            <div
              className="sector-tile sector-tile--clickable"
              key={i}
              style={{ borderLeftColor: flowColor }}
              title={`${name} (${code || "--"}) · 点击看 K 线`}
              onClick={() => openSectorChart(row)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openSectorChart(row);
                }
              }}
            >
              <div className="sector-name">{name}</div>
              <div className="sector-flow" style={{ color: flowColor }}>
                {Number.isFinite(flowNum)
                  ? `${flowNum > 0 ? "+" : ""}${formatYi(flowNum)}`
                  : "--"}
              </div>
              <div className="sector-heat">
                热度 {Number.isFinite(heatNum) ? formatK(heatNum) : "--"}
              </div>
              <div className="sector-code">{code || "--"}</div>
            </div>
          );
        })}
      </div>

      {chartTarget && (
        <SymbolChartModal
          target={chartTarget}
          onClose={() => setChartTarget(null)}
        />
      )}
    </section>
  );
}