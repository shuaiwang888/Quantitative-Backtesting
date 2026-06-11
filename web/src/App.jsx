/**
 * App —— Phase 1 shell
 *
 * 现在只做：
 *   1. 全站 Threads 动画背景（fixed 定位 + pointer-events:none 透传）
 *   2. 基础 tab 切换（首页 / 回测 / 数据 / 选股）+ 占位面板
 *
 * Phase 2 计划：把原 vanilla 2130 行的 app.js 按 tab 拆成 React 组件
 *   - Dashboard.jsx（首页 + 自选股 + 大盘卡片）
 *   - Backtest.jsx（回测表单 + 结果）
 *   - Query.jsx（自然语言问财）
 *   - Selector.jsx（条件选股 + 分页）
 *   - Optimize.jsx（参数寻优可视化）
 *   - KeysModal.jsx（API 密钥 modal）
 */

import { useState } from "react";
import Threads from "./components/Threads.jsx";
import KeysModal from "./components/KeysModal.jsx";

const TABS = [
  { id: "dashboard", label: "首页", placeholder: "首页：大盘 + 自选股行情（Phase 2 转换）" },
  { id: "backtest", label: "回测", placeholder: "回测：单标的 / 批量 / 寻优（Phase 2 转换）" },
  { id: "query", label: "数据", placeholder: "数据：自然语言问财（Phase 2 转换）" },
  { id: "selector", label: "选股", placeholder: "选股：条件选股 + 分页（Phase 2 转换）" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [keysOpen, setKeysOpen] = useState(false);

  return (
    <div className="app-shell">
      {/* 全站 WebGL 动画背景 —— 透传 pointer-events，让内容可交互 */}
      <div className="threads-bg" aria-hidden="true">
        <Threads
          color={[0, 0.94, 1]}        // 青色（与项目 --accent 接近）
          amplitude={1}
          distance={0}
          enableMouseInteraction
        />
      </div>

      {/* 顶部 brand + tabs */}
      <header className="brand">
        <div>
          <h1>A股量化回测</h1>
          <p>问财数据接口 + 均线策略回测</p>
        </div>
        <button
          type="button"
          className="keys-status keys-status--unset"
          onClick={() => setKeysOpen(true)}
          title="配置 API 密钥"
        >
          <span className="keys-status-dot" />
          <span className="keys-status-text">API 密钥</span>
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
        {TABS.map((t) => (
          <section
            key={t.id}
            className="form-view"
            hidden={activeTab !== t.id}
            role="tabpanel"
          >
            <p className="placeholder">{t.placeholder}</p>
            <p className="phase-note">
              Phase 1 已上线：Threads 动画背景 + 基础 tab 切换。
              原 vanilla 实现的 tab 内容正在迁移到 React（Phase 2），迁移期间可访问
              <a href="./index.html.bak"> 旧版</a>（如果存在）。
            </p>
          </section>
        ))}
      </main>

      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  );
}
