/**
 * Smoke test: 在 JSDOM 里加载真实 HTML + JS，验证「保存」按钮的 click handler 真的被绑定。
 *
 * 背景 bug：app.js 在 <body> 末尾，DOMContentLoaded 早已 fire。
 * 之前的代码 document.addEventListener("DOMContentLoaded", ...) 永远等不到，
 * 所以点击"保存"按钮时 modal 不会关闭、status 不会更新，看起来"没反应"。
 *
 * 这个测试在 Node 里加载 static/index.html + app.js + config.js，
 * 模拟浏览器初始化，然后 dispatch click 事件检查 handler 是否生效。
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const STATIC_DIR = path.join(__dirname, "..", "static");
const html = fs.readFileSync(path.join(STATIC_DIR, "index.html"), "utf-8");
const appJs = fs.readFileSync(path.join(STATIC_DIR, "app.js"), "utf-8");
const configJs = fs.readFileSync(path.join(STATIC_DIR, "config.js"), "utf-8");

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost:8000/",
});

const { window } = dom;
const { document } = window;

// Stub Canvas 2D context（JSDOM 没装 canvas 包，getContext 返回 null 会让 app.js 启动崩溃）
window.HTMLCanvasElement.prototype.getContext = function () {
  return {
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
};

// 提供一个 localStorage / fetch stub 让 config.js 跑得通
const storage = {};
window.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
};
window.fetch = () => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ success: true, datas: [] }),
});
window.alert = (msg) => { window.__lastAlert = msg; };
window.confirm = () => true;

// 注入 config.js 再 app.js（与 HTML 中顺序一致）
window.eval(configJs);
// 真实浏览器：<script> 在 <body> 末尾时，DOM 解析完 → readyState 已是 "interactive"。
// JSDOM with runScripts: "outside-only" 不会自动 fire DOMContentLoaded，
// 我们手动模拟浏览器已就绪的状态，让 ready() 的 else 分支直接跑 fn()。
Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
window.eval(appJs);
// 再 dispatch DOMContentLoaded 模拟 fire 阶段（验证 listener 路径也通）
document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));

// 让 ready() 的同步分支跑完后才能验证
let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log("  ✅ " + label);
  } else {
    console.log("  ❌ " + label);
    failures++;
  }
}

console.log("\n[1] API 密钥按钮存在");
const btnKeys = document.querySelector("#btn-keys");
check("#btn-keys 存在", !!btnKeys);
check("初始带 keys-status--unset class", btnKeys && btnKeys.classList.contains("keys-status--unset"));

console.log("\n[2] 点击按钮打开模态框");
btnKeys.click();
const modal = document.querySelector("#keys-modal");
check("模态框打开后 hidden=false", modal && !modal.hidden);
const iwInput = document.querySelector("#input-iwencai-key");
check("问财 key 输入框存在", !!iwInput);

console.log("\n[3] 填入 key 并点击保存");
iwInput.value = "test-iwencai-key-1234567890";
const btnSave = document.querySelector("#btn-save-keys");
check("#btn-save-keys 存在", !!btnSave);
btnSave.click();

const modal2 = document.querySelector("#keys-modal");
check("保存后模态框关闭", modal2 && modal2.hidden);
const btnKeys2 = document.querySelector("#btn-keys");
check("按钮状态变 keys-status--set", btnKeys2 && btnKeys2.classList.contains("keys-status--set"));
check("按钮文案变 '密钥✓'", btnKeys2 && btnKeys2.textContent.includes("密钥✓"));

const stored = window.localStorage.getItem("quant_keys");
check("localStorage.quant_keys 已写入", !!stored);
check("写入值含 iwencai key", stored && stored.includes("test-iwencai-key-1234567890"));

console.log("\n[4] 重新打开 → 字段被预填 + auto-focus 不清空");
btnKeys2.click();
const iwInput2 = document.querySelector("#input-iwencai-key");
check("重新打开后输入框预填了 key", iwInput2 && iwInput2.value === "test-iwencai-key-1234567890");
// 关键回归：openModal 50ms 后会 iw.focus()，旧的 focus 监听器会把 value 清掉。
// 现在改用 setSelectionRange（不清空），所以 modal 重新打开时 iw 应该保留。
// JSDOM 里 setTimeout 不会自动 fire，需要等它跑完。
setTimeout(() => {
  const iwAfterAutoFocus = document.querySelector("#input-iwencai-key");
  check(
    "auto-focus 后 iwencai value 不被清空（关键回归）",
    iwAfterAutoFocus && iwAfterAutoFocus.value === "test-iwencai-key-1234567890"
  );

  console.log("\n[4b] 二次打开时填入 minimax → 两个都存");
  // 模拟"加 minimax 而不动 iwencai"
  const mnInput = document.querySelector("#input-minimax-key");
  mnInput.value = "test-minimax-key-9876543210";
  // 不要点 iw 触发 focus 监听器（现在的行为是 setSelectionRange，不清空，但保险起见也再触发一次）
  // 直接点保存
  btnSave.click();
  const storedBoth = JSON.parse(window.localStorage.getItem("quant_keys") || "{}");
  check(
    "保存后 iwencai 没丢",
    storedBoth.iwencai === "test-iwencai-key-1234567890"
  );
  check(
    "保存后 minimax 也存了",
    storedBoth.minimax === "test-minimax-key-9876543210"
  );

  console.log("\n[5] 清除按钮可用");
  const btnClear = document.querySelector("#btn-clear-keys");
  check("#btn-clear-keys 存在", !!btnClear);
  btnClear.click();
  const storedAfter = window.localStorage.getItem("quant_keys");
  check("清除后 localStorage.quant_keys 已删除", storedAfter === null);
  const btnKeys3 = document.querySelector("#btn-keys");
  check("按钮回到 keys-status--unset", btnKeys3 && btnKeys3.classList.contains("keys-status--unset"));

  console.log("\n[6] 没填 key 时保存应弹窗警告");
  btnKeys3.click();
  const iwInput3 = document.querySelector("#input-iwencai-key");
  iwInput3.value = "";
  btnSave.click();
  check("空 iwencai 触发 alert", window.__lastAlert && window.__lastAlert.includes("必填"));

  console.log("\n" + (failures === 0 ? "🎉 全部通过" : `❌ ${failures} 个失败`));
  process.exit(failures === 0 ? 0 : 1);
}, 100); // 等 openModal 里的 setTimeout(50) 跑完