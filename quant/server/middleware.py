"""鉴权 + 限流中间件（修复 #7 #13 #14）。"""

from __future__ import annotations

import hmac
import threading
import time
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Dict, Optional, Tuple

from quant.config import Settings
from quant.errors import AuthError, RateLimitError


@dataclass
class RateLimiter:
    """基于滑动窗口的限流器。

    修复历史 bug：原实现用 dict 累积 client_ip 永不清扫，恶意 X-Forwarded-For 可 OOM。
    改进：
    - 每次 put 都清理超过 2 个窗口的过期 bucket。
    - 限制 bucket 总数上限，超出时强制清空。
    """

    limit: int
    window_seconds: int
    _buckets: Dict[str, Tuple[int, float]] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _max_buckets: int = 10000

    def check(self, key: str) -> None:
        now = time.time()
        with self._lock:
            self._gc_locked(now)
            count, window_start = self._buckets.get(key, (0, now))
            if now - window_start >= self.window_seconds:
                count, window_start = 0, now
            if count >= self.limit:
                raise RateLimitError(
                    "请求过于频繁，请稍后再试",
                    details={"limit": self.limit, "window": self.window_seconds},
                )
            self._buckets[key] = (count + 1, window_start)

    def _gc_locked(self, now: float) -> None:
        cutoff = now - self.window_seconds * 2
        stale = [k for k, (_, ws) in self._buckets.items() if ws < cutoff]
        for k in stale:
            self._buckets.pop(k, None)
        # 硬上限保护：超出后清空最旧的一半
        if len(self._buckets) > self._max_buckets:
            sorted_items = sorted(self._buckets.items(), key=lambda kv: kv[1][1])
            for k, _ in sorted_items[: len(sorted_items) // 2]:
                self._buckets.pop(k, None)


def check_auth(payload: dict, settings: Settings) -> None:
    """根据配置校验 API Key。未配置 = 不校验（向后兼容）。"""
    if not settings.api_key and not settings.api_key_hash:
        return
    provided = payload.get("api_key") or settings.api_key
    if not provided:
        raise AuthError("API 密钥未提供")
    if settings.api_key_hash:
        digest = sha256(provided.encode()).hexdigest()
        if not hmac.compare_digest(digest, settings.api_key_hash):
            raise AuthError("API 密钥无效")
        return
    # 仅配置了 API_KEY 而没配置 HASH 时，校验长度
    if len(provided) < 16:
        raise AuthError("API 密钥无效")


def get_client_key(handler) -> str:
    """优先使用 X-Forwarded-For 第一段，否则回退到 client_address。"""
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = handler.headers.get("X-Real-IP", "")
    if real_ip:
        return real_ip.strip()
    return handler.client_address[0] if handler.client_address else "unknown"


__all__ = ["RateLimiter", "check_auth", "get_client_key"]
