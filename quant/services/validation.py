"""跨 service 的请求校验，避免单标的、批量和寻优入口行为漂移。"""

from __future__ import annotations

import math
from datetime import date
from typing import Any, Iterable, Optional

from quant.errors import ValidationError


MAX_QUERY_CHARS = 4000
MAX_SYMBOL_CHARS = 128


def validate_financial_inputs(initial_cash: float, fee_rate: float) -> None:
    if not math.isfinite(initial_cash) or initial_cash <= 0:
        raise ValidationError(
            "initial_cash 必须是大于 0 的有限数值",
            details={"field": "initial_cash"},
        )
    if not math.isfinite(fee_rate) or not 0 <= fee_rate < 1:
        raise ValidationError(
            "fee_rate 必须在 [0, 1) 之间",
            details={"field": "fee_rate"},
        )


def validate_execution_inputs(
    *,
    slippage_rate: float,
    min_commission: float,
    stamp_duty_rate: float,
    transfer_fee_rate: float,
    lot_size: int,
    max_pending_bars: int,
    price_limit_pct: Optional[float],
) -> None:
    """校验服务级撮合参数，将底层 ValueError 转为稳定的 HTTP 400。"""
    rates = {
        "slippage_rate": slippage_rate,
        "stamp_duty_rate": stamp_duty_rate,
        "transfer_fee_rate": transfer_fee_rate,
    }
    for field, value in rates.items():
        if not math.isfinite(value) or not 0 <= value < 1:
            raise ValidationError(
                f"{field} 必须在 [0, 1) 之间",
                details={"field": field},
            )
    if not math.isfinite(min_commission) or min_commission < 0:
        raise ValidationError(
            "min_commission 必须是非负有限数",
            details={"field": "min_commission"},
        )
    if lot_size < 1:
        raise ValidationError("lot_size 必须大于 0", details={"field": "lot_size"})
    if max_pending_bars < 1 or max_pending_bars > 100:
        raise ValidationError(
            "max_pending_bars 必须在 1-100 之间",
            details={"field": "max_pending_bars"},
        )
    if price_limit_pct is not None and not 0 < price_limit_pct < 1:
        raise ValidationError(
            "price_limit_pct 必须在 (0, 1) 之间",
            details={"field": "price_limit_pct"},
        )


def validate_date_range(start_date: str, end_date: str, *, required: bool = False) -> None:
    if not start_date and not end_date and not required:
        return
    if not start_date or not end_date:
        raise ValidationError(
            "开始日期和结束日期必须同时提供",
            details={"field": "start_date/end_date"},
        )
    start = _iso_date(start_date, "start_date")
    end = _iso_date(end_date, "end_date")
    if start > end:
        raise ValidationError(
            "开始日期不能晚于结束日期",
            details={"field": "start_date/end_date"},
        )


def validate_query_text(query_text: str, *, required: bool = False) -> str:
    value = (query_text or "").strip()
    if required and not value:
        raise ValidationError("查询语句不能为空", details={"field": "query"})
    if len(value) > MAX_QUERY_CHARS:
        raise ValidationError(
            f"查询语句不能超过 {MAX_QUERY_CHARS} 个字符",
            details={"field": "query", "max_length": MAX_QUERY_CHARS},
        )
    return value


def validate_symbol(symbol: Optional[str]) -> str:
    value = (symbol or "").strip()
    if len(value) > MAX_SYMBOL_CHARS:
        raise ValidationError(
            f"证券代码/名称不能超过 {MAX_SYMBOL_CHARS} 个字符",
            details={"field": "symbol", "max_length": MAX_SYMBOL_CHARS},
        )
    return value


def validate_paging(limit: int, max_pages: int) -> None:
    if not 1 <= limit <= 100:
        raise ValidationError(
            "limit 必须在 1-100 之间",
            details={"field": "limit", "got": limit},
        )
    if not 1 <= max_pages <= 20:
        raise ValidationError(
            "max_pages 必须在 1-20 之间",
            details={"field": "max_pages", "got": max_pages},
        )


def validate_single_series(bars: Iterable[Any]) -> None:
    """防止把多只证券的 K 线拼成一条价格序列回测。"""
    codes = {
        str(getattr(bar, "code", "") or "").strip()
        for bar in bars
        if str(getattr(bar, "code", "") or "").strip()
    }
    if len(codes) > 1:
        raise ValidationError(
            "查询返回了多个证券，单标的回测只能包含一只证券",
            details={"field": "query", "symbols": sorted(codes)[:10]},
        )
def _iso_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(
            f"参数 {field} 必须是 YYYY-MM-DD 格式的有效日期",
            details={"field": field, "got": value},
        ) from exc


__all__ = [
    "validate_date_range",
    "validate_execution_inputs",
    "validate_financial_inputs",
    "validate_paging",
    "validate_query_text",
    "validate_single_series",
    "validate_symbol",
]
