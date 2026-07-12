"""payload 强转 helper —— 把 HTTP body 里手动 float()/int() 的脆弱写法集中起来。

历史问题：
- ``int(float(payload.get('x') or 10))`` 在收到非数字（"abc" / "1.2"）时会抛
  ``ValueError`` / ``TypeError``，被 ``do_POST`` 的兜底 except 转成 500。
- 用户期望是 "参数错 → 400"，不是 "服务器内部错误"。

这里给两个 helper，统一抛 ``ValidationError``（400），让上层 ``dispatch``
照常转 JSON 响应。
"""

from __future__ import annotations

from typing import Any

from quant.errors import ValidationError


def _coerce_bool(raw: Any) -> bool:
    """把用户输入转成 bool：原 bool / 数字非零 / 字符串 1/true/yes/on。"""
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("1", "true", "yes", "on"):
            return True
        if s in ("0", "false", "no", "off", ""):
            return False
    # 其它（含 None / list / dict）一律视为 false，跟 JS FormData 习惯保持一致
    return bool(raw)


def _payload_float(
    value: Any,
    default: float,
    field_name: str,
    *,
    allow_none: bool = False,
) -> float:
    """强转 float。空 / None 走 default；非法字符串抛 ValidationError(400)。

    bool 不被解释成 0/1 —— 这是常见的安全坑（"false" 不应该被当作 0.0）。
    """
    if value is None or value == "" or (isinstance(value, str) and value.strip() == ""):
        return default
    if allow_none and value is None:
        return default  # type: ignore[unreachable]
    if isinstance(value, bool):
        raise ValidationError(
            f"参数 {field_name} 应当为数字",
            details={"got": value, "type": "bool"},
        )
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        try:
            return float(s)
        except ValueError as exc:
            raise ValidationError(
                f"参数 {field_name} 不是合法数字: {value!r}",
                details={"field": field_name, "got": value},
            ) from exc
    raise ValidationError(
        f"参数 {field_name} 类型不支持",
        details={"field": field_name, "got": value, "type": type(value).__name__},
    )


def _payload_int(
    value: Any,
    default: int,
    field_name: str,
    *,
    allow_none: bool = False,
) -> int:
    """强转 int。空 / None 走 default；非法字符串 / 浮点小数抛 ValidationError(400)。"""
    if value is None or value == "" or (isinstance(value, str) and value.strip() == ""):
        return default
    if allow_none and value is None:
        return default  # type: ignore[unreachable]
    if isinstance(value, bool):
        raise ValidationError(
            f"参数 {field_name} 应当为整数",
            details={"got": value, "type": "bool"},
        )
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not float(value).is_integer():
            raise ValidationError(
                f"参数 {field_name} 应当为整数（不能是小数）",
                details={"field": field_name, "got": value},
            )
        return int(value)
    if isinstance(value, str):
        s = value.strip()
        try:
            return int(s)
        except ValueError:
            # 试 float 路径（避免 "1.0" 这类合法整数表达被拒）
            try:
                f = float(s)
            except ValueError as exc:
                raise ValidationError(
                    f"参数 {field_name} 不是合法整数: {value!r}",
                    details={"field": field_name, "got": value},
                ) from exc
            if not f.is_integer():
                raise ValidationError(
                    f"参数 {field_name} 应当为整数（不能是小数）",
                    details={"field": field_name, "got": value},
                )
            return int(f)
    raise ValidationError(
        f"参数 {field_name} 类型不支持",
        details={"field": field_name, "got": value, "type": type(value).__name__},
    )


def _payload_str(
    value: Any,
    default: str,
    field_name: str,
    *,
    strip: bool = True,
) -> str:
    """统一 str 强转（默认 strip）。空走 default；非字符串包成 str。"""
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip() if strip else value
    if isinstance(value, (int, float, bool)):
        return str(value).strip() if strip else str(value)
    raise ValidationError(
        f"参数 {field_name} 类型不支持",
        details={"field": field_name, "got": value, "type": type(value).__name__},
    )


__all__ = ["_payload_float", "_payload_int", "_payload_str", "_coerce_bool"]
