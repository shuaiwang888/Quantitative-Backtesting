/**
 * API 客户端 + 通用格式化函数
 *
 * API_BASE 解析顺序（与原 config.js 一致）：
 *   1. URL 参数 ?api=https://xxx.onrender.com  （首次配置，写入 localStorage）
 *   2. localStorage.quant_api_base  （记住上次的值）
 *   3. 本地开发使用同源 API；非本地静态站点使用构建时后端地址
 *
 * 后端协议自动适配：
 *   - 我们的 FastAPI / stdlib http.server：POST {base}/api/{endpoint} body {key: val}
 *   - HF Space Gradio SDK：先触发 call 拿 event_id，再用 SSE 拉结果
 *
 * 注：访客密钥只保存在 sessionStorage，关闭标签页即清除。
 */

const API_BASE_STORAGE = "quant_api_base";
const CREDENTIALS_STORAGE = "quant_session_credentials";
// 默认后端 URL（Render 实际部署的 service）
// 优先用 localStorage 缓存；缓存空时 fallback 到这里。
// 缓存 + URL 不匹配时会清空缓存（见 initApiBase）
const DEPLOYED_API_BASE =
  import.meta.env.VITE_API_BASE || "https://quant-backtest-wj92.onrender.com";
const IS_LOCAL = ["localhost", "127.0.0.1", "::1"].includes(location.hostname)
  || location.protocol === "file:";
const DEFAULT_API_BASE = IS_LOCAL ? "" : DEPLOYED_API_BASE;

const REQUEST_TIMEOUTS = {
  "/api/query": 120_000,
  "/api/bars": 120_000,
  "/api/backtest": 300_000,
  "/api/batch_backtest": 900_000,
  "/api/optimize": 300_000,
  "/api/analyze": 240_000,
};
const IWENCAI_PATHS = new Set([
  "/api/query",
  "/api/bars",
  "/api/backtest",
  "/api/batch_backtest",
  "/api/optimize",
]);

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
    if (fromQuery === "local" || fromQuery === "same-origin") {
      try { localStorage.removeItem(API_BASE_STORAGE); } catch {}
    } else if (!isValidHttpUrl(fromQuery)) {
      console.warn("[quant] ?api= 不是合法 http(s) URL，已忽略:", fromQuery);
    } else {
      try { localStorage.setItem(API_BASE_STORAGE, fromQuery); } catch {}
      console.log("[quant] API base 已写入 localStorage:", fromQuery);
    }
  }
})();

export function getApiBase() {
  try {
    const stored = localStorage.getItem(API_BASE_STORAGE);
    if (stored) return normalizeUrl(stored);
  } catch {}
  // 缓存为空时用默认 URL（避免历史缓存导致访问孤儿 service）
  return normalizeUrl(DEFAULT_API_BASE);
}

export function setApiBase(value) {
  const normalized = normalizeUrl(value);
  if (normalized && !isValidHttpUrl(normalized)) {
    throw new Error("后端地址必须是合法的 http(s) URL");
  }
  try {
    if (normalized) localStorage.setItem(API_BASE_STORAGE, normalized);
    else localStorage.removeItem(API_BASE_STORAGE);
  } catch {
    throw new Error("浏览器拒绝保存后端地址");
  }
}

export function getSessionCredentials() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CREDENTIALS_STORAGE) || "{}");
    return {
      iwencaiApiKey: typeof parsed.iwencaiApiKey === "string" ? parsed.iwencaiApiKey : "",
      minimaxApiKey: typeof parsed.minimaxApiKey === "string" ? parsed.minimaxApiKey : "",
      accessKey: typeof parsed.accessKey === "string" ? parsed.accessKey : "",
    };
  } catch {
    return { iwencaiApiKey: "", minimaxApiKey: "", accessKey: "" };
  }
}

export function setSessionCredentials(credentials) {
  const next = {
    iwencaiApiKey: String(credentials?.iwencaiApiKey || "").trim(),
    minimaxApiKey: String(credentials?.minimaxApiKey || "").trim(),
    accessKey: String(credentials?.accessKey || "").trim(),
  };
  try {
    if (Object.values(next).some(Boolean)) {
      sessionStorage.setItem(CREDENTIALS_STORAGE, JSON.stringify(next));
    } else {
      sessionStorage.removeItem(CREDENTIALS_STORAGE);
    }
  } catch {
    throw new Error("浏览器拒绝保存会话密钥");
  }
  return next;
}

// 后端是 Gradio SDK 吗？Gradio 用 SSE 协议 + 不同路径
function isGradioBase() {
  const base = getApiBase();
  return /\.hf\.space$/.test(base);
}

// ---- Gradio API 调用（SSE 流式） ----
// 兼容两类 Gradio 协议：
//   - 新版：POST /gradio_api/call/v2/<endpoint> body {"payload": <dict>}
//   - 旧版：POST /gradio_api/call/<endpoint>    body {"data": [<dict>]}
//   - 拉流：GET  /gradio_api/call/<endpoint>/<event_id> (text/event-stream)

function pickGradioOutput(output) {
  if (output && Array.isArray(output.data)) return output.data[0] ?? null;
  if (Array.isArray(output)) return output[0] ?? null;
  return output ?? null;
}

function parseSseEvent(raw) {
  const lines = raw.split("\n");
  let eventName = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value || "message";
    if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return { eventName, data: undefined };
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { eventName, data: dataText };
  try {
    return { eventName, data: JSON.parse(dataText) };
  } catch {
    return { eventName, data: dataText };
  }
}

function interpretGradioEvent(eventName, data) {
  if (data === undefined || data === "[DONE]") return { kind: "ignore" };
  if (eventName === "error") {
    return { kind: "error", message: typeof data === "string" ? data : data?.error };
  }
  if (data && typeof data === "object" && !Array.isArray(data) && data.msg) {
    if (data.msg === "process_completed") {
      return { kind: "done", result: pickGradioOutput(data.output) };
    }
    if (data.msg === "process_failed") {
      return {
        kind: "error",
        message: data.message || data.output?.error || data.error || "处理失败",
      };
    }
    if (data.output && (data.msg === "process_generating" || data.msg === "process_starts")) {
      return { kind: "partial", result: pickGradioOutput(data.output) };
    }
    return { kind: "ignore" };
  }
  if (eventName === "complete") {
    return { kind: "done", result: pickGradioOutput(data) };
  }
  if (eventName === "generating" || eventName === "data") {
    return { kind: "partial", result: pickGradioOutput(data) };
  }
  return { kind: "ignore" };
}

async function triggerGradioCall(endpoint, payload, signal) {
  const base = getApiBase();
  const attempts = [
    {
      url: `${base}/gradio_api/call/v2/${endpoint}`,
      body: { payload },
    },
    {
      url: `${base}/gradio_api/call/${endpoint}`,
      body: { data: [payload] },
    },
  ];
  let lastMessage = "";
  for (const attempt of attempts) {
    const res = await fetch(attempt.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt.body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      lastMessage = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) lastMessage = data.error;
      } catch {}
      if (![404, 405, 422].includes(res.status)) break;
      continue;
    }
    const data = await res.json();
    const eventId = data?.event_id || data?.eventId || data;
    if (typeof eventId === "string" && eventId) return eventId;
    throw new Error("Gradio 未返回 event_id");
  }
  throw new Error(lastMessage || "Gradio 调用触发失败");
}

async function postJsonGradio(endpoint, payload, options = {}) {
  const { signal } = options;
  const base = getApiBase();
  const event_id = await triggerGradioCall(endpoint, { ...(payload || {}) }, signal);

  // step 2: 拉 SSE 流
  const resultUrl = `${base}/gradio_api/call/${endpoint}/${event_id}`;
  const res = await fetch(resultUrl, {
    headers: { Accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastPartial;
  let aborted = false;
  // 把 abort 透传到 reader：触发 reader.cancel() 让 fetch 立刻释放连接
  if (signal) {
    if (signal.aborted) {
      try { await reader.cancel(); } catch {}
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
        try { reader.cancel(); } catch {}
      },
      { once: true },
    );
  }
  try {
    while (true) {
      if (aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
      } else {
        buf += decoder.decode(value, { stream: true });
      }
      buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const events = buf.split(/\n\n+/);
      buf = events.pop() || "";
      for (const evt of events) {
        const parsed = parseSseEvent(evt);
        const interpreted = interpretGradioEvent(parsed.eventName, parsed.data);
        if (interpreted.kind === "done") return interpreted.result;
        if (interpreted.kind === "error") throw new Error(interpreted.message || "处理失败");
        if (interpreted.kind === "partial" && interpreted.result !== null) {
          lastPartial = interpreted.result;
        }
      }
      if (done) break;
    }
  } catch (exc) {
    if (aborted || (signal && signal.aborted)) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw exc;
  }

  if (buf.trim()) {
    const parsed = parseSseEvent(buf.trim());
    const interpreted = interpretGradioEvent(parsed.eventName, parsed.data);
    if (interpreted.kind === "done") return interpreted.result;
    if (interpreted.kind === "error") throw new Error(interpreted.message || "处理失败");
    if (interpreted.kind === "partial" && interpreted.result !== null) {
      lastPartial = interpreted.result;
    }
  }
  if (lastPartial !== undefined) return lastPartial;
  throw new Error("SSE 流提前结束：未收到 Gradio 完成事件");
}

// ---- 通用 postJson（自动适配后端协议） ----
// options.signal：可选的 AbortSignal，用于在组件 unmount 时取消未完成的请求。
//   - 本地后端：透传给 fetch
//   - Gradio 后端：同时用于 trigger 阶段 + SSE reader.cancel()

export async function postJson(path, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUTS[path] ?? 120_000;
  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let data;
    const credentials = getSessionCredentials();
    const requestPayload = { ...(payload || {}) };
    if (credentials.iwencaiApiKey && IWENCAI_PATHS.has(path)) {
      requestPayload.iwencai_api_key = credentials.iwencaiApiKey;
    }
    if (credentials.minimaxApiKey && path === "/api/analyze") {
      requestPayload.minimax_api_key = credentials.minimaxApiKey;
    }
    if (isGradioBase()) {
      // /api/strategies → strategies
      const endpoint = path.replace(/^\/api\//, "");
      if (credentials.accessKey) requestPayload.access_key = credentials.accessKey;
      data = await postJsonGradio(endpoint, requestPayload, { signal: controller.signal });
    } else {
      const url = getApiBase() + path;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credentials.accessKey ? { "X-API-Key": credentials.accessKey } : {}),
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      try {
        data = await res.json();
      } catch {
        throw new Error(res.ok ? "服务端返回了无效 JSON" : `HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
    }
    if (data && data.success === false) {
      throw new Error(data.error || "请求处理失败");
    }
    return data;
  } catch (error) {
    if (timedOut) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
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
