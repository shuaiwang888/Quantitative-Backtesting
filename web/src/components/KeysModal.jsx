/**
 * KeysModal —— 访客自带 API key 配置
 *
 * Phase 1 实现：最简的 input + save/clear
 * Phase 2 完善：复用原 config.js 的 window.quantKeys（load/save/inject）
 *   把 modal 拆成独立组件并通过 useKeys() hook 拿到 keys 状态。
 */

import { useState } from "react";

const KEYS_STORAGE = "quant_keys";

function loadKeys() {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    if (!raw) return { iwencai: "", minimax: "" };
    return JSON.parse(raw);
  } catch {
    return { iwencai: "", minimax: "" };
  }
}

function saveKeys(partial) {
  const cur = loadKeys();
  const next = {
    iwencai: typeof partial.iwencai === "string" ? partial.iwencai : cur.iwencai,
    minimax: typeof partial.minimax === "string" ? partial.minimax : cur.minimax,
  };
  if (next.iwencai || next.minimax) {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(next));
  } else {
    localStorage.removeItem(KEYS_STORAGE);
  }
  return next;
}

function clearKeys() {
  localStorage.removeItem(KEYS_STORAGE);
  return { iwencai: "", minimax: "" };
}

export default function KeysModal({ onClose }) {
  const [keys, setKeys] = useState(loadKeys());

  const onSave = () => {
    if (!keys.iwencai.trim()) {
      alert("问财 OpenAPI Key 是必填项（用于查数据 / 回测）。");
      return;
    }
    saveKeys({ iwencai: keys.iwencai.trim(), minimax: keys.minimax.trim() });
    onClose();
  };

  const onClear = () => {
    if (!confirm("确认清除本浏览器保存的所有 API 密钥？")) return;
    setKeys(clearKeys());
    onClose();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="keys-modal-title">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel">
        <div className="modal-header">
          <h3 id="keys-modal-title">API 密钥配置</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">
            key <strong>只保存在你浏览器的 localStorage</strong>，绝不上传。
            本页面部署在 GitHub Pages，公开部署时 owner 不会用自己的 key。
          </p>
          <label className="modal-label">
            问财 OpenAPI Key <span className="modal-required">*必填</span>
            <input
              type="password"
              value={keys.iwencai}
              onChange={(e) => setKeys({ ...keys, iwencai: e.target.value })}
              onFocus={(e) => {
                if (e.target.value) {
                  try { e.target.setSelectionRange(0, e.target.value.length); } catch {}
                }
              }}
              placeholder="iwencai_xxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
            />
          </label>
          <label className="modal-label">
            MiniMax Key <span className="modal-optional">可选（用于 AI 复盘）</span>
            <input
              type="password"
              value={keys.minimax}
              onChange={(e) => setKeys({ ...keys, minimax: e.target.value })}
              onFocus={(e) => {
                if (e.target.value) {
                  try { e.target.setSelectionRange(0, e.target.value.length); } catch {}
                }
              }}
              placeholder="eyJxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={onSave}>
              保存
            </button>
            <button type="button" className="secondary" onClick={onClear}>
              清除
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
