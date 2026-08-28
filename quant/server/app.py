"""HTTP 入口：BacktestHandler。

- 路由分发到 service 层
- 统一错误处理：AppError 转 JSON；其他异常只暴露安全 message
- CORS / OPTIONS
"""

from __future__ import annotations

import json
import socket
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from quant.config import get_settings
from quant.data.iwencai import IwencaiError
from quant.errors import AppError, RateLimitError, ValidationError
from quant.logging_setup import access_log, get_logger, setup_logging
from quant.persistence import init_persistence
from quant.server.middleware import RateLimiter, check_auth, get_client_key
from quant.server.responses import cors_preflight, json_response
from quant.services import (
    analyze,
    fetch_bars,
    natural_language_query,
    run_batch_backtest,
    run_grid_search_from_payload,
    run_single_backtest,
)
from quant.services.backtest import BacktestRequest
from quant.services.batch import BatchRequest
from quant.services.query import QueryRequest
from quant.payload_utils import _coerce_bool, _payload_float, _payload_int, _payload_str
from quant.strategies import SPECS


STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"
_LOG = get_logger("server")


def _build_limiter() -> RateLimiter:
    settings = get_settings()
    return RateLimiter(limit=settings.rate_limit, window_seconds=settings.rate_window)


class BacktestHandler(SimpleHTTPRequestHandler):
    server_version = "AStockBacktest/0.3"

    # 进程级单例
    limiter: RateLimiter = None  # type: ignore[assignment]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def setup(self) -> None:
        """限制慢请求占用工作线程的时间。"""
        super().setup()
        self.connection.settimeout(get_settings().request_timeout)

    def end_headers(self) -> None:
        """为 API 和静态资源统一添加安全响应头。"""
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self' https:; font-src 'self' data:; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    # --- HTTP 方法 ---

    def do_GET(self) -> None:  # noqa: N802
        # API 路由：仅 /api/strategies 支持 GET，其余 GET 走静态资源
        # 先把 query string 切掉，否则 /api/strategies?nocache=1 不命中严格匹配
        path = urlsplit(self.path).path
        if path == "/api/health":
            settings = get_settings()
            return json_response(
                self,
                {"success": True, "status": "ok"},
                cors_origin=settings.cors_origin,
            )
        if path == "/api/strategies":
            # 同步规范化 self.path，让下游 _dispatch 也能命中路由
            self.path = path
            try:
                settings = get_settings()
                self._dispatch({}, settings)
            except AppError as exc:
                return json_response(
                    self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
                )
            return
        if path.startswith("/api/"):
            from quant.errors import NotFoundError

            settings = get_settings()
            exc = NotFoundError(f"未知接口: {path}")
            return json_response(
                self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
            )
        if path in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        cors_preflight(self, get_settings().cors_origin)

    def do_POST(self) -> None:  # noqa: N802
        start = time.time()
        status_holder: Dict[str, int] = {"status": 500}
        settings = get_settings()
        try:
            self.path = urlsplit(self.path).path
            client_key = get_client_key(self)
            if self.limiter is not None:
                self.limiter.check(client_key)
            payload = self._read_json()
            check_auth(payload, settings, self.headers)
            payload = _normalize_request_credentials(payload, settings, self.headers)
            self._dispatch(payload, settings)
            status_holder["status"] = 200
        except _PayloadTooLarge:
            status_holder["status"] = 413
            return json_response(
                self,
                {"success": False, "code": "payload_too_large", "error": "请求体过大"},
                status=413,
                cors_origin=settings.cors_origin,
            )
        except RateLimitError as exc:
            status_holder["status"] = exc.status
            retry_after = getattr(exc, "retry_after", None) or settings.rate_window
            return json_response(
                self,
                exc.to_response(),
                status=exc.status,
                cors_origin=settings.cors_origin,
                extra_headers={"Retry-After": str(retry_after)},
            )
        except AppError as exc:
            status_holder["status"] = exc.status
            _LOG.warning("业务错误 %s %s: %s", self.command, self.path, exc.message)
            return json_response(
                self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
            )
        except IwencaiError:
            status_holder["status"] = 502
            return json_response(
                self,
                {"success": False, "code": "upstream_error", "error": "上游接口返回错误"},
                status=502,
                cors_origin=settings.cors_origin,
            )
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            status_holder["status"] = 499
            _LOG.info("客户端在请求完成前断开: %s", self.path)
        except Exception:  # noqa: BLE001
            _LOG.exception("未处理异常 %s %s", self.command, self.path)
            return json_response(
                self,
                {"success": False, "code": "internal_error", "error": "服务器内部错误"},
                status=500,
                cors_origin=settings.cors_origin,
            )
        finally:
            duration_ms = (time.time() - start) * 1000
            access_log(
                self.command,
                self.path,
                status_holder["status"],
                duration_ms,
                client=client_key if "client_key" in locals() else None,
            )

    # --- 路由 ---

    def _dispatch(self, payload: Dict[str, Any], settings) -> None:  # type: ignore[no-untyped-def]
        path = self.path
        if path == "/api/query":
            self._handle_query(payload)
        elif path == "/api/backtest":
            self._handle_backtest(payload)
        elif path == "/api/batch_backtest":
            self._handle_batch_backtest(payload)
        elif path == "/api/analyze":
            self._handle_analyze(payload)
        elif path == "/api/optimize":
            self._handle_optimize(payload)
        elif path == "/api/bars":
            self._handle_bars(payload)
        elif path == "/api/strategies":
            self._handle_strategies()
        else:
            from quant.errors import NotFoundError
            raise NotFoundError(f"未知接口: {path}")

    def _handle_query(self, payload: Dict[str, Any]) -> None:
        req = QueryRequest(
            query=_payload_str(payload.get("query", ""), "", "query"),
            page=_payload_int(payload.get("page"), 1, "page"),
            limit=_payload_int(payload.get("limit"), 50, "limit"),
            parser_logic=_coerce_bool(payload.get("parser_logic", False)),
            persist=_coerce_bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
        )
        result = natural_language_query(req)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_backtest(self, payload: Dict[str, Any]) -> None:
        req = BacktestRequest(
            strategy=_payload_str(payload.get("strategy"), "momentum_atr", "strategy"),
            backtest_mode=_payload_str(payload.get("backtest_mode"), "single", "backtest_mode"),
            symbol=_payload_str(payload.get("symbol", ""), "", "symbol"),
            index_symbol=_payload_str(payload.get("index_symbol"), "hs300", "index_symbol"),
            start_date=_payload_str(payload.get("start_date", ""), "", "start_date"),
            end_date=_payload_str(payload.get("end_date", ""), "", "end_date"),
            query=_payload_str(payload.get("query", ""), "", "query"),
            initial_cash=_payload_float(payload.get("initial_cash"), 100000, "initial_cash"),
            fee_rate=_payload_float(payload.get("fee_rate"), 0.0003, "fee_rate"),
            slippage_rate=_payload_float(payload.get("slippage_rate"), 0.0005, "slippage_rate"),
            min_commission=_payload_float(payload.get("min_commission"), 5.0, "min_commission"),
            stamp_duty_rate=_payload_float(payload.get("stamp_duty_rate"), 0.0005, "stamp_duty_rate"),
            transfer_fee_rate=_payload_float(payload.get("transfer_fee_rate"), 0.00001, "transfer_fee_rate"),
            lot_size=_payload_int(payload.get("lot_size"), 100, "lot_size"),
            max_pending_bars=_payload_int(
                payload.get("max_pending_bars"), 5, "max_pending_bars"
            ),
            price_limit_pct=_optional_payload_float(payload, "price_limit_pct"),
            persist=_coerce_bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
            limit=_payload_int(payload.get("limit"), 100, "limit"),
            max_pages=_payload_int(payload.get("max_pages"), 10, "max_pages"),
            strategy_params=_strategy_params(payload),
        )
        result = run_single_backtest(req)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_batch_backtest(self, payload: Dict[str, Any]) -> None:
        req = BatchRequest(
            strategy=_payload_str(payload.get("strategy"), "momentum_atr", "strategy"),
            start_date=_payload_str(payload.get("start_date", ""), "", "start_date"),
            end_date=_payload_str(payload.get("end_date", ""), "", "end_date"),
            max_symbols=_payload_int(payload.get("max_symbols"), 20, "max_symbols"),
            max_workers=_payload_int(payload.get("max_workers"), 10, "max_workers"),
            universe=payload.get("universe") or None,
            custom_symbols=payload.get("symbols") or None,
            initial_cash=_payload_float(payload.get("initial_cash"), 100000, "initial_cash"),
            fee_rate=_payload_float(payload.get("fee_rate"), 0.0003, "fee_rate"),
            slippage_rate=_payload_float(payload.get("slippage_rate"), 0.0005, "slippage_rate"),
            min_commission=_payload_float(payload.get("min_commission"), 5.0, "min_commission"),
            stamp_duty_rate=_payload_float(payload.get("stamp_duty_rate"), 0.0005, "stamp_duty_rate"),
            transfer_fee_rate=_payload_float(payload.get("transfer_fee_rate"), 0.00001, "transfer_fee_rate"),
            lot_size=_payload_int(payload.get("lot_size"), 100, "lot_size"),
            max_pending_bars=_payload_int(
                payload.get("max_pending_bars"), 5, "max_pending_bars"
            ),
            price_limit_pct=_optional_payload_float(payload, "price_limit_pct"),
            persist=_coerce_bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
            limit=_payload_int(payload.get("limit"), 100, "limit"),
            max_pages=_payload_int(payload.get("max_pages"), 10, "max_pages"),
            universe_limit=_payload_int(payload.get("universe_limit"), 100, "universe_limit"),
            universe_pages=_payload_int(payload.get("universe_pages"), 5, "universe_pages"),
            strategy_params=_strategy_params(payload),
        )
        result = run_batch_backtest(req)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_analyze(self, payload: Dict[str, Any]) -> None:
        result = analyze(payload)
        json_response(
            self,
            {"success": True, "analysis": result},
            cors_origin=get_settings().cors_origin,
        )

    def _handle_optimize(self, payload: Dict[str, Any]) -> None:
        result = run_grid_search_from_payload(payload)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_strategies(self) -> None:
        """返回所有可用策略的元数据。"""
        items = [
            {
                "name": s.name,
                "display_name": s.display_name,
                "default_params": s.default_params,
                "default_grid": s.default_grid,
            }
            for s in SPECS.values()
        ]
        json_response(
            self,
            {"success": True, "strategies": items},
            cors_origin=get_settings().cors_origin,
        )

    def _handle_bars(self, payload: Dict[str, Any]) -> None:
        """拉近一年日 K + 元信息。Dashboard 弹窗专用。"""
        query_text = _payload_str(payload.get("query", ""), "", "query")
        max_pages = _payload_int(payload.get("max_pages"), 3, "max_pages")
        limit = _payload_int(payload.get("limit"), 100, "limit")
        api_key = payload.get("api_key") or None
        data = fetch_bars(query_text, api_key=api_key, max_pages=max_pages, limit=limit)
        json_response(
            self,
            {"success": True, **data},
            cors_origin=get_settings().cors_origin,
        )

    # --- I/O ---

    def _read_json(self) -> Dict[str, Any]:
        settings = get_settings()
        if self.headers.get("Transfer-Encoding"):
            raise ValidationError("不支持 Transfer-Encoding，请使用 Content-Length")
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type and content_type != "application/json":
            raise ValidationError("请求 Content-Type 必须为 application/json")
        raw_length = self.headers.get("Content-Length") or "0"
        try:
            length = int(raw_length)
        except (TypeError, ValueError) as exc:
            raise ValidationError("Content-Length 不是合法整数") from exc
        max_bytes = settings.max_body_bytes
        if length > max_bytes:
            raise _PayloadTooLarge()
        if length < 0:
            raise ValidationError("Content-Length 不能为负数")
        try:
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        except UnicodeDecodeError as exc:
            raise ValidationError("请求体必须是 UTF-8 编码") from exc
        try:
            data = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            from quant.errors import ValidationError
            raise ValidationError("请求体不是合法 JSON", details={"reason": str(exc)})
        if not isinstance(data, dict):
            from quant.errors import ValidationError
            raise ValidationError("请求体必须是 JSON 对象")
        return data


class _PayloadTooLarge(Exception):
    pass


# --- 工具 ---


def _normalize_request_credentials(
    payload: Dict[str, Any], settings: Any, headers: Any
) -> Dict[str, Any]:
    """分离站点访问密钥与问财上游密钥。

    新协议使用 ``access_key`` / HTTP 头做站点鉴权，使用
    ``iwencai_api_key`` 传访客问财密钥。未启用站点鉴权时，继续
    接受旧字段 ``api_key``。
    """
    normalized = dict(payload)
    explicit_upstream = normalized.get("iwencai_api_key")
    auth_enabled = bool(settings.api_key or settings.api_key_hash)
    has_separate_access_key = bool(
        normalized.get("access_key")
        or headers.get("X-API-Key")
        or headers.get("Authorization")
    )
    if explicit_upstream:
        normalized["api_key"] = explicit_upstream
    elif auth_enabled and not has_separate_access_key:
        # 此时 api_key 是为了兼容旧站点鉴权，绝不能透传给问财。
        normalized.pop("api_key", None)
    return normalized


def _optional_payload_float(payload: Dict[str, Any], field_name: str) -> Optional[float]:
    raw = payload.get(field_name)
    if raw is None or raw == "" or (isinstance(raw, str) and not raw.strip()):
        return None
    return _payload_float(raw, 0.0, field_name)


def _coerce_strategy_value(key: str, default: Any, raw: Any) -> Any:
    """依据 default 类型把 raw 强制转换为 int / float / 其它。

    - bool 必须先于 int 判断（Python 里 bool 是 int 的子类）。
    - 转换失败抛 ValidationError，让客户端立刻知道哪个字段错。
    """
    from quant.errors import ValidationError

    if raw is None or raw == "":
        return default  # 由调用方在外层跳过空值

    if isinstance(default, bool):
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        if isinstance(raw, str):
            return raw.strip().lower() in ("1", "true", "yes", "on")
        return bool(raw)
    if isinstance(default, int):
        if isinstance(raw, bool):
            # True/False 不想被解释为 1/0
            raise ValidationError(
                f"参数 {key} 应当为整数", details={"got": raw, "type": type(raw).__name__}
            )
        if isinstance(raw, int):
            return raw
        if isinstance(raw, float):
            if not raw.is_integer():
                raise ValidationError(
                    f"参数 {key} 应当为整数", details={"got": raw, "type": "float"}
                )
            return int(raw)
        if isinstance(raw, str):
            try:
                return int(raw.strip())
            except ValueError as exc:
                raise ValidationError(
                    f"参数 {key} 不是合法整数: {raw!r}", details={"got": raw}
                ) from exc
        raise ValidationError(
            f"参数 {key} 类型不支持", details={"got": raw, "type": type(raw).__name__}
        )
    if isinstance(default, float):
        if isinstance(raw, bool):
            return float(int(raw))
        if isinstance(raw, (int, float)):
            return float(raw)
        if isinstance(raw, str):
            try:
                return float(raw.strip())
            except ValueError as exc:
                raise ValidationError(
                    f"参数 {key} 不是合法数字: {raw!r}", details={"got": raw}
                ) from exc
        raise ValidationError(
            f"参数 {key} 类型不支持", details={"got": raw, "type": type(raw).__name__}
        )
    return raw


def _strategy_params(payload: Dict[str, Any]) -> Dict[str, Any]:
    """从 payload 中挑出当前策略接受的参数，按 SPECS 默认值类型强制转换。

    - 键白名单与类型模板都来自 SPECS[name].default_params，避免重复维护。
    - 缺字段或空值会被跳过，回退到 SPECS 默认。
    - 类型不匹配直接抛 ValidationError（400），不再 500。
    """
    name = str(payload.get("strategy") or "momentum_atr")
    spec = SPECS.get(name)
    if spec is None:
        return {}  # 让后续路由层处理未知策略
    nested = payload.get("strategy_params") or {}
    if not isinstance(nested, dict):
        raise ValidationError(
            "strategy_params 必须是 JSON 对象",
            details={"field": "strategy_params"},
        )
    result: Dict[str, Any] = {}
    for key, default in spec.default_params.items():
        if key in nested:
            raw = nested[key]
        elif key in payload:  # 兼容旧前端的扁平字段
            raw = payload[key]
        else:
            continue
        if raw is None or raw == "":
            continue
        result[key] = _coerce_strategy_value(key, default, raw)
    return result


# --- 启动入口 ---


class BacktestHTTPServer(ThreadingHTTPServer):
    """可快速重启、关机时不等待长请求线程的 HTTP 服务器。"""

    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


def run_server(host: Optional[str] = None, port: Optional[int] = None) -> None:
    """启动 HTTP 服务（阻塞）。"""
    settings = get_settings()
    setup_logging(settings.log_level)
    init_persistence()
    BacktestHandler.limiter = _build_limiter()
    host = settings.host if host is None else host
    port = settings.port if port is None else port
    server = BacktestHTTPServer((host, port), BacktestHandler)
    _LOG.info("服务已启动: http://%s:%s (%s)", host, port, settings.safe_summary())
    print(f"A股量化回测平台已启动: http://{host}:{port}")
    print("使用 Ctrl+C 停止服务。")
    print(f"配置: {settings.safe_summary()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _LOG.info("收到 Ctrl+C，正在关闭...")
    finally:
        server.server_close()


__all__ = ["BacktestHandler", "BacktestHTTPServer", "run_server"]
