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
 *   - "quant:watchlist-changed" 事件：自选股变化后 Dashboard 自动刷新
 *
 * 注：API key 全部在 Render 后端 Environment 配置，前端不再处理 key。
 */

import { useState, useEffect, useRef } from "react";
import Dashboard from "./components/Dashboard.jsx";
import Backtest from "./components/Backtest.jsx";
import Optimize from "./components/Optimize.jsx";
import Query from "./components/Query.jsx";
import Selector from "./components/Selector.jsx";

const TABS = [
  { id: "dashboard", label: "首页" },
  { id: "backtest", label: "回测" },
  { id: "optimize", label: "寻优" },
  { id: "query", label: "数据" },
  { id: "selector", label: "选股" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingBatchNames, setPendingBatchNames] = useState(null);
  const statusTimerRef = useRef(null);

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

  // tab 切换时清空 pendingBatchNames（避免下次再触发）
  useEffect(() => {
    if (activeTab !== "backtest") setPendingBatchNames(null);
  }, [activeTab]);

  const onError = (e) => showStatus("❌ " + (e.message || "请求失败"));

  return (
    <div className="app-shell">
      {/* 顶部 brand + tabs */}
      <header className="brand">
        <div>
          <h1>A股量化回测</h1>
          <p>问财数据接口 · 网格寻优 · K线复盘</p>
        </div>
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
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "backtest" && (
          <Backtest
            onError={onError}
            onStatus={showStatus}
            pendingBatchNames={pendingBatchNames}
          />
        )}
        {activeTab === "optimize" && (
          <Optimize
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "query" && (
          <Query
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "selector" && (
          <Selector
            onError={onError}
            onStatus={showStatus}
          />
        )}
      </main>

      {statusMsg && <div className="status-toast">{statusMsg}</div>}
    </div>
  );
}
