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
 * 访客密钥只保存在 sessionStorage，关闭标签页后自动清除。
 */

import { useState, useEffect, useRef } from "react";
import Dashboard from "./components/Dashboard.jsx";
import Funds from "./components/Funds.jsx";
import Backtest from "./components/Backtest.jsx";
import Optimize from "./components/Optimize.jsx";
import Query from "./components/Query.jsx";
import Selector from "./components/Selector.jsx";
import {
  getApiBase,
  getSessionCredentials,
  setApiBase,
  setSessionCredentials,
} from "./api.js";

const TABS = [
  { id: "dashboard", label: "首页" },
  { id: "funds", label: "资金" },
  { id: "backtest", label: "回测" },
  { id: "optimize", label: "寻优" },
  { id: "query", label: "数据" },
  { id: "selector", label: "选股" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingBatchNames, setPendingBatchNames] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState(() => ({
    apiBase: getApiBase(),
    ...getSessionCredentials(),
  }));
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
  const hasSessionKey = Boolean(
    connection.iwencaiApiKey || connection.minimaxApiKey || connection.accessKey
  );

  const saveConnection = (next) => {
    try {
      setApiBase(next.apiBase);
      const credentials = setSessionCredentials(next);
      setConnection({ apiBase: getApiBase(), ...credentials });
      setSettingsOpen(false);
      showStatus("连接设置已更新");
    } catch (error) {
      onError(error);
    }
  };

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
          className={`keys-status ${hasSessionKey ? "keys-status--set" : ""}`}
          onClick={() => setSettingsOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="keys-status-dot" aria-hidden="true" />
          连接设置{hasSessionKey ? " · 会话密钥已设" : ""}
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
            onError={onError}
            onStatus={showStatus}
          />
        )}
        {activeTab === "funds" && (
          <Funds
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

      {statusMsg && <div className="status-toast" role="status" aria-live="polite">{statusMsg}</div>}
      {settingsOpen && (
        <ConnectionModal
          value={connection}
          onSave={saveConnection}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function ConnectionModal({ value, onSave, onClose }) {
  const [draft, setDraft] = useState(value);
  const firstInputRef = useRef(null);

  useEffect(() => {
    firstInputRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = (key) => (event) => setDraft((old) => ({ ...old, [key]: event.target.value }));
  const submit = (event) => {
    event.preventDefault();
    onSave(draft);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <button className="modal-backdrop" type="button" onClick={onClose} aria-label="关闭连接设置" />
      <form className="modal-panel" onSubmit={submit}>
        <div className="modal-header">
          <h3 id="connection-title">连接与密钥</h3>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">
            密钥仅保存在当前浏览器会话，不会写入项目或长期存储。
            如后端已配置 owner 密钥，这些字段可留空。
          </p>
          <label className="modal-label" htmlFor="api-base">
            后端地址 <span className="modal-optional">留空=同源/默认</span>
            <input id="api-base" ref={firstInputRef} type="url" value={draft.apiBase} onChange={update("apiBase")} placeholder="https://example.com" />
          </label>
          <label className="modal-label" htmlFor="iwencai-key">
            问财 API Key <span className="modal-optional">可选</span>
            <input id="iwencai-key" type="password" autoComplete="off" value={draft.iwencaiApiKey} onChange={update("iwencaiApiKey")} />
          </label>
          <label className="modal-label" htmlFor="minimax-key">
            MiniMax API Key <span className="modal-optional">可选</span>
            <input id="minimax-key" type="password" autoComplete="off" value={draft.minimaxApiKey} onChange={update("minimaxApiKey")} />
          </label>
          <label className="modal-label" htmlFor="access-key">
            站点访问密钥 <span className="modal-optional">后端启用 API_KEY 时填写</span>
            <input id="access-key" type="password" autoComplete="off" value={draft.accessKey} onChange={update("accessKey")} />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setDraft({ apiBase: "", iwencaiApiKey: "", minimaxApiKey: "", accessKey: "" })}>清空</button>
            <button type="button" onClick={onClose}>取消</button>
            <button className="primary" type="submit">保存</button>
          </div>
        </div>
      </form>
    </div>
  );
}
