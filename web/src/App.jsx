/**
 * App —— Phase 2 全 tab 完整版
 *
 * Tab：
 *   - 首页 (Dashboard)      大盘指数 + 自选股
 *   - 回测 (Backtest)       单标的 / 指数回测（指标卡 + 净值曲线 + K线 + 交易表）
 *   - 寻优 (Optimize)       1/2/3+ 参可视化（折线/热力/重要性 + Top 10）
 *   - 数据 (Query)          自然语言问财 + 分页
 *   - 选股 (Selector)       条件选股 + 股票池
 *
 * 跨 tab 通信：
 *   - "quant:batch-watchlist" CustomEvent：从 Dashboard/Selector 跳到 Backtest 时，
 *     把股票池的 names 注入到 Backtest 的 symbol
 */

import { useState, useEffect, useRef } from "react";
import KeysModal from "./components/KeysModal.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Backtest from "./components/Backtest.jsx";
import Optimize from "./components/Optimize.jsx";
import Query from "./components/Query.jsx";
import Selector from "./components/Selector.jsx";
import useKeys from "./hooks/useKeys.js";

const TABS = [
  { id: "dashboard", label: "首页" },
  { id: "backtest", label: "回测" },
  { id: "optimize", label: "寻优" },
  { id: "query", label: "数据" },
  { id: "selector", label: "选股" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [keysOpen, setKeysOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingBatchNames, setPendingBatchNames] = useState(null);
  const statusTimerRef = useRef(null);
  const { keys, isConfigured } = useKeys();

  const showStatus = (msg) => {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(""), 3000);
  };

  // 跨 tab 跳转：Dashboard/Selector → Backtest 批量回测
  useEffect(() => {
    const handler = (e) => {
      const names = e.detail?.names || [];
      if (names.length === 0) return;
      setPendingBatchNames(names);
      setActiveTab("backtest");
      showStatus(`已切换到回测，股票池: ${names.length} 只`);
    };
    window.addEventListener("quant:batch-watchlist", handler);
    return () => window.removeEventListener("quant:batch-watchlist", handler);
  }, []);

  // 监听热力图点击 → 跳到 Selector tab（行业）或 Backtest tab（个股）
  useEffect(() => {
    const handler = (e) => {
      const { name, code, single } = e.detail || {};
      if (!name) return;
      if (single) {
        // 个股 → Backtest tab
        try { sessionStorage.setItem("quant_pending_symbol", JSON.stringify({ name, code })); } catch {}
        setActiveTab("backtest");
        showStatus(`已跳到回测，标的: ${name}`);
      } else {
        // 行业 → Selector tab
        try { sessionStorage.setItem("quant_pending_industry", JSON.stringify({ name, code })); } catch {}
        setActiveTab("selector");
        showStatus(`已跳到选股，行业: ${name}`);
      }
    };
    window.addEventListener("quant:jump-selector", handler);
    return () => window.removeEventListener("quant:jump-selector", handler);
  }, []);

  // tab 切换时清空 pendingBatchNames（避免下次再触发）
  useEffect(() => {
    if (activeTab !== "backtest") setPendingBatchNames(null);
  }, [activeTab]);

  const hasIwencaiKey = Boolean(keys.iwencai);
  const hasMinimaxKey = Boolean(keys.minimax);
  const onError = (e) => showStatus("❌ " + (e.message || "请求失败"));

  return (
    <div className="app-shell">
      {/* 顶部 brand + tabs */}
      <header className="brand">
        <div>
          <h1>A股量化回测</h1>
          <p>问财数据接口 · 网格寻优 · K线复盘</p>
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
            hasIwencaiKey={hasIwencaiKey}
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "backtest" && (
          <Backtest
            hasIwencaiKey={hasIwencaiKey}
            hasMinimaxKey={hasMinimaxKey}
            onError={onError}
            onStatus={showStatus}
            pendingBatchNames={pendingBatchNames}
          />
        )}
        {activeTab === "optimize" && (
          <Optimize
            hasIwencaiKey={hasIwencaiKey}
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "query" && (
          <Query
            hasIwencaiKey={hasIwencaiKey}
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "selector" && (
          <Selector
            hasIwencaiKey={hasIwencaiKey}
            onError={onError}
            onStatus={showStatus}
          />
        )}
      </main>

      {statusMsg && <div className="status-toast">{statusMsg}</div>}

      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  );
}
