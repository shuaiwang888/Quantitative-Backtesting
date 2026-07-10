/**
 * API 客户端 + 通用格式化函数
 *
 * API_BASE 解析顺序（与原 config.js 一致）：
 *   1. URL 参数 ?api=https://xxx.onrender.com  （首次配置，写入 localStorage）
 *   2. localStorage.quant_api_base  （记住上次的值）
 *   3. ""（同源；本地 Vite dev 会通过 vite.config.js 代理 /api 到 8000）
 *
 * 后端协议自动适配：
 *   - 我们的 FastAPI / stdlib http.server：POST {base}/api/{endpoint} body {key: val}
 *   - HF Space Gradio SDK：先触发 call 拿 event_id，再用 SSE 拉结果
 *
 * 注：API key 全部在 Render 后端 Environment 配置，前端不再处理。
 */

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

async function triggerGradioCall(endpoint, payload) {
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

async function postJsonGradio(endpoint, payload) {
  const base = getApiBase();
  const event_id = await triggerGradioCall(endpoint, { ...(payload || {}) });

  // step 2: 拉 SSE 流
  const resultUrl = `${base}/gradio_api/call/${endpoint}/${event_id}`;
  const res = await fetch(resultUrl, { headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastPartial;
  while (true) {
    const { done, value } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
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

export async function postJson(path, payload) {
  if (isGradioBase()) {
    // /api/strategies → strategies
    const endpoint = path.replace(/^\/api\//, "");
    return postJsonGradio(endpoint, payload);
  }
  const url = getApiBase() + path;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(payload || {}) }),
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
