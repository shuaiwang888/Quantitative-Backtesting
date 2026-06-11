/**
 * useCachedResult —— localStorage 缓存最近一次结果
 *
 * 用途：每个 tab 提交后，缓存响应当前数据。切走 tab 再切回 / 刷新页面 / 重启浏览器，
 *      自动恢复上次结果（"查看最近一次"），不重新打 iwencai。
 *
 * 用法：
 *   const { data, save, clear, ts } = useCachedResult("backtest");
 *   save(responseData);
 *   data // 恢复时是上次缓存的对象
 *
 * 每个模块独立 key（namespace），互不污染。
 */

import { useState, useEffect, useCallback } from "react";

function storageKey(namespace) {
  return `quant_cached_${namespace}`;
}

function readCache(namespace) {
  try {
    const raw = localStorage.getItem(storageKey(namespace));
    if (!raw) return { data: null, ts: 0 };
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && "data" in obj) return obj;
    // 兼容旧版（直接存 data）：作为 data 看待
    return { data: obj, ts: 0 };
  } catch {
    return { data: null, ts: 0 };
  }
}

export default function useCachedResult(namespace) {
  const [{ data, ts }, setState] = useState(() => readCache(namespace));

  // 跨 tab 同步
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === storageKey(namespace)) setState(readCache(namespace));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [namespace]);

  const save = useCallback((newData) => {
    const next = { data: newData, ts: Date.now() };
    try {
      localStorage.setItem(storageKey(namespace), JSON.stringify(next));
    } catch {
      // quota exceeded — 忽略（best effort）
    }
    setState(next);
  }, [namespace]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(storageKey(namespace));
    } catch {}
    setState({ data: null, ts: 0 });
  }, [namespace]);

  return { data, ts, save, clear, hasCache: data != null };
}

// ---- 格式化 ----
export function formatCacheTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
