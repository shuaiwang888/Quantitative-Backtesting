// 配置 API base URL + 访客自带 API 密钥管理 —— 部署到 GitHub Pages 时用。
//
// 配置 API base URL（部署拆分）：
//   1. URL 参数 ?api=https://xxx.onrender.com  （首次配置，自动写到 localStorage）
//   2. localStorage.quant_api_base  （记住上一次）
//   3. ""（同源；本地开发用 http://127.0.0.1:8000）
//
// 访客 API 密钥：
//   localStorage.quant_keys = { iwencai: "...", minimax: "..." }
//   - 永远只在访客自己的浏览器里
//   - 由 POST 时注入到 payload.api_key / payload.minimax_api_key
//   - 后端 Settings / 环境变量优先；若 owner 配了，访客没配也能用
(function () {
  "use strict";

  // ---- 工具 ----

  function normalize(url) {
    if (!url) return "";
    return url.replace(/\/+$/, "");
  }

  function isValidHttpUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_e) {
      return false;
    }
  }

  function safeStorageGet(key) {
    try { return localStorage.getItem(key) || ""; } catch (_e) { return ""; }
  }
  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_e) { return false; }
  }
  function safeStorageDel(key) {
    try { localStorage.removeItem(key); return true; } catch (_e) { return false; }
  }

  // ---- API base URL ----

  const params = new URLSearchParams(location.search);
  const fromQuery = normalize(params.get("api"));
  if (fromQuery) {
    if (!isValidHttpUrl(fromQuery)) {
      console.warn("[quant] ?api= 不是合法 http(s) URL，已忽略:", fromQuery);
    } else {
      safeStorageSet("quant_api_base", fromQuery);
      console.log("[quant] API base 已写入 localStorage:", fromQuery);
    }
  }

  window.API_BASE = normalize(safeStorageGet("quant_api_base"));
  if (window.API_BASE) {
    console.info("[quant] API base:", window.API_BASE, "（同源回退已禁用）");
  } else {
    console.info("[quant] API base: 同源（本地开发）");
  }

  // ---- 访客 API 密钥管理 ----
  // 只在访客的浏览器里；同步给 postJson 注入到 payload。
  // 永远不会上传到任何地方（除了被访客自己的请求体送到目标后端）。

  const KEYS_STORAGE = "quant_keys";

  /** @returns {{ iwencai: string, minimax: string }} 缺失字段返回空串 */
  function loadKeys() {
    const raw = safeStorageGet(KEYS_STORAGE);
    if (!raw) return { iwencai: "", minimax: "" };
    try {
      const obj = JSON.parse(raw);
      return {
        iwencai: typeof obj.iwencai === "string" ? obj.iwencai : "",
        minimax: typeof obj.minimax === "string" ? obj.minimax : "",
      };
    } catch (_e) {
      return { iwencai: "", minimax: "" };
    }
  }

  function saveKeys(partial) {
    const cur = loadKeys();
    const next = {
      iwencai: typeof partial.iwencai === "string" ? partial.iwencai : cur.iwencai,
      minimax: typeof partial.minimax === "string" ? partial.minimax : cur.minimax,
    };
    if (next.iwencai || next.minimax) {
      safeStorageSet(KEYS_STORAGE, JSON.stringify(next));
    } else {
      safeStorageDel(KEYS_STORAGE);
    }
    return next;
  }

  function clearKeys() {
    safeStorageDel(KEYS_STORAGE);
    return { iwencai: "", minimax: "" };
  }

  /** 掩码显示用：保留前 4 后 4，中间用 * */
  function maskKey(k) {
    if (!k) return "";
    if (k.length <= 10) return "•".repeat(k.length);
    return k.slice(0, 4) + "•".repeat(Math.max(0, k.length - 8)) + k.slice(-4);
  }

  // 把访客 key 注入到任意请求 payload；
  // 调用方在 payload 里显式传 false / null 可以保留原值。
  function injectKeys(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const k = loadKeys();
    // iwencai key：后端已有的字段是 api_key（同时支持前端 Options 页用户填）
    if (k.iwencai && !("api_key" in payload)) {
      payload.api_key = k.iwencai;
    }
    // minimax key：后端新增字段 minimax_api_key（保持向后兼容）
    if (k.minimax && !("minimax_api_key" in payload)) {
      payload.minimax_api_key = k.minimax;
    }
    return payload;
  }

  // 暴露给 app.js
  window.quantKeys = {
    load: loadKeys,
    save: saveKeys,
    clear: clearKeys,
    mask: maskKey,
    inject: injectKeys,
    isConfigured: () => {
      const k = loadKeys();
      return Boolean(k.iwencai || k.minimax);
    },
  };

  console.info(
    "[quant] 访客 keys:",
    (() => {
      const k = loadKeys();
      const parts = [];
      if (k.iwencai) parts.push("iwencai=" + maskKey(k.iwencai));
      if (k.minimax) parts.push("minimax=" + maskKey(k.minimax));
      return parts.length ? parts.join(", ") : "(未配置)";
    })()
  );
})();