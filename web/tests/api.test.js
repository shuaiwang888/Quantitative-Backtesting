import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), clear: () => values.clear() };
};
globalThis.location = { hostname: "localhost", protocol: "http:", search: "" };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
const { postJson, checkConnection, setApiBase, getApiBase, setSessionCredentials } = await import("../src/api.js");
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); location.protocol = "http:"; });

test("健康检测不发送访客或站点密钥", async () => {
  setSessionCredentials({ iwencaiApiKey: "visitor", accessKey: "site" });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://backend.example/api/health");
    assert.equal(options.headers, undefined);
    assert.equal(options.body, undefined);
    return Response.json({ success: true, status: "ok" });
  };
  await checkConnection(" https://backend.example/ ");
});
test("连接测试拒绝把静态页面当成后端", async () => {
  globalThis.fetch = async () => Response.json({ success: true });
  await assert.rejects(checkConnection(), /有效的平台健康状态/);
});
test("HTTPS 页面提示混合内容地址错误", async () => {
  location.protocol = "https:";
  await assert.rejects(checkConnection("http://backend.example"), /HTTPS 后端/);
});
test("网络错误提供可操作提示", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(postJson("/api/query", {}), /无法连接后端/);
});
test("错误 JSON 值不能成为成功结果", async () => {
  for (const payload of [null, [], "bad"]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(postJson("/api/query", {}), /无效数据/);
  }
});
test("保留上游业务错误，避免误显示成功", async () => {
  globalThis.fetch = async () => Response.json({ success: false, error: "额度不足" });
  await assert.rejects(postJson("/api/query", {}), /额度不足/);
});
test("超时中止请求并说明原因", async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(postJson("/api/query", {}, { timeoutMs: 5 }), /请求超时/);
  await assert.rejects(checkConnection("", { timeoutMs: 5 }), /连接超时/);
});
test("用户取消保持 AbortError", async () => {
  globalThis.fetch = async (_url, { signal }) => {
    signal.throwIfAborted();
    return Response.json({ success: true });
  };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(postJson("/api/query", {}, { signal: controller.signal }), { name: "AbortError" });
});
test("后端地址不允许把密钥放入 URL", () => {
  assert.throws(() => setApiBase("https://user:secret@example.com"));
  assert.throws(() => setApiBase("https://example.com?key=secret"));
  setApiBase(" https://example.com/ ");
  assert.equal(getApiBase(), "https://example.com");
});
test("站点密钥和问财密钥分开传递", async () => {
  setSessionCredentials({ iwencaiApiKey: "visitor", accessKey: "site" });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers["X-API-Key"], "site");
    assert.equal(JSON.parse(options.body).iwencai_api_key, "visitor");
    return Response.json({ success: true, datas: [] });
  };
  await postJson("/api/query", { query: "test" });
});

test("旧默认后端缓存自动迁移，实际请求发向当前运行的服务", async () => {
  localStorage.setItem("quant_api_base", "https://quant-backtest.onrender.com/");
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://quant-backtest-wj92.onrender.com/api/query");
    return Response.json({ success: true, datas: [] });
  };
  await postJson("/api/query", { query: "test" });
  assert.equal(localStorage.getItem("quant_api_base"), "https://quant-backtest-wj92.onrender.com");
});

test("旧书签地址也会迁移", async () => {
  const previousSearch = location.search;
  location.search = "?api=https%3A%2F%2Fquant-backtest.onrender.com";
  try {
    const api = await import("../src/api.js?legacy-bookmark");
    assert.equal(api.getApiBase(), "https://quant-backtest-wj92.onrender.com");
  } finally { location.search = previousSearch; }
});

test("连接检测和保存配置使用迁移后的地址", async () => {
  setApiBase("https://quant-backtest.onrender.com");
  assert.equal(getApiBase(), "https://quant-backtest-wj92.onrender.com");
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://quant-backtest-wj92.onrender.com/api/health");
    return Response.json({ success: true, status: "ok" });
  };
  await checkConnection("https://quant-backtest.onrender.com");
});

test("其他自定义服务不被迁移", () => {
  setApiBase("https://my-backtest.onrender.com");
  assert.equal(getApiBase(), "https://my-backtest.onrender.com");
});
