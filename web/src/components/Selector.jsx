/**
 * Selector —— 条件选股 + 股票池
 *
 * 复用 /api/query：用户输入条件问财 → 列表 → 选择性加入股票池
 * 股票池存 localStorage（quant_stockpool），可一键去"回测"批量跑
 */

import { useState, useEffect, useMemo } from "react";
import { postJson, fuzzyFind } from "../api.js";
import useCachedResult, { formatCacheTime } from "../hooks/useCachedResult.js";

const POOL_STORAGE = "quant_stockpool";

function getPool() {
  try {
    const raw = localStorage.getItem(POOL_STORAGE);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function setPool(arr) {
  try { localStorage.setItem(POOL_STORAGE, JSON.stringify(arr)); } catch {}
}

const PRESETS = [
  { label: "沪深300成分股", query: "沪深300 成分股 股票代码 股票简称 涨跌幅 市盈率" },
  { label: "中证500成分股", query: "中证500 成分股 股票代码 股票简称 涨跌幅 市盈率" },
  { label: "成交额前50",    query: "成交额前50 股票代码 股票简称 涨跌幅 换手率" },
  { label: "市值前100",      query: "总市值前100 股票代码 股票简称 涨跌幅 总市值" },
  { label: "PE<20",         query: "市盈率小于20 股票代码 股票简称 市盈率 总市值" },
];

export default function Selector({ onError, onStatus }) {
  const [query, setQuery] = useState(PRESETS[0].query);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const cache = useCachedResult("selector");
  const [data, setData] = useState(cache.data);
  const [pool, setPoolState] = useState(getPool());
  const [selected, setSelected] = useState(new Set());

  // 跨 tab 同步
  useEffect(() => {
    const onStorage = (e) => { if (e.key === POOL_STORAGE) setPoolState(getPool()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // 拉结果
  const search = async (e) => {
    e?.preventDefault?.();
    if (!query.trim()) return;
    setLoading(true);
    setData(null);
    setSelected(new Set());
    try {
      const res = await postJson("/api/query", { query: query.trim(), page, limit });
      if (res && Array.isArray(res.datas)) {
        setData(res);
        cache.save(res);
        onStatus?.(`选股返回：${res.datas.length} 行 · 全量 ${res.code_count ?? "?"} 条`);
      } else {
        throw new Error(res?.error || "查询失败");
      }
    } catch (e) {
      onError?.(e);
    } finally {
      setLoading(false);
    }
  };

  // 提列名
  const columns = useMemo(() => {
    if (!data || !data.datas) return [];
    const allKeys = new Set();
    for (const row of data.datas) for (const k of Object.keys(row || {})) allKeys.add(k);
    const prefixes = new Set();
    for (const k of allKeys) prefixes.add(k.replace(/\[\d{6,8}\]?\s*$/, "").replace(/[:：].*$/, ""));
    return Array.from(prefixes);
  }, [data]);

  // 行 → { code, name }
  const row2stock = (row) => {
    const code = fuzzyFind(row, ["股票代码", "code"]) || "--";
    const name = fuzzyFind(row, ["股票简称", "名称"]) || code;
    return { code: String(code), name: String(name) };
  };

  const addSelectedToPool = () => {
    if (!data || selected.size === 0) return;
    const addList = Array.from(selected)
      .map((i) => row2stock(data.datas[i]))
      .filter((s) => s.code && s.code !== "--");
    const cur = getPool();
    const map = new Map(cur.map((s) => [s.code, s]));
    for (const s of addList) map.set(s.code, s);
    const next = Array.from(map.values());
    setPool(next);
    setPoolState(next);
    setSelected(new Set());
    onStatus?.(`已加入 ${addList.length} 只到股票池（合计 ${next.length}）`);
  };

  const addAllToPool = () => {
    if (!data || data.datas.length === 0) return;
    const addList = data.datas.map(row2stock).filter((s) => s.code && s.code !== "--");
    const cur = getPool();
    const map = new Map(cur.map((s) => [s.code, s]));
    for (const s of addList) map.set(s.code, s);
    const next = Array.from(map.values());
    setPool(next);
    setPoolState(next);
    onStatus?.(`已加入 ${addList.length} 只到股票池（合计 ${next.length}）`);
  };

  const removeFromPool = (code) => {
    const next = pool.filter((s) => s.code !== code);
    setPool(next);
    setPoolState(next);
  };

  const clearPool = () => {
    if (!confirm("清空股票池？")) return;
    setPool([]);
    setPoolState([]);
  };

  const goBatchBacktest = () => {
    const names = pool.map((s) => s.name);
    if (!names.length) return;
    window.dispatchEvent(new CustomEvent("quant:batch-watchlist", { detail: { names } }));
  };

  const totalPages = data ? Math.max(1, Math.ceil((data.code_count || 0) / limit)) : 1;

  return (
    <section className="form-view">
      <form onSubmit={search}>
        <div className="form-field">
          <label>选股条件</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="自然语言描述选股条件"
            required
          />
          <span className="hint">
            预设：
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="inline-action"
                style={{ marginRight: 4, fontSize: 11 }}
                onClick={() => { setQuery(p.query); setPage(1); }}
              >
                {p.label}
              </button>
            ))}
          </span>
        </div>

        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="form-field">
            <label>页码</label>
            <input className="mono" type="number" min="1" value={page} onChange={(e) => setPage(Number(e.target.value) || 1)} />
          </div>
          <div className="form-field">
            <label>每页条数</label>
            <input className="mono" type="number" min="1" max="100" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 30)} />
          </div>
        </div>

        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>
            {loading ? <><span className="loader" /> 查询中...</> : "开始选股"}
          </button>
        </div>
      </form>

      {/* ===== 股票池 ===== */}
      <div>
        <div className="optimize-header">
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
            股票池
            <span className="hint" style={{ marginLeft: 10, fontSize: 11 }}>{pool.length} 只</span>
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={goBatchBacktest} disabled={pool.length === 0}>去批量回测</button>
            <button type="button" className="btn btn-danger" onClick={clearPool} disabled={pool.length === 0}>清空</button>
          </div>
        </div>
        {pool.length === 0 ? (
          <div className="chart-empty" style={{ padding: 20 }}>股票池为空；从下方结果中勾选股票加入</div>
        ) : (
          <div className="pill-list">
            {pool.map((s) => (
              <span key={s.code} className="symbol-pill" title={s.code}>
                <span className="mono" style={{ color: "var(--text-secondary)" }}>{s.code}</span>
                <span>{s.name}</span>
                <button type="button" onClick={() => removeFromPool(s.code)} title="删除">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ===== 选股结果 ===== */}
      {data && (
        <div>
          <div className="optimize-header">
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
              命中股票
              <span className="hint" style={{ marginLeft: 12, fontSize: 11 }}>
                当前页 {data.datas.length} · 全量 {data.code_count ?? "?"}
              </span>
              {cache.ts > 0 && (
                <span className="hint" style={{ marginLeft: 12, fontSize: 11 }} title={new Date(cache.ts).toLocaleString()}>
                  📦 已缓存 {formatCacheTime(cache.ts)}
                </span>
              )}
            </h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={addSelectedToPool} disabled={selected.size === 0}>
                加入已选 ({selected.size})
              </button>
              <button type="button" className="btn" onClick={addAllToPool}>加入全部</button>
            </div>
          </div>

          {data.datas.length === 0 ? (
            <div className="chart-empty">无命中</div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 480 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "center", width: 36 }}>
                      <input
                        type="checkbox"
                        checked={data.datas.length > 0 && selected.size === data.datas.length}
                        onChange={(e) => {
                          if (e.target.checked) setSelected(new Set(data.datas.map((_, i) => i)));
                          else setSelected(new Set());
                        }}
                      />
                    </th>
                    {columns.map((c) => <th key={c} style={{ textAlign: c === "代码" || c === "股票代码" || c === "股票简称" ? "left" : "right" }}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.datas.map((row, i) => {
                    const stock = row2stock(row);
                    const inPool = pool.some((s) => s.code === stock.code);
                    return (
                      <tr key={i} className={inPool ? "best-combo" : ""}>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selected.has(i)}
                            onChange={(e) => {
                              const n = new Set(selected);
                              if (e.target.checked) n.add(i); else n.delete(i);
                              setSelected(n);
                            }}
                          />
                        </td>
                        {columns.map((c) => {
                          const v = fuzzyFind(row, [c]);
                          return <td key={c} className="mono">{typeof v === "object" ? JSON.stringify(v) : (v == null ? "--" : String(v))}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="pagination">
            <button type="button" onClick={() => { setPage(1); setTimeout(search, 0); }} disabled={page === 1}>« 首页</button>
            <button type="button" onClick={() => { setPage(Math.max(1, page - 1)); setTimeout(search, 0); }} disabled={page <= 1}>‹ 上一页</button>
            <span className="page-info">第 {page} / {totalPages} 页</span>
            <button type="button" onClick={() => { setPage(page + 1); setTimeout(search, 0); }} disabled={page >= totalPages}>下一页 ›</button>
            <button type="button" onClick={() => { setPage(totalPages); setTimeout(search, 0); }} disabled={page >= totalPages}>末页 »</button>
          </div>
        </div>
      )}
    </section>
  );
}
