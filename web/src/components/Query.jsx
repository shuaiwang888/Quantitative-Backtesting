/**
 * Query —— 自然语言问财（/api/query）
 *
 * 响应格式：{ datas: [{ ...列名带日期后缀... }], code_count, ... }
 *
 * 列名展示：取所有 datas 的 keys 并集，过滤出"列前缀"（去掉 `[YYYYMMDD]` 后缀）
 * 数据值：从行里 fuzzy 匹配列前缀
 */

import { useState, useEffect, useMemo } from "react";
import { postJson, fuzzyFind } from "../api.js";
import useCachedResult, { formatCacheTime } from "../hooks/useCachedResult.js";

const SAMPLE_QUERIES = [
  "沪深300 成分股 股票代码 股票简称",
  "上证指数 深证成指 创业板指 最新行情",
  "成交额前20 股票代码 股票简称 涨跌幅 换手率",
  "我的自选股 最新价 涨跌幅",
];

export default function Query({ hasIwencaiKey, onError, onStatus }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const cache = useCachedResult("query");
  const [data, setData] = useState(cache.data);
  const [lastParams, setLastParams] = useState(() => cache.data ? { query: cache.data.__query || "", page: 1, limit: cache.data.__limit || 20 } : null);

  // 从响应推导出"列前缀"（去掉日期后缀）
  const columns = useMemo(() => {
    if (!data || !data.datas) return [];
    const allKeys = new Set();
    for (const row of data.datas) {
      for (const k of Object.keys(row || {})) allKeys.add(k);
    }
    const prefixes = new Set();
    for (const k of allKeys) {
      prefixes.add(k.replace(/\[\d{6,8}\]?\s*$/, "").replace(/[:：].*$/, ""));
    }
    return Array.from(prefixes);
  }, [data]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!query.trim()) return;
    setLoading(true);
    setData(null);
    try {
      const res = await postJson("/api/query", {
        query: query.trim(),
        page,
        limit,
      });
      if (res && Array.isArray(res.datas)) {
        // 缓存时记录一下请求参数（恢复用）
        const toCache = { ...res, __query: query.trim(), __limit: limit };
        setData(res);
        cache.save(toCache);
        setLastParams({ query: query.trim(), page, limit });
        onStatus?.(`查询完成：${res.datas.length} 行 · 共 ${res.code_count ?? "?"} 条`);
      } else {
        throw new Error(res?.error || "查询失败");
      }
    } catch (e) {
      onError?.(e);
    } finally {
      setLoading(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil((data.code_count || 0) / limit)) : 1;

  return (
    <section className="form-view">
      <form onSubmit={submit}>
        <div className="form-field">
          <label>查询语句（自然语言）</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例：沪深300 成分股 股票代码 股票简称 涨跌幅"
            required
          />
          <span className="hint">
            <button
              type="button"
              className="inline-action"
              style={{ marginRight: 4, fontSize: 11 }}
              onClick={() => setQuery(SAMPLE_QUERIES[0])}
            >沪深300</button>
            <button
              type="button"
              className="inline-action"
              style={{ marginRight: 4, fontSize: 11 }}
              onClick={() => setQuery(SAMPLE_QUERIES[1])}
            >三大指数</button>
            <button
              type="button"
              className="inline-action"
              style={{ marginRight: 4, fontSize: 11 }}
              onClick={() => setQuery(SAMPLE_QUERIES[2])}
            >成交额前20</button>
            <button
              type="button"
              className="inline-action"
              style={{ fontSize: 11 }}
              onClick={() => setQuery(SAMPLE_QUERIES[3])}
            >我的自选股</button>
          </span>
        </div>

        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="form-field">
            <label>页码</label>
            <input className="mono" type="number" min="1" value={page} onChange={(e) => setPage(Number(e.target.value) || 1)} />
          </div>
          <div className="form-field">
            <label>每页条数</label>
            <input className="mono" type="number" min="1" max="100" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 20)} />
            <span className="hint">上限 100；分页由前端 + 后端共同保证</span>
          </div>
        </div>

        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={loading || !hasIwencaiKey || !query.trim()}>
            {loading ? <><span className="loader" /> 查询中...</> : "查询"}
          </button>
          {!hasIwencaiKey && <span className="hint" style={{ color: "var(--up-color)" }}>需先在右上角配置 iwencai key</span>}
        </div>
      </form>

      {data && (
        <div style={{ marginTop: 4 }}>
          <div className="optimize-header">
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--ink)" }}>
              结果
              <span className="hint" style={{ marginLeft: 12, fontSize: 11 }}>
                当前页 {data.datas.length} 行 · 全量 {data.code_count ?? "?"} 条
              </span>
              {cache.ts > 0 && (
                <span className="hint" style={{ marginLeft: 12, fontSize: 11 }} title={new Date(cache.ts).toLocaleString()}>
                  📦 已缓存 {formatCacheTime(cache.ts)}
                </span>
              )}
            </h3>
          </div>

          {data.datas.length === 0 ? (
            <div className="chart-empty">无数据</div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 560 }}>
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => <th key={c} style={{ textAlign: c === "代码" || c === "股票代码" || c === "股票简称" ? "left" : "right" }}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.datas.map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) => {
                        const v = fuzzyFind(row, [c]);
                        return <td key={c} className="mono">{typeof v === "object" ? JSON.stringify(v) : (v == null ? "--" : String(v))}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pagination">
            <button type="button" onClick={() => { setPage(1); setTimeout(submit, 0); }} disabled={page === 1}>« 首页</button>
            <button type="button" onClick={() => { setPage(Math.max(1, page - 1)); setTimeout(submit, 0); }} disabled={page <= 1}>‹ 上一页</button>
            <span className="page-info">第 {page} / {totalPages} 页</span>
            <button type="button" onClick={() => { setPage(page + 1); setTimeout(submit, 0); }} disabled={page >= totalPages}>下一页 ›</button>
            <button type="button" onClick={() => { setPage(totalPages); setTimeout(submit, 0); }} disabled={page >= totalPages}>末页 »</button>
          </div>
        </div>
      )}
    </section>
  );
}
