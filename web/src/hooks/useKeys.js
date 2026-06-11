/**
 * useKeys —— 访客密钥管理的 React hook
 *
 * 用法：
 *   const { keys, save, clear, isConfigured, masked } = useKeys();
 *   save({ iwencai: "xxx" });
 *   isConfigured() → true / false
 */

import { useState, useEffect, useCallback } from "react";
import { loadKeys, saveKeys, clearKeys, isKeysConfigured, maskKey } from "../api.js";

export default function useKeys() {
  const [keys, setKeys] = useState(loadKeys);

  // 跨 tab 同步
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "quant_keys") setKeys(loadKeys());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const save = useCallback((partial) => {
    const next = saveKeys(partial);
    setKeys(next);
    return next;
  }, []);

  const clear = useCallback(() => {
    const next = clearKeys();
    setKeys(next);
    return next;
  }, []);

  const masked = {
    iwencai: maskKey(keys.iwencai),
    minimax: maskKey(keys.minimax),
  };

  return { keys, save, clear, isConfigured: isKeysConfigured, masked };
}
