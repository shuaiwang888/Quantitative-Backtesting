// 配置 API base URL —— 部署到 GitHub Pages 时用。
//
// 优先级：
//   1. URL 参数 ?api=https://xxx.onrender.com  （首次配置，自动写到 localStorage）
//   2. localStorage.quant_api_base  （记住上一次）
//   3. ""（同源；本地开发用 http://127.0.0.1:8000）
//
// 注意：部署到 Pages 后，前端和后端不在同一个 origin，必须通过这个参数
// 把后端的公网 URL 配进来；否则浏览器会 fetch(同源/api/...) 然后 404。
(function () {
  "use strict";

  function normalize(url) {
    if (!url) return "";
    return url.replace(/\/+$/, "");  // 去掉末尾的 /，避免拼出 //api/...
  }

  function isValidHttpUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_e) {
      return false;
    }
  }

  const params = new URLSearchParams(location.search);
  const fromQuery = normalize(params.get("api"));
  if (fromQuery) {
    if (!isValidHttpUrl(fromQuery)) {
      console.warn("[quant] ?api= 不是合法 http(s) URL，已忽略:", fromQuery);
    } else {
      try {
        localStorage.setItem("quant_api_base", fromQuery);
        console.log("[quant] API base 已写入 localStorage:", fromQuery);
      } catch (_e) {
        // localStorage 不可用（隐私模式 / 跨域）就只在内存里存
      }
    }
  }

  let fromStorage = "";
  try {
    fromStorage = normalize(localStorage.getItem("quant_api_base") || "");
  } catch (_e) {
    // 忽略
  }

  window.API_BASE = fromStorage || "";

  // 调试用：在控制台显示当前生效的 base（生产环境对用户友好）
  if (window.API_BASE) {
    console.info("[quant] API base:", window.API_BASE, "（同源回退已禁用）");
  } else {
    console.info("[quant] API base: 同源（本地开发）");
  }
})();