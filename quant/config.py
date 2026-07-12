"""集中式配置：所有环境变量集中解析与校验。

- 通过 dataclass 暴露类型化字段，调用方拿到的是有类型的 Settings 实例。
- 启动时打印"安全摘要"（不打印密钥），便于排错。
- 字段缺失时给出明确错误而不是抛 KeyError。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional


_TRUE = frozenset({"1", "true", "yes", "on"})


def _get(name: str, default: Optional[str] = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"缺少必需的环境变量: {name}")
    return value or ""


def _get_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"环境变量 {name} 必须是整数，得到: {raw!r}") from exc


def _get_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f"环境变量 {name} 必须是浮点数，得到: {raw!r}") from exc


def _get_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE


@dataclass(frozen=True)
class Settings:
    """运行期配置。"""

    # --- HTTP 服务 ---
    # 默认 0.0.0.0 同时满足：
    #   - 本地 start.sh 显式 export HOST=127.0.0.1 → 走 127.0.0.1
    #   - HF Space 不注入 HOST → 走 0.0.0.0 满足健康检查
    host: str = field(default_factory=lambda: _get("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _get_int("PORT", 8000))
    cors_origin: str = field(default_factory=lambda: _get("CORS_ORIGIN", "*"))

    # --- 鉴权与限流 ---
    api_key: str = field(default_factory=lambda: _get("API_KEY", ""))
    api_key_hash: str = field(default_factory=lambda: _get("API_KEY_HASH", ""))
    rate_limit: int = field(default_factory=lambda: _get_int("RATE_LIMIT", 60))
    rate_window: int = field(default_factory=lambda: _get_int("RATE_WINDOW", 60))
    # 信任的反向代理白名单（逗号分隔），可识别：
    #   - cloudflare → CF-Connecting-IP
    #   - render     → X-Real-IP
    #   - forwarded  → X-Forwarded-For 第一段
    #   - all / *    → 以上全部
    # 默认空 → 不信任任何代理头，直接用 socket peer address（防伪造 XFF 绕过限流）
    trusted_proxies: str = field(default_factory=lambda: _get("TRUSTED_PROXIES", ""))

    # --- 问财 API ---
    # 公开部署场景：owner 可以不配（访客在浏览器填自己的 key）。
    # 缺 key 时不会启动失败，只是请求时会抛 IwencaiError("API 密钥未设置")，
    # 由前端 modal 引导访客配置。
    iwencai_api_key: str = field(
        default_factory=lambda: _get("IWENCAI_API_KEY", "")
    )

    # --- MiniMax LLM ---
    minimax_api_key: str = field(default_factory=lambda: _get("MINIMAX_API_KEY", ""))
    minimax_base_url: str = field(
        default_factory=lambda: _get("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    )
    minimax_model: str = field(default_factory=lambda: _get("MINIMAX_MODEL", "MiniMax-M3"))
    minimax_timeout: int = field(default_factory=lambda: _get_int("MINIMAX_TIMEOUT", 180))
    minimax_max_tokens: int = field(default_factory=lambda: _get_int("MINIMAX_MAX_TOKENS", 4096))

    def __post_init__(self) -> None:
        """构造时校验 LLM 配置，提前发现不匹配。"""
        if not self.minimax_api_key:
            return  # LLM 关闭，跳过
        url = self.minimax_base_url.rstrip("/")
        # 客户端实现是 Anthropic 兼容协议（POST {base}/v1/messages + x-api-key）
        if not (url.endswith("/anthropic") or url.endswith("/anthropic/v1")):
            raise RuntimeError(
                "MINIMAX_BASE_URL 与 LLM 客户端不匹配：当前客户端仅支持 Anthropic 兼容协议，"
                f"应当以 /anthropic 结尾（当前值: {self.minimax_base_url}）。"
                "如需切换到 OpenAI 兼容端点 /v1，请同步重写 quant/data/llm.py。"
            )
        if self.minimax_model != self.minimax_model.strip():
            raise RuntimeError(
                f"MINIMAX_MODEL 包含首尾空白: {self.minimax_model!r}"
            )

    # --- MySQL 持久化 ---
    mysql_persist_enabled: bool = field(
        default_factory=lambda: _get_bool("MYSQL_PERSIST_ENABLED", False)
    )
    mysql_auto_persist: bool = field(
        default_factory=lambda: _get_bool("MYSQL_AUTO_PERSIST", False)
    )
    mysql_host: str = field(default_factory=lambda: _get("MYSQL_HOST", "127.0.0.1"))
    mysql_port: int = field(default_factory=lambda: _get_int("MYSQL_PORT", 3306))
    mysql_socket: str = field(default_factory=lambda: _get("MYSQL_SOCKET", ""))
    mysql_user: str = field(default_factory=lambda: _get("MYSQL_USER", "quant_user"))
    mysql_password: str = field(default_factory=lambda: _get("MYSQL_PASSWORD", ""))
    mysql_database: str = field(default_factory=lambda: _get("MYSQL_DATABASE", "quant_backtest"))

    # --- 寻优 ---
    optimize_max_combinations: int = field(
        default_factory=lambda: _get_int("OPTIMIZE_MAX_COMBINATIONS", 2000)
    )
    optimize_timeout_seconds: int = field(
        default_factory=lambda: _get_int("OPTIMIZE_TIMEOUT_SECONDS", 120)
    )
    optimize_n_jobs: int = field(
        default_factory=lambda: _get_int("OPTIMIZE_N_JOBS", max(1, __import__("os").cpu_count() or 1))
    )

    # --- 批量回测 ---
    batch_max_symbols: int = field(default_factory=lambda: _get_int("BATCH_MAX_SYMBOLS", 100))
    batch_max_workers: int = field(default_factory=lambda: _get_int("BATCH_MAX_WORKERS", 10))

    # --- 日志 ---
    log_level: str = field(default_factory=lambda: _get("LOG_LEVEL", "INFO"))

    def safe_summary(self) -> str:
        """打印安全摘要（不泄露密钥）。"""
        return (
            f"host={self.host} port={self.port} "
            f"cors={self.cors_origin} "
            f"auth={'enabled' if self.api_key or self.api_key_hash else 'disabled'} "
            f"rate_limit={self.rate_limit}/{self.rate_window}s "
            f"trusted_proxies={self.trusted_proxies or 'off'} "
            f"iwencai={'owner' if self.iwencai_api_key else 'visitor'} "
            f"mysql={'enabled' if self.mysql_persist_enabled else 'disabled'} "
            f"llm={'enabled' if self.minimax_api_key else 'visitor'}"
        )


_cached: Optional[Settings] = None


def get_settings() -> Settings:
    """惰性构造单例，便于测试覆盖。"""
    global _cached
    if _cached is None:
        _cached = Settings()
    return _cached


def reset_settings_cache() -> None:
    """用于测试：在 patch.dict 之后重置单例。"""
    global _cached
    _cached = None


__all__ = ["Settings", "get_settings", "reset_settings_cache"]
