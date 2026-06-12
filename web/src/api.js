/**
 * API 客户端 + 通用格式化函数
 *
 * API_BASE 解析顺序（与原 config.js 一致）：
 *   1. URL 参数 ?api=https://xxx.onrender.com  （首次配置，写入 localStorage）
 *   2. localStorage.quant_api_base  （记住上次的值）
 *   3. ""（同源；本地 Vite dev 会通过 vite.config.js 代理 /api 到 8000）
 *
 * 访客密钥（quant_keys）：
 *   - 只存在访客浏览器 localStorage
 *   - postJson 每次自动注入到 payload.api_key / payload.minimax_api_key
 *   - 永远不上传到任何地方（除发往后端）
 */

const KEYS_STORAGE = "quant_keys";
const API_BASE_STORAGE = "quant_api_base";

// ---- API BASE 解析 ----

function normalizeUrl(url) {
  if (!url) return "";
  return url.replace(/\/+$/, "");
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

(function initApiBase() {
  const params = new URLSearchParams(location.search);
  const fromQuery = normalizeUrl(params.get("api"));
  if (fromQuery) {
    if (!isValidHttpUrl(fromQuery)) {
      console.warn("[quant] ?api= 不是合法 http(s) URL，已忽略:", fromQuery);
    } else {
      try { localStorage.setItem(API_BASE_STORAGE, fromQuery); } catch {}
      console.log("[quant] API base 已写入 localStorage:", fromQuery);
    }
  }
})();

export function getApiBase() {
  try {
    return normalizeUrl(localStorage.getItem(API_BASE_STORAGE) || "");
  } catch {
    return "";
  }
}

// ---- 访客密钥管理 ----

export function loadKeys() {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    if (!raw) return { iwencai: "", minimax: "" };
    const obj = JSON.parse(raw);
    return {
      iwencai: typeof obj.iwencai === "string" ? obj.iwencai : "",
      minimax: typeof obj.minimax === "string" ? obj.minimax : "",
    };
  } catch {
    return { iwencai: "", minimax: "" };
  }
}

export function saveKeys(partial) {
  const cur = loadKeys();
  const next = {
    iwencai: typeof partial.iwencai === "string" ? partial.iwencai : cur.iwencai,
    minimax: typeof partial.minimax === "string" ? partial.minimax : cur.minimax,
  };
  try {
    if (next.iwencai || next.minimax) {
      localStorage.setItem(KEYS_STORAGE, JSON.stringify(next));
    } else {
      localStorage.removeItem(KEYS_STORAGE);
    }
  } catch {}
  return next;
}

export function clearKeys() {
  try { localStorage.removeItem(KEYS_STORAGE); } catch {}
  return { iwencai: "", minimax: "" };
}

export function isKeysConfigured() {
  const k = loadKeys();
  return Boolean(k.iwencai || k.minimax);
}

export function maskKey(k) {
  if (!k) return "";
  if (k.length <= 10) return "•".repeat(k.length);
  return k.slice(0, 4) + "•".repeat(Math.max(0, k.length - 8)) + k.slice(-4);
}

// 把访客 key 注入到 payload
function injectKeys(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const k = loadKeys();
  if (k.iwencai && !("api_key" in payload)) {
    payload.api_key = k.iwencai;
  }
  if (k.minimax && !("minimax_api_key" in payload)) {
    payload.minimax_api_key = k.minimax;
  }
  return payload;
}

// ---- 通用 postJson ----

export async function postJson(path, payload) {
  const url = getApiBase() + path;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(injectKeys({ ...(payload || {}) })),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---- 格式化函数 ----

export function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function percent(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function numberOrDash(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

export function formatPercentText(value) {
  if (value === null || value === undefined || value === "--" || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(2)}%`;
}

export function formatYi(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${(n / 1e8).toFixed(2)}亿`;
}

// iwencai 返回的字段名带日期后缀 (例: "收盘价:不复权[20240506]")，
// 模糊匹配出第一个含 keyword 的 key
export function fuzzyFind(row, keywords) {
  if (!Array.isArray(keywords)) keywords = [keywords];
  for (const kw of keywords) {
    const matchedKey = Object.keys(row || {}).find((k) => k.includes(kw));
    if (matchedKey && row[matchedKey] !== null && row[matchedKey] !== undefined) {
      let v = row[matchedKey];
      if (typeof v === "object") v = Object.values(v)[0];
      return v;
    }
  }
  return "--";
}

// ---- 并发限流 Semaphore（用于热力图并发拉 10 个行业成分股） ----

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export async function runWithConcurrency(items, max, fn) {
  const sem = new Semaphore(max);
  return Promise.all(items.map((it) => sem.run(() => fn(it))));
}
