/**
 * App —— Phase 2 / Step 4
 *
 * 当前已实现：
 *   - 全站 Threads 动画背景
 *   - 4 tab 切换
 *   - KeysModal（API 密钥配置）
 *   - Dashboard tab（大盘 + 自选股）
 *
 * Phase 2 / Step 5+ 待办：
 *   - Backtest.jsx（回测表单 + 指标卡 + 净值曲线 + K 线）
 *   - Optimize.jsx（参数寻优可视化）
 *   - Query.jsx / Selector.jsx
 */

import { useState, useEffect, useRef } from "react";
import KeysModal from "./components/KeysModal.jsx";
import Dashboard from "./components/Dashboard.jsx";
import useKeys from "./hooks/useKeys.js";

const TABS = [
  { id: "dashboard", label: "首页" },
  { id: "backtest", label: "回测" },
  { id: "query", label: "数据" },
  { id: "selector", label: "选股" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [keysOpen, setKeysOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const statusTimerRef = useRef(null);
  const { keys, isConfigured } = useKeys();

  const showStatus = (msg) => {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(""), 3000);
  };

  // 监听 Dashboard 的"批量回测自选股"事件
  useEffect(() => {
    const handler = (e) => {
      const names = e.detail?.names || [];
      if (names.length === 0) return;
      try { sessionStorage.setItem("quant_pending_batch", JSON.stringify(names)); } catch {}
      setActiveTab("backtest");
      showStatus(`已切换到回测，股票池: ${names.length} 只`);
    };
    window.addEventListener("quant:batch-watchlist", handler);
    return () => window.removeEventListener("quant:batch-watchlist", handler);
  }, []);

  return (
    <div className="app-shell">
      {/* 顶部 brand + tabs */}
      <header className="brand">
        <div>
          <h1>A股量化回测</h1>
          <p>问财数据接口 + 均线策略回测</p>
        </div>
        <button
          type="button"
          className={`keys-status ${isConfigured() ? "keys-status--set" : "keys-status--unset"}`}
          onClick={() => setKeysOpen(true)}
          title={
            isConfigured()
              ? `问财: ${keys.iwencai ? "已配" : "(未填)"}\nMiniMax: ${keys.minimax ? "已配" : "(未填)"}\n点击修改`
              : "未配置 API 密钥，点击配置"
          }
        >
          <span className="keys-status-dot" />
          <span className="keys-status-text">{isConfigured() ? "密钥✓" : "API 密钥"}</span>
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}`}
            data-tab={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            role="tab"
            aria-selected={activeTab === t.id}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {activeTab === "dashboard" && (
          <Dashboard
            hasIwencaiKey={Boolean(keys.iwencai)}
            onError={(e) => showStatus("刷新失败: " + e.message)}
          />
        )}
        {activeTab === "backtest" && <PlaceholderTab id="backtest" />}
        {activeTab === "query" && <PlaceholderTab id="query" />}
        {activeTab === "selector" && <PlaceholderTab id="selector" />}
      </main>

      {statusMsg && <div className="status-toast">{statusMsg}</div>}

      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  );
}

function PlaceholderTab({ id }) {
  const labels = {
    backtest: "回测：单标的 / 批量 / 寻优（Phase 2 / Step 5 转换中）",
    query: "数据：自然语言问财（Phase 2 / Step 7 转换中）",
    selector: "选股：条件选股 + 分页（Phase 2 / Step 7 转换中）",
  };
  return (
    <section className="form-view">
      <p className="placeholder">{labels[id]}</p>
    </section>
  );
}
