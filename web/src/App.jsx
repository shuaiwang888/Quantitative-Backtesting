import { Component, useCallback, useEffect, useRef, useState } from "react";
import Dashboard from "./components/Dashboard.jsx";
import Funds from "./components/Funds.jsx";
import Backtest from "./components/Backtest.jsx";
import Optimize from "./components/Optimize.jsx";
import Query from "./components/Query.jsx";
import Selector from "./components/Selector.jsx";
import {
  checkConnection,
  getApiBase,
  getSessionCredentials,
  setApiBase,
  setSessionCredentials,
} from "./api.js";

const TABS = [
  { id: "dashboard", label: "市场概览", shortLabel: "市场", icon: "market", description: "指数、自选与实时行情" },
  { id: "funds", label: "资金洞察", shortLabel: "资金", icon: "flow", description: "板块热度与主力流向" },
  { id: "backtest", label: "策略回测", shortLabel: "回测", icon: "backtest", description: "验证策略与交易执行" },
  { id: "optimize", label: "参数寻优", shortLabel: "寻优", icon: "tune", description: "探索稳健参数组合" },
  { id: "query", label: "智能数据", shortLabel: "数据", icon: "search", description: "自然语言获取市场数据" },
  { id: "selector", label: "条件选股", shortLabel: "选股", icon: "select", description: "构建并管理股票池" },
];

function getInitialTheme() {
  try {
    const saved = localStorage.getItem("quant_theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [statusMsg, setStatusMsg] = useState("");
  const [pendingBatchNames, setPendingBatchNames] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [health, setHealth] = useState({ state: "checking", message: "正在连接后端，首次启动可能需要约一分钟…" });
  const healthRef = useRef(null);
  const [connection, setConnection] = useState(() => ({ apiBase: getApiBase(), ...getSessionCredentials() }));
  const statusTimerRef = useRef(null);
  const currentTab = TABS.find((tab) => tab.id === activeTab) || TABS[0];

  const showStatus = useCallback((msg) => {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    if (!msg.startsWith("请求失败")) statusTimerRef.current = setTimeout(() => setStatusMsg(""), 3200);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#070a10" : "#edf1f7"
    );
    try { localStorage.setItem("quant_theme", theme); } catch {}
  }, [theme]);

  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  useEffect(() => {
    const handler = (event) => {
      const names = event.detail?.names || [];
      if (names.length === 0) return;
      setPendingBatchNames(names);
      setActiveTab("backtest");
      showStatus(`已载入 ${names.length} 只股票，准备批量回测`);
    };
    window.addEventListener("quant:batch-watchlist", handler);
    return () => window.removeEventListener("quant:batch-watchlist", handler);
  }, []);

  useEffect(() => {
    if (activeTab !== "backtest") setPendingBatchNames(null);
  }, [activeTab]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || settingsOpen) return;
      const tag = event.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < TABS.length) setActiveTab(TABS[index].id);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [settingsOpen]);

  const onError = useCallback((error) => showStatus(`请求失败 · ${error?.message || "请稍后重试"}`), [showStatus]);
  const hasSessionKey = Boolean(connection.iwencaiApiKey || connection.minimaxApiKey || connection.accessKey);

  const saveConnection = (next) => {
    try {
      setApiBase(next.apiBase);
      const credentials = setSessionCredentials(next);
      setConnection({ apiBase: getApiBase(), ...credentials });
      setConnectionVersion((version) => version + 1);
      setSettingsOpen(false);
      showStatus("连接设置已安全更新");
    } catch (error) {
      onError(error);
    }
  };

  const reconnect = useCallback(async (refresh = false) => {
    healthRef.current?.abort();
    const controller = new AbortController();
    healthRef.current = controller;
    setHealth({ state: "checking", message: "正在连接后端，首次启动可能需要约一分钟…" });
    try {
      await checkConnection(getApiBase(), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setHealth({ state: "ready", message: "" });
      if (refresh) setConnectionVersion((version) => version + 1);
    } catch (error) {
      if (!controller.signal.aborted) setHealth({ state: "error", message: error.message });
    }
  }, []);
  useEffect(() => {
    reconnect();
    return () => healthRef.current?.abort();
  }, [connection.apiBase, reconnect]);

  const switchTab = (id) => {
    setActiveTab(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <aside className="sidebar">
        <div className="brand-mark" aria-label="A股量化研究台">
          <span className="brand-symbol" aria-hidden="true"><AppIcon name="spark" /></span>
          <span className="brand-copy"><strong>QuantLab</strong><small>A股策略研究台</small></span>
        </div>

        <nav className="tabs" aria-label="主要功能" role="tablist">
          {TABS.map((tab, index) => (
            <button
              key={tab.id}
              className={`tab ${activeTab === tab.id ? "active" : ""}`}
              type="button"
              onClick={() => switchTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="workspace-panel"
              title={`${tab.label} · 快捷键 ${index + 1}`}
            >
              <span className="tab-icon"><AppIcon name={tab.icon} /></span>
              <span className="tab-copy"><strong>{tab.label}</strong><small>{tab.description}</small></span>
              <kbd>{index + 1}</kbd>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="privacy-note">
            <AppIcon name="shield" />
            <span><strong>本地安全会话</strong><small>密钥关闭页面后即清除</small></span>
          </div>
          <button type="button" className={`connection-card ${hasSessionKey ? "is-ready" : ""}`} onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
            <span className="keys-status-dot" aria-hidden="true" />
            <span><strong>连接设置</strong><small>{hasSessionKey ? "会话密钥已配置" : "使用服务端安全配置"}</small></span>
            <AppIcon name="chevron" />
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="page-heading">
            <span className="eyebrow"><span className="live-dot" /> QUANT RESEARCH</span>
            <h1>{currentTab.label}</h1>
            <p>{currentTab.description}，让每个决策都有数据依据。</p>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "切换到浅色外观" : "切换到深色外观"} title={theme === "dark" ? "浅色外观" : "深色外观"}>
              <AppIcon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <button type="button" className={`keys-status ${hasSessionKey ? "keys-status--set" : ""}`} onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
              <span className="keys-status-dot" aria-hidden="true" /><span>{hasSessionKey ? "安全连接已就绪" : "连接设置"}</span><AppIcon name="sliders" />
            </button>
          </div>
        </header>

        {health.state !== "ready" && <div className="connection-notice" role="status" aria-live="polite">
          <span>{health.message}</span>
          {health.state === "error" && <>
            <button type="button" onClick={() => reconnect(true)}>重新连接并刷新</button>
            <button type="button" onClick={() => setSettingsOpen(true)}>检查连接设置</button>
          </>}
        </div>}
        <main id="workspace-panel" className="page-canvas" role="tabpanel" aria-label={currentTab.label}>
          <div className="page-transition" key={`${activeTab}:${connectionVersion}`}>
            <WorkspaceBoundary key={`${activeTab}:${connectionVersion}`} namespace={activeTab}>
            {activeTab === "dashboard" && <Dashboard onError={onError} onStatus={showStatus} />}
            {activeTab === "funds" && <Funds onError={onError} onStatus={showStatus} />}
            {activeTab === "backtest" && <Backtest onError={onError} onStatus={showStatus} pendingBatchNames={pendingBatchNames} />}
            {activeTab === "optimize" && <Optimize onError={onError} onStatus={showStatus} />}
            {activeTab === "query" && <Query onError={onError} onStatus={showStatus} />}
            {activeTab === "selector" && <Selector onError={onError} onStatus={showStatus} />}
            </WorkspaceBoundary>
          </div>
        </main>
      </div>

      <nav className="mobile-tabs" aria-label="移动端主要功能">
        {TABS.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} type="button" onClick={() => switchTab(tab.id)} aria-current={activeTab === tab.id ? "page" : undefined}>
            <span><AppIcon name={tab.icon} /></span><small>{tab.shortLabel}</small>
          </button>
        ))}
      </nav>

      {statusMsg && (
        <div className={`status-toast ${statusMsg.startsWith("请求失败") ? "is-error" : ""}`} role="status" aria-live="polite">
          <span className="toast-icon"><AppIcon name={statusMsg.startsWith("请求失败") ? "warning" : "check"} /></span>{statusMsg}<button type="button" onClick={() => setStatusMsg("")} aria-label="关闭提示">×</button>
        </div>
      )}
      {settingsOpen && <ConnectionModal value={connection} onSave={saveConnection} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

class WorkspaceBoundary extends Component {
  state = { failed: false, version: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  retry = () => {
    // 缓存可以重新取数，连接密钥、股票池及自选股保留。
    try {
      const prefix = `quant_cached_${this.props.namespace}`;
      Object.keys(localStorage).filter((key) => key === prefix || key.startsWith(`${prefix}_`))
        .forEach((key) => localStorage.removeItem(key));
    } catch {}
    this.setState((old) => ({ failed: false, version: old.version + 1 }));
  };
  render() {
    if (this.state.failed) return <div className="error-box" role="alert">
      <p>当前页面加载失败，缓存可能已失效。</p>
      <button type="button" onClick={this.retry}>重置当前页面缓存并重试</button>
    </div>;
    return <div key={this.state.version}>{this.props.children}</div>;
  }
}

function ConnectionModal({ value, onSave, onClose }) {
  const [draft, setDraft] = useState(value);
  const [probe, setProbe] = useState({ loading: false, message: "", ok: false });
  const probeRef = useRef(null);
  useEffect(() => () => probeRef.current?.abort(), []);
  const testConnection = async () => {
    probeRef.current?.abort();
    const controller = new AbortController();
    probeRef.current = controller;
    setProbe({ loading: true, message: "正在连接；休眠中的服务首次启动可能需要约一分钟…", ok: false });
    try {
      await checkConnection(draft.apiBase, { signal: controller.signal });
      if (!controller.signal.aborted) setProbe({ loading: false, message: "后端连接正常，可保存设置后重试查询。", ok: true });
    } catch (error) {
      if (!controller.signal.aborted) setProbe({ loading: false, message: error.message, ok: false });
    }
  };
  const panelRef = useRef(null);
  const firstInputRef = useRef(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstInputRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const update = (key) => (event) => setDraft((old) => ({ ...old, [key]: event.target.value }));
  const submit = (event) => { event.preventDefault(); onSave(draft); };

  return (
    <div className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <button className="modal-backdrop" type="button" onClick={onClose} aria-label="关闭连接设置" />
      <form className="modal-panel" ref={panelRef} onSubmit={submit}>
        <div className="modal-header">
          <div><span className="modal-kicker">SECURE SESSION</span><h3 id="connection-title">连接与密钥</h3></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><AppIcon name="close" /></button>
        </div>
        <div className="modal-body">
          <div className="modal-hint"><AppIcon name="shield" /><span>密钥仅保存在当前浏览器会话，不写入项目或长期存储。后端已配置密钥时可全部留空。</span></div>
          <label className="modal-label" htmlFor="api-base">后端地址 <span className="modal-optional">留空使用默认地址</span>
            <input id="api-base" ref={firstInputRef} type="url" value={draft.apiBase} onChange={update("apiBase")} placeholder="https://example.com" />
            <button type="button" onClick={() => { setDraft((old) => ({ ...old, apiBase: "" })); setProbe({ loading: false, message: "保存后将恢复默认后端地址", ok: false }); }}>恢复默认后端</button>
          </label>
          <label className="modal-label" htmlFor="iwencai-key">问财 API Key <span className="modal-optional">可选</span>
            <input id="iwencai-key" type="password" autoComplete="off" value={draft.iwencaiApiKey} onChange={update("iwencaiApiKey")} placeholder="仅在当前会话使用" />
          </label>
          <label className="modal-label" htmlFor="minimax-key">MiniMax API Key <span className="modal-optional">可选</span>
            <input id="minimax-key" type="password" autoComplete="off" value={draft.minimaxApiKey} onChange={update("minimaxApiKey")} placeholder="用于 AI 复盘" />
          </label>
          <label className="modal-label" htmlFor="access-key">站点访问密钥 <span className="modal-optional">API_KEY 启用时填写</span>
            <input id="access-key" type="password" autoComplete="off" value={draft.accessKey} onChange={update("accessKey")} />
          </label>
          <div role="status" aria-live="polite" style={{ marginTop: 12 }}>
            <button type="button" onClick={testConnection} disabled={probe.loading}>{probe.loading ? "检测中…" : "检测后端连接"}</button>
            {probe.message && <p className="hint">{probe.message}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-clear" onClick={() => setDraft({ ...draft, iwencaiApiKey: "", minimaxApiKey: "", accessKey: "" })}>清空密钥</button>
            <span className="modal-action-spacer" /><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit">保存并连接</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function AppIcon({ name }) {
  const paths = {
    spark: <><path d="M4 14.5 9.2 4l2.6 7 3-3 5.2 2.6"/><path d="M15 5h4v4"/></>,
    market: <><path d="M3 19V9"/><path d="M8 19V5"/><path d="M13 19v-7"/><path d="M18 19V3"/><path d="M2 19h19"/></>,
    flow: <><path d="M4 17V9"/><path d="M10 17V5"/><path d="M16 17v-4"/><path d="m3 6 5-3 5 4 7-5"/></>,
    backtest: <><path d="M4 19V5"/><path d="M4 19h16"/><path d="m6 15 4-5 3 2 6-7"/><path d="M16 5h3v3"/></>,
    tune: <><path d="M4 6h8"/><path d="M16 6h4"/><circle cx="14" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    select: <><path d="M5 4h14v16H5z"/><path d="m8 11 2.4 2.4L16 8"/></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.7 8 7 10 4.3-2 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-4"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    sliders: <><path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    warning: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17.5v.1"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name] || paths.spark}</svg>;
}
