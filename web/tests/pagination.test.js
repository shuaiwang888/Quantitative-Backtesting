import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const require = createRequire(import.meta.url);
function loadComponent(name) {
  const { outputFiles } = buildSync({
    entryPoints: [`web/src/components/${name}.jsx`], bundle: true,
    write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    define: { "import.meta.env": "{}" },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
  return module.exports.default;
}
const storage = () => {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
};
beforeEach(() => {
  globalThis.location = { hostname: "localhost", protocol: "http:", search: "" };
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
});
const text = (node) => typeof node === "string" ? node : (node.children || []).map(text).join("");
for (const name of ["Query", "Selector"]) {
  test(`${name} 翻页实际请求新页码，失败时保留上一页结果`, async () => {
    const Component = loadComponent(name);
    const seen = [];
    let fail = false;
    const errors = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body); seen.push(request.page);
      if (fail) throw new TypeError("offline");
      return Response.json({ success: true, code_count: 100, datas: [{ 股票代码: `page-${request.page}`, 股票简称: "测试" }] });
    };
    let renderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(Component, { onError: (e) => errors.push(e) })); });
    const form = () => renderer.root.findByType("form");
    if (name === "Query") {
      act(() => renderer.root.findAllByType("input").find((node) => node.props.type === "text").props.onChange({ target: { value: "mock query" } }));
    }
    await act(async () => { await form().props.onSubmit({ preventDefault() {} }); });
    const button = (label) => renderer.root.findAllByType("button").find((node) => text(node).includes(label));
    await act(async () => { await button("下一页").props.onClick(); });
    assert.deepEqual(seen, [1, 2]);
    assert.match(JSON.stringify(renderer.toJSON()), /page-2/);
    await act(async () => { await button("末页").props.onClick(); });
    assert.equal(seen.at(-1), name === "Query" ? 5 : 4);
    await act(async () => { await button("首页").props.onClick(); });
    assert.equal(seen.at(-1), 1);
    fail = true;
    await act(async () => { await button("下一页").props.onClick(); });
    assert.equal(errors.length, 1);
    assert.match(JSON.stringify(renderer.toJSON()), /page-1/);
    assert.match(text(renderer.toJSON()), /第 1 \/ /);
    act(() => renderer.unmount());
  });
}

test("从股票池进入回测会调用批量接口并展示成功和失败标的", async () => {
  const Component = loadComponent("Backtest");
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith("/api/strategies")) return Response.json({ success: true, strategies: [{ name: "moving_average", display_name: "双均线", default_params: { fast_window: 5, slow_window: 20 } }] });
    assert.ok(url.endsWith("/api/batch_backtest"));
    return Response.json({ success: true, mode: "batch", summary: { tested_count: 1, error_count: 1, avg_return: 0.1 }, results: [{ symbol: "000001.SZ", name: "平安银行", total_return: 0.1 }], errors: [{ symbol: "600519.SH", error: "K线不足" }] });
  };
  let renderer;
  const errors = [];
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, { pendingBatchNames: ["000001.SZ", "600519.SH"], onError: (e) => errors.push(e) })); });
  const mode = renderer.root.findAllByType("select").find((node) => node.props.value === "batch");
  assert.ok(mode);
  await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  const batch = requests.find((request) => request.url.endsWith("/api/batch_backtest"));
  assert.equal(batch.body.symbols, "000001.SZ,600519.SH");
  assert.equal(batch.body.strategy_params.slow_window, 20);
  const output = text(renderer.toJSON());
  assert.match(output, /批量回测结果/);
  assert.match(output, /平安银行/);
  assert.match(output, /K线不足/);
  assert.equal(errors.length, 0);
  act(() => renderer.unmount());
});

test("上证研究预设载入真实指数、半仓参数和后段验证区间", async () => {
  const Component = loadComponent("Backtest");
  globalThis.fetch = async () => Response.json({ success: true, strategies: [{ name: "sse_monthly_trend", display_name: "月度趋势", default_params: { trend_window: 250, momentum_window: 252, buffer_pct: .01, trailing_stop_pct: .12, position_fraction: .5 } }] });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component)); });
  const button = renderer.root.findAllByType("button").find((node) => text(node).includes("载入上证指数半仓研究候选"));
  assert.equal(button.props.disabled, false);
  await act(async () => { button.props.onClick(); });
  const values = renderer.root.findAllByType("select").map((node) => node.props.value);
  assert.ok(values.includes("sse_monthly_trend"));
  assert.ok(values.includes("index"));
  assert.ok(values.includes("sse"));
  assert.ok(renderer.root.findAllByType("input").some((node) => node.props.value === "2021-01-01"));
  assert.ok(renderer.root.findAllByType("input").some((node) => node.props.value === "0.5"));
  act(() => renderer.unmount());
});
