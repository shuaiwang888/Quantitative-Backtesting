"""应用级错误码与异常层级。

设计目标：
- 异常携带机器可读的错误码，方便客户端判断处理。
- HTTP 层统一捕获，转换为带 status 的 JSON 响应。
- 异常链中保留原始异常供日志使用，但响应体只暴露 message，避免泄露内部路径/SQL。
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class AppError(Exception):
    """所有应用层异常的基类。"""

    code: str = "internal_error"
    status: int = 500
    safe_message: str = "服务器内部错误"

    def __init__(
        self,
        message: str,
        *,
        details: Optional[Dict[str, Any]] = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}
        self.__cause__ = cause

    def to_response(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "success": False,
            "error": self.message,
            "code": self.code,
        }
        if self.details:
            body["details"] = self.details
        return body


class ValidationError(AppError):
    """用户输入校验失败（400）。"""

    code = "validation_error"
    status = 400
    safe_message = "请求参数无效"


class AuthError(AppError):
    """API 密钥错误（401）。"""

    code = "auth_error"
    status = 401
    safe_message = "API 密钥无效或未提供"


class RateLimitError(AppError):
    """触发限流（429）。"""

    code = "rate_limited"
    status = 429
    safe_message = "请求过于频繁，请稍后再试"


class UpstreamError(AppError):
    """上游接口（问财 / MiniMax）错误（502）。"""

    code = "upstream_error"
    status = 502
    safe_message = "上游接口返回错误"


class NotFoundError(AppError):
    """接口或资源不存在（404）。"""

    code = "not_found"
    status = 404
    safe_message = "未找到对应资源"


class PersistenceError(AppError):
    """数据库写入失败（500，但不会暴露 SQL 细节给客户端）。"""

    code = "persistence_error"
    status = 500
    safe_message = "数据持久化失败"


__all__ = [
    "AppError",
    "ValidationError",
    "AuthError",
    "RateLimitError",
    "UpstreamError",
    "NotFoundError",
    "PersistenceError",
]
