"""HTTP 入口：BacktestHandler。

- 路由分发到 service 层
- 统一错误处理：AppError 转 JSON；其他异常只暴露安全 message
- CORS / OPTIONS
"""

from __future__ import annotations

import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional

from quant.config import get_settings
from quant.data.iwencai import IwencaiError
from quant.errors import AppError, AuthError, RateLimitError, ValidationError
from quant.logging_setup import access_log, get_logger, setup_logging
from quant.persistence import init_persistence
from quant.server.middleware import RateLimiter, check_auth, get_client_key
from quant.server.responses import cors_preflight, json_response
from quant.services import (
    analyze,
    natural_language_query,
    run_batch_backtest,
    run_grid_search,
    run_single_backtest,
)
from quant.services.backtest import BacktestRequest
from quant.services.batch import BatchRequest
from quant.services.optimize import OptimizeRequest
from quant.services.query import QueryRequest
from quant.data.iwencai import IwencaiError  # noqa: F811
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

    # --- HTTP 方法 ---

    def do_GET(self) -> None:  # noqa: N802
        # API 路由：仅 /api/strategies 支持 GET，其余 GET 走静态资源
        if self.path == "/api/strategies":
            try:
                settings = get_settings()
                self._dispatch({}, settings)
            except AppError as exc:
                return json_response(
                    self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
                )
            return
        if self.path in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        cors_preflight(self, get_settings().cors_origin)

    def do_POST(self) -> None:  # noqa: N802
        start = time.time()
        status_holder: Dict[str, int] = {"status": 500}
        try:
            settings = get_settings()
            client_key = get_client_key(self)
            if self.limiter is not None:
                self.limiter.check(client_key)

            try:
                payload = self._read_json()
            except _PayloadTooLarge:
                status_holder["status"] = 413
                return json_response(
                    self,
                    {"success": False, "code": "payload_too_large", "error": "请求体过大"},
                    status=413,
                    cors_origin=settings.cors_origin,
                )

            try:
                check_auth(payload, settings)
            except AuthError as exc:
                status_holder["status"] = exc.status
                return json_response(
                    self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
                )

            try:
                self._dispatch(payload, settings)
                status_holder["status"] = 200
            except RateLimitError as exc:
                status_holder["status"] = exc.status
                return json_response(
                    self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
                )
            except AppError as exc:
                status_holder["status"] = exc.status
                _LOG.warning("业务错误 %s %s: %s", self.command, self.path, exc.message)
                return json_response(
                    self, exc.to_response(), status=exc.status, cors_origin=settings.cors_origin
                )
            except IwencaiError as exc:
                status_holder["status"] = 502
                return json_response(
                    self,
                    {
                        "success": False,
                        "code": "upstream_error",
                        "error": "上游接口返回错误",
                    },
                    status=502,
                    cors_origin=settings.cors_origin,
                )
            except Exception as exc:  # noqa: BLE001
                _LOG.exception("未处理异常 %s %s", self.command, self.path)
                return json_response(
                    self,
                    {
                        "success": False,
                        "code": "internal_error",
                        "error": "服务器内部错误",
                    },
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
        elif path == "/api/strategies":
            self._handle_strategies()
        else:
            from quant.errors import NotFoundError
            raise NotFoundError(f"未知接口: {path}")

    def _handle_query(self, payload: Dict[str, Any]) -> None:
        req = QueryRequest(
            query=str(payload.get("query", "")).strip(),
            page=int(payload.get("page") or 1),
            limit=int(payload.get("limit") or 50),
            parser_logic=bool(payload.get("parser_logic", False)),
            persist=bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
        )
        result = natural_language_query(req)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_backtest(self, payload: Dict[str, Any]) -> None:
        req = BacktestRequest(
            strategy=str(payload.get("strategy") or "momentum_atr"),
            backtest_mode=str(payload.get("backtest_mode") or "single"),
            symbol=str(payload.get("symbol", "")).strip(),
            index_symbol=str(payload.get("index_symbol") or "hs300"),
            start_date=str(payload.get("start_date", "")).strip(),
            end_date=str(payload.get("end_date", "")).strip(),
            query=str(payload.get("query", "")).strip(),
            initial_cash=float(payload.get("initial_cash") or 100000),
            fee_rate=float(payload.get("fee_rate") or 0.0003),
            persist=bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
            limit=int(payload.get("limit") or 100),
            max_pages=int(payload.get("max_pages") or 10),
            strategy_params=_strategy_params(payload),
        )
        result = run_single_backtest(req)
        json_response(self, result, cors_origin=get_settings().cors_origin)

    def _handle_batch_backtest(self, payload: Dict[str, Any]) -> None:
        req = BatchRequest(
            strategy=str(payload.get("strategy") or "momentum_atr"),
            start_date=str(payload.get("start_date", "")).strip(),
            end_date=str(payload.get("end_date", "")).strip(),
            max_symbols=int(payload.get("max_symbols") or 20),
            max_workers=int(payload.get("max_workers") or 10),
            universe=payload.get("universe") or None,
            custom_symbols=payload.get("symbols") or None,
            initial_cash=float(payload.get("initial_cash") or 100000),
            fee_rate=float(payload.get("fee_rate") or 0.0003),
            persist=bool(payload.get("persist", False)),
            api_key=payload.get("api_key") or None,
            limit=int(payload.get("limit") or 100),
            max_pages=int(payload.get("max_pages") or 10),
            universe_limit=int(payload.get("universe_limit") or 100),
            universe_pages=int(payload.get("universe_pages") or 5),
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
        # 寻优需要先获取 bars，所以单独处理
        from quant.data.iwencai import fetch_all as _fetch_all
        from quant.data.normalization import build_history_query, normalize_bars
        from quant.errors import UpstreamError, ValidationError
        from quant.services.backtest import INDEX_SYMBOLS

        req = OptimizeRequest(
            strategy=str(payload.get("strategy") or "momentum_atr"),
            param_ranges=payload.get("param_ranges") or {},
            start_date=str(payload.get("start_date", "")).strip(),
            end_date=str(payload.get("end_date", "")).strip(),
            query=str(payload.get("query", "")).strip(),
            initial_cash=float(payload.get("initial_cash") or 100000),
            fee_rate=float(payload.get("fee_rate") or 0.0003),
        )
        symbol = str(payload.get("symbol", "")).strip()
        mode = str(payload.get("backtest_mode") or "single")
        if mode == "index":
            symbol = INDEX_SYMBOLS.get(str(payload.get("index_symbol") or "hs300"), symbol)
        query_text = req.query
        if not query_text:
            if not symbol or not req.start_date or not req.end_date:
                raise ValidationError("请填写股票代码/名称、开始日期和结束日期，或直接填写数据查询语句")
            query_text = build_history_query(symbol, req.start_date, req.end_date)

        try:
            response = _fetch_all(
                query_text,
                api_key=payload.get("api_key") or None,
                limit=int(payload.get("limit") or 100),
                max_pages=int(payload.get("max_pages") or 10),
            )
        except IwencaiError as exc:
            raise UpstreamError(exc.message, details={"status_code": exc.status_code}) from exc
        bars = normalize_bars(response.get("datas", []))
        result = run_grid_search(req, bars)
        result["success"] = True
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

    # --- I/O ---

    def _read_json(self) -> Dict[str, Any]:
        from quant.config import get_settings
        max_bytes = 1 * 1024 * 1024  # 1MB
        length = int(self.headers.get("Content-Length") or 0)
        if length > max_bytes:
            raise _PayloadTooLarge()
        if length < 0:
            length = 0
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
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


_STRATEGY_PARAM_KEYS = {
    "moving_average": {"fast_window", "slow_window"},
    "momentum_atr": {"breakout_window", "trend_window", "atr_window", "atr_multiplier", "risk_per_trade"},
    "ma_rsi": {"fast_window", "slow_window", "rsi_window", "buy_rsi", "sell_rsi"},
    "channel_reversal": {"channel_window", "stop_loss_pct"},
    "volume_shadow_break": {
        "volume_window",
        "volume_multiplier",
        "sell_volume_multiplier",
        "upper_shadow_ratio",
        "lower_shadow_ratio",
        "ma_window",
    },
}


def _strategy_params(payload: Dict[str, Any]) -> Dict[str, Any]:
    """只挑出当前策略接受的参数，避免污染策略构造。"""
    name = str(payload.get("strategy") or "momentum_atr")
    allowed = _STRATEGY_PARAM_KEYS.get(name, set())
    result: Dict[str, Any] = {}
    for key in allowed:
        if key in payload and payload[key] not in (None, ""):
            result[key] = payload[key]
    return result


# --- 启动入口 ---


def run_server(host: Optional[str] = None, port: Optional[int] = None) -> None:
    """启动 HTTP 服务（阻塞）。"""
    settings = get_settings()
    setup_logging(settings.log_level)
    init_persistence()
    BacktestHandler.limiter = _build_limiter()
    host = host or settings.host
    port = port or settings.port
    server = ThreadingHTTPServer((host, port), BacktestHandler)
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


__all__ = ["BacktestHandler", "run_server"]
