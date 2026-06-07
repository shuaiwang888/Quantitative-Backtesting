"""数据规范化层：把问财返回的各种字段格式归一化为内部 Bar 格式。

设计原则：
- Bar 是不可变 dataclass，作为模块间传递的"标准货币"。
- normalize_bars 同时支持"长格式"（每行一根 K 线）和"宽格式"（一行含 `日期[YYYYMMDD]` 字段）。
- 字段选择使用精确匹配 + 可选 fuzzy 兜底，**fuzzy 必须用更长 token，避免误命中**。
- 数值解析支持"亿/万"中文单位、千分位逗号、百分号。
- 工具函数（pick_text / pick_float / to_float）集中在这里，其它模块直接 import。
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


# --- 字段名常量：精确匹配优先 ---

DATE_KEYS: Tuple[str, ...] = ("日期", "交易日期", "trade_date", "date", "时间")
CLOSE_KEYS: Tuple[str, ...] = ("收盘价", "close", "最新价", "现价")
OPEN_KEYS: Tuple[str, ...] = ("开盘价", "open", "开盘")
HIGH_KEYS: Tuple[str, ...] = ("最高价", "high", "最高")
LOW_KEYS: Tuple[str, ...] = ("最低价", "low", "最低")
VOLUME_KEYS: Tuple[str, ...] = ("成交量", "volume", "vol")
AMOUNT_KEYS: Tuple[str, ...] = ("成交额", "amount", "成交金额")
CODE_KEYS: Tuple[str, ...] = ("股票代码", "代码", "证券代码", "code")
NAME_KEYS: Tuple[str, ...] = ("股票简称", "股票名称", "名称", "name")

# fuzzy 兜底使用更长的 token 减少误命中
DATE_FUZZY: Tuple[str, ...] = ("交易日期",)
CLOSE_FUZZY: Tuple[str, ...] = ("收盘价",)
OPEN_FUZZY: Tuple[str, ...] = ("开盘价",)
HIGH_FUZZY: Tuple[str, ...] = ("最高价",)
LOW_FUZZY: Tuple[str, ...] = ("最低价",)
VOLUME_FUZZY: Tuple[str, ...] = ("成交量",)
CODE_FUZZY: Tuple[str, ...] = ("股票代码", "证券代码")
NAME_FUZZY: Tuple[str, ...] = ("股票简称", "股票名称")

# 宽格式：键名形如 `收盘价[20240506]`
_WIDE_FIELD_RE = re.compile(r"^(?P<field>.+?)\[(?P<date>\d{8})\]$")


@dataclass(frozen=True)
class Bar:
    """标准 K 线对象。不可变，确保跨层传递时不被意外修改。"""

    date: str
    close: float
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[float] = None
    amount: Optional[float] = None
    code: str = ""
    name: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# --- 字段提取工具 ---


def pick_text(
    row: Mapping[str, Any],
    exact_keys: Sequence[str],
    fuzzy: Sequence[str] = (),
) -> str:
    """从 dict 中按精确 key 取出第一个非空字符串；都没命中再按 fuzzy 兜底。

    fuzzy 使用 `==` 精确匹配（不降级为 `in`），避免被相似字段名误命中。
    """
    if not isinstance(row, Mapping):
        return ""
    for key in exact_keys:
        if key in row and row[key] not in (None, ""):
            return str(row[key]).strip()
    for key in fuzzy:
        if key in row and row[key] not in (None, ""):
            return str(row[key]).strip()
    return ""


def pick_float(
    row: Mapping[str, Any],
    exact_keys: Sequence[str],
    fuzzy: Sequence[str] = (),
) -> Optional[float]:
    """与 pick_text 对应的数值版本。"""
    if not isinstance(row, Mapping):
        return None
    for key in exact_keys:
        if key in row:
            value = to_float(row[key])
            if value is not None:
                return value
    for key in fuzzy:
        if key in row:
            value = to_float(row[key])
            if value is not None:
                return value
    return None


def to_float(value: Any) -> Optional[float]:
    """将任意值转为 float，支持千分位、百分号、中文亿/万单位。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip().replace(",", "").replace("%", "")
    if not text or text in ("--", "-", "None", "nan", "NaN"):
        return None
    multiplier = 1.0
    if text.endswith("亿"):
        multiplier = 1e8
        text = text[:-1]
    elif text.endswith("万"):
        multiplier = 1e4
        text = text[:-1]
    try:
        number = float(text) * multiplier
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def normalize_date(value: Any) -> str:
    """统一日期为 `YYYY-MM-DD`。无法解析时截取前 10 字符。"""
    if not value:
        return ""
    text = str(value).strip()
    for fmt, length in (("%Y-%m-%d", 10), ("%Y/%m/%d", 10), ("%Y%m%d", 8)):
        try:
            return datetime.strptime(text[:length], fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text[:10]


# --- K 线规范化主入口 ---


def normalize_bars(rows: Iterable[Any]) -> List[Bar]:
    """把问财返回的若干行 dict 归一化为 Bar 列表。

    同一 (code, date) 仅保留最后一次出现；按 (code, date) 升序返回。
    """
    raw = list(rows)
    bars: List[Bar] = []
    for row in raw:
        if not isinstance(row, Mapping):
            continue
        wide = _normalize_wide_row(row)
        if wide:
            bars.extend(wide)
            continue
        bar = _normalize_long_row(row)
        if bar is not None:
            bars.append(bar)

    deduped: Dict[Tuple[str, str], Bar] = {}
    for bar in bars:
        deduped[(bar.code or "", bar.date)] = bar
    return [deduped[key] for key in sorted(deduped.keys())]


def _normalize_long_row(row: Mapping[str, Any]) -> Optional[Bar]:
    date = normalize_date(pick_text(row, DATE_KEYS, DATE_FUZZY))
    close = pick_float(row, CLOSE_KEYS, CLOSE_FUZZY)
    if not date or close is None:
        return None
    return Bar(
        date=date,
        close=close,
        open=pick_float(row, OPEN_KEYS, OPEN_FUZZY),
        high=pick_float(row, HIGH_KEYS, HIGH_FUZZY),
        low=pick_float(row, LOW_KEYS, LOW_FUZZY),
        volume=pick_float(row, VOLUME_KEYS, VOLUME_FUZZY),
        code=pick_text(row, CODE_KEYS, CODE_FUZZY),
        name=pick_text(row, NAME_KEYS, NAME_FUZZY),
    )


def _normalize_wide_row(row: Mapping[str, Any]) -> List[Bar]:
    """处理问财宽格式：`{开盘价[20240102]: 10.5, 收盘价[20240102]: 10.8, ...}`。"""
    by_date: Dict[str, Dict[str, Any]] = {}
    code = pick_text(row, CODE_KEYS, CODE_FUZZY)
    name = pick_text(row, NAME_KEYS, NAME_FUZZY)
    for key, value in row.items():
        match = _WIDE_FIELD_RE.match(str(key))
        if not match:
            continue
        date = normalize_date(match.group("date"))
        bucket = by_date.setdefault(date, {})
        if "开盘" in match.group("field"):
            bucket["open"] = value
        elif "最高" in match.group("field"):
            bucket["high"] = value
        elif "最低" in match.group("field"):
            bucket["low"] = value
        elif "收盘" in match.group("field"):
            bucket["close"] = value
        elif "成交量" in match.group("field"):
            bucket["volume"] = value
        elif "成交额" in match.group("field"):
            bucket["amount"] = value

    bars: List[Bar] = []
    for date, fields in by_date.items():
        close = to_float(fields.get("close"))
        if close is None:
            continue
        bars.append(
            Bar(
                date=date,
                close=close,
                open=to_float(fields.get("open")),
                high=to_float(fields.get("high")),
                low=to_float(fields.get("low")),
                volume=to_float(fields.get("volume")),
                amount=to_float(fields.get("amount")),
                code=code,
                name=name,
            )
        )
    return bars


# --- 行情查询语句构造 ---


def build_history_query(symbol: str, start_date: str, end_date: str) -> str:
    """构造历史 K 线的问财查询语句。指数会带"指数"关键词以走指数行情通道。"""
    text = symbol.strip()
    if _looks_like_index_symbol(text):
        return (
            f"{text} 指数 {start_date}到{end_date} 每日行情 "
            "交易日期 开盘价 最高价 最低价 收盘价 成交量"
        )
    return (
        f"{text} {start_date}到{end_date} 每日行情 "
        "交易日期 开盘价 最高价 最低价 收盘价 成交量"
    )


def _looks_like_index_symbol(symbol: str) -> bool:
    """识别 6 位数字 + 交易所后缀的指数代码。

    - 沪深指数 000xxx / 000300 / 000905 / 000852
    - 深证指数 399xxx
    """
    if not re.match(r"^\d{6}\.(SH|SZ)$", symbol.upper()):
        return False
    upper = symbol.upper()
    return upper.startswith(("000300.", "000905.", "000852.", "399"))


# --- 资产类型推断 ---


def infer_asset_type(symbol: str) -> str:
    """根据代码推断资产类型。"""
    upper = symbol.upper()
    if upper.startswith(("000300.", "000905.", "000852.")):
        return "index"
    # 39x 系列是深证指数段
    if upper.startswith("399") and upper.endswith(".SZ"):
        return "index"
    if upper.endswith((".SH", ".SZ", ".BJ")):
        return "stock"
    return "unknown"


def infer_snapshot_date(row: Mapping[str, Any]) -> str:
    """从问财返回中提取快照日期，找不到时回退 1970-01-01。"""
    for key in row.keys():
        match = re.search(r"\[(\d{8})(?:-\d{8})?\]", str(key))
        if match:
            return normalize_date(match.group(1))
    return "1970-01-01"


def normalize_bar_for_persist(bar: Bar) -> Dict[str, Any]:
    """Bar -> 持久化层使用的 dict。强制要求有 symbol。"""
    symbol = (bar.code or "").strip()
    if not symbol:
        raise ValueError("K线缺少证券代码，无法持久化")
    return {
        "symbol": symbol,
        "name": bar.name or "",
        "trade_date": bar.date,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
        "amount": bar.amount,
        "raw": bar.to_dict(),
    }


__all__ = [
    "Bar",
    "DATE_KEYS",
    "CLOSE_KEYS",
    "OPEN_KEYS",
    "HIGH_KEYS",
    "LOW_KEYS",
    "VOLUME_KEYS",
    "AMOUNT_KEYS",
    "CODE_KEYS",
    "NAME_KEYS",
    "pick_text",
    "pick_float",
    "to_float",
    "normalize_date",
    "normalize_bars",
    "build_history_query",
    "infer_asset_type",
    "infer_snapshot_date",
    "normalize_bar_for_persist",
]
