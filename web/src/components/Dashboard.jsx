/**
 * Dashboard —— 首页
 *
 * 内容：
 *   - 大盘指数卡片（上证 / 深证 / 创业板）
 *   - A 股行业热力图（treemap，按总市值 / 颜色 = 涨跌幅）
 *   - 自选股行情表格
 *   - 整合"刷新"按钮：手动刷新大盘 + 热力图 + 自选股（带缓存）
 *
 * 缓存策略：
 *   - 首次挂载：从 localStorage 缓存恢复（不重新请求）
 *   - 用户点"刷新"按钮 → 拉新数据 → 写缓存
 *   - 切走 tab 再切回 → 直接显示缓存（不发请求）
 *   - 切到首页显示"📦 已缓存 ..."时间标签
 */

import { useState, useEffect, useCallback } from "react";
import { postJson, money, numberOrDash, formatPercentText, fuzzyFind } from "../api.js";
import Heatmap, { fetchIndustryHeatmap, formatMcap } from "./Heatmap.jsx";
import useCachedResult, { formatCacheTime } from "../hooks/useCachedResult.js";

const LOCAL_WATCHLIST_STORAGE = "quant_watchlist";

function getLocalWatchlist() {
  try {
    const raw = localStorage.getItem(LOCAL_WATCHLIST_STORAGE);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setLocalWatchlist(list) {
  try {
    localStorage.setItem(LOCAL_WATCHLIST_STORAGE, JSON.stringify(list));
  } catch {}
}

/**
 * 拉自选股：先试 iwencai "我的自选股"（有 key 时），失败回退 localStorage
 */
async function fetchWatchlist(hasIwencaiKey) {
  if (hasIwencaiKey) {
    try {
      const res = await postJson("/api/query", {
        query: "我的自选股 最新价、涨跌幅、开盘价、收盘价、量比、换手率",
        limit: 50,
      });
      if (res && Array.isArray(res.datas) && res.datas.length > 0) {
        return { source: "iwencai", items: res.datas };
      }
    } catch (e) {
      console.warn("[quant] iwencai 我的自选股拉取失败，回退本地:", e);
    }
  }
  const local = getLocalWatchlist();
  if (local.length > 0) {
    try {
      const query = `${local.join(" ")} 最新价、涨跌幅、开盘价、收盘价、量比、换手率`;
      const res = await postJson("/api/query", { query, limit: Math.max(1, local.length) });
      if (res && Array.isArray(res.datas) && res.datas.length > 0) {
        return { source: "local", items: res.datas };
      }
    } catch (e) {
      console.warn("[quant] 本地自选股拉取失败:", e);
    }
    return { source: "local", items: local.map((n) => ({ "股票简称": n })) };
  }
  return { source: "empty", items: [] };
}

export default function Dashboard({ hasIwencaiKey, onError, onStatus }) {
  // 三个独立缓存（大盘 / 热力图 / 自选股），都从 localStorage 恢复
  const marketCache = useCachedResult("dashboard_market");
  const heatmapCache = useCachedResult("dashboard_heatmap");
  const watchlistCache = useCachedResult("dashboard_watchlist");

  const [marketData, setMarketData] = useState(marketCache.data?.datas || []);
  const [heatmapItems, setHeatmapItems] = useState(heatmapCache.data?.items || []);
  const [watchResult, setWatchResult] = useState(
    watchlistCache.data || { source: "empty", items: [] }
  );
  const [heatmapFallback, setHeatmapFallback] = useState(heatmapCache.data?.fallback || false);
  const [loading, setLoading] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");

  // 跨 tab 同步：cache 变了同步到 state
  useEffect(() => {
    if (marketCache.data?.datas && !marketData.length) setMarketData(marketCache.data.datas);
  }, [marketCache.data]);
  useEffect(() => {
    if (heatmapCache.data?.items && !heatmapItems.length) {
      setHeatmapItems(heatmapCache.data.items);
      setHeatmapFallback(!!heatmapCache.data.fallback);
    }
  }, [heatmapCache.data]);
  useEffect(() => {
    if (watchlistCache.data && !watchResult.items.length) setWatchResult(watchlistCache.data);
  }, [watchlistCache.data]);

  // ---- 整合刷新 ----
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [market, heatmap, watch] = await Promise.all([
        postJson("/api/query", {
          query: "上证指数 深证成指 创业板指 最新行情",
          limit: 3,
        }),
        fetchIndustryHeatmap(hasIwencaiKey),
        fetchWatchlist(hasIwencaiKey),
      ]);
      if (market && Array.isArray(market.datas)) {
        setMarketData(market.datas);
        marketCache.save(market);
      }
      if (heatmap && Array.isArray(heatmap.items)) {
        // 给每个 item 加 mcapLabel
        const items = heatmap.items.map((it) => ({ ...it, mcapLabel: formatMcap(it.weight) }));
        setHeatmapItems(items);
        setHeatmapFallback(!!heatmap.fallback);
        heatmapCache.save({ items, fallback: !!heatmap.fallback, queriedAt: heatmap.queriedAt });
      }
      setWatchResult(watch);
      watchlistCache.save(watch);
      onStatus?.(
        `首页已更新：${market?.datas?.length || 0} 指数 · ` +
        `${heatmap?.items?.length || 0} 行业${heatmap?.fallback ? "（无数据）" : ""} · ` +
        `${watch?.items?.length || 0} 自选股`
      );
    } catch (e) {
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [hasIwencaiKey, onError, onStatus, marketCache, heatmapCache, watchlistCache]);

  // 首次挂载：只有当所有缓存都为空时才自动拉一次
  useEffect(() => {
    const hasAnyCache = marketCache.data || heatmapCache.data || watchlistCache.data;
    if (!hasAnyCache && hasIwencaiKey) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听自选股事件：从 Selector tab 跳转过来
  useEffect(() => {
    const handler = (e) => {
      // 自选股同步（加/删）后可能需要刷新
      refresh();
    };
    window.addEventListener("quant:watchlist-changed", handler);
    return () => window.removeEventListener("quant:watchlist-changed", handler);
  }, [refresh]);

  const addSymbol = () => {
    const s = newSymbol.trim();
    if (!s) return;
    const w = getLocalWatchlist();
    if (!w.includes(s)) {
      w.push(s);
      setLocalWatchlist(w);
    }
    setNewSymbol("");
    refresh();
  };

  const removeSymbol = (name) => {
    const w = getLocalWatchlist().filter((x) => x !== name);
    setLocalWatchlist(w);
    refresh();
  };

  const goBatchBacktest = () => {
    const names = watchResult.items
      .map((r) => r["股票简称"] || r["code"] || r["股票代码"])
      .filter((n) => n && n !== "--");
    if (names.length === 0) {
      alert("自选股为空，请先添加或配置 iwencai key");
      return;
    }
    window.dispatchEvent(new CustomEvent("quant:batch-watchlist", { detail: { names } }));
  };

  const isIwencaiSource = watchResult.source === "iwencai";
  const watchCount = watchResult.items.length;
  const sourceLabel =
    watchResult.source === "iwencai"
      ? "（iwencai 我的自选股 · 只读）"
      : watchResult.source === "local"
        ? "（本地）"
        : "";

  // 整合后的最新缓存时间（取三者最新）
  const latestTs = Math.max(marketCache.ts, heatmapCache.ts, watchlistCache.ts);

  return (
    <section className="dashboard">
      <div className="section-title">
        <h3>大盘指数</h3>
        <span className="title-right">
          {latestTs > 0 && (
            <span className="update-time" title={new Date(latestTs).toLocaleString()}>
              📦 已缓存 {formatCacheTime(latestTs)}
            </span>
          )}
          <button
            className="btn btn-primary"
            type="button"
            onClick={refresh}
            disabled={loading}
            style={{ padding: "6px 16px", fontSize: 12 }}
          >
            {loading ? <><span className="loader" /> 刷新中...</> : "刷新"}
          </button>
        </span>
      </div>
      <div className="market-grid">
        {marketData.length === 0 ? (
          <p className="placeholder" style={{ gridColumn: "1/-1" }}>暂无大盘数据，点"刷新"加载</p>
        ) : (
          marketData.map((row, i) => <MarketCard key={i} row={row} />)
        )}
      </div>

      <Heatmap
        data={heatmapItems}
        loading={loading}
        hasKey={hasIwencaiKey}
        onError={onError}
        onRefresh={refresh}
        cacheTs={heatmapCache.ts}
        formatCacheTime={formatCacheTime}
      />
      {heatmapFallback && heatmapItems.length > 0 && (
        <div className="hint" style={{ fontSize: 11, marginTop: -8, marginBottom: 8, color: "var(--text-tertiary)" }}>
          ⚠ iwencai 暂不支持行业聚合查询，已展示申万 31 个一级行业（无涨跌幅数据）；配置 key 后点"刷新"尝试拉真实数据
        </div>
      )}

      <div className="section-title">
        <h3>自选股行情</h3>
        <span className="title-right">
          <button
            className="inline-action"
            type="button"
            onClick={goBatchBacktest}
            disabled={watchCount === 0}
          >
            直接进行批量回测
          </button>
          <span className="count-label" title={sourceLabel}>
            {watchCount} 只 {sourceLabel}
          </span>
        </span>
      </div>

      <div className="add-watchlist">
        <input
          type="text"
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSymbol()}
          placeholder={isIwencaiSource
            ? "iwencai 我的自选股是只读的，请到 iwencai.com 添加"
            : "添加自选股代码或名称（例：宁德时代或300750）"}
          disabled={isIwencaiSource}
        />
        <button
          type="button"
          className="secondary"
          onClick={addSymbol}
          disabled={isIwencaiSource || !newSymbol.trim()}
        >
          添加
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>最新价</th>
              <th>涨跌幅</th>
              <th>开盘价</th>
              <th>收盘价</th>
              <th>量比</th>
              <th>换手率</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {watchResult.items.length === 0 ? (
              <tr>
                <td colSpan={9} className="placeholder-row">
                  {watchResult.source === "iwencai"
                    ? "iwencai 上还没有自选股，请到 iwencai.com 添加后刷新"
                    : "暂无自选股，请在左侧添加，或配置 iwencai key 后自动同步「我的自选股」"}
                </td>
              </tr>
            ) : (
              watchResult.items.map((row, i) => (
                <WatchlistRow
                  key={i}
                  row={row}
                  readonly={isIwencaiSource}
                  onRemove={removeSymbol}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- 子组件：大盘指数卡片 ----

function MarketCard({ row }) {
  const name = row["股票简称"] || row["指数简称"] || "--";
  let price = fuzzyFind(row, ["最新价", "收盘价"]);
  let pct = fuzzyFind(row, ["涨跌幅", "涨幅"]);
  if (typeof price === "object") price = Object.values(price)[0] || "--";
  if (typeof pct === "object") pct = Object.values(pct)[0] || "--";

  let color = "var(--text-primary)";
  if (parseFloat(pct) > 0) color = "var(--up-color)";
  else if (parseFloat(pct) < 0) color = "var(--down-color)";

  return (
    <div className="market-card">
      <div className="market-card-name">{name}</div>
      <div className="market-card-price" style={{ color }}>{money(price)}</div>
      <div className="market-card-pct" style={{ color }}>{formatPercentText(pct)}</div>
    </div>
  );
}

// ---- 子组件：自选股一行 ----

function WatchlistRow({ row, readonly, onRemove }) {
  const code = row["code"] || row["股票代码"] || "--";
  const name = row["股票简称"] || "--";
  let price = fuzzyFind(row, ["最新价", "收盘价"]);
  let pct = fuzzyFind(row, ["涨跌幅"]);
  let open = fuzzyFind(row, ["开盘价"]);
  let close = fuzzyFind(row, ["收盘价"]);
  let volumeRatio = fuzzyFind(row, ["量比"]);
  let turnover = fuzzyFind(row, ["换手率"]);

  let color = "inherit";
  if (parseFloat(pct) > 0) color = "var(--up-color)";
  else if (parseFloat(pct) < 0) color = "var(--down-color)";

  return (
    <tr>
      <td className="mono">{code}</td>
      <td>{name}</td>
      <td style={{ color, fontWeight: 500 }}>{money(price)}</td>
      <td style={{ color }}>{formatPercentText(pct)}</td>
      <td>{money(open)}</td>
      <td>{money(close)}</td>
      <td>{numberOrDash(volumeRatio, 2)}</td>
      <td>{formatPercentText(turnover)}</td>
      <td>
        {readonly ? (
          <span className="readonly-tag">--</span>
        ) : (
          <button
            type="button"
            className="inline-action"
            onClick={() => onRemove(name)}
          >
            删除
          </button>
        )}
      </td>
    </tr>
  );
}
