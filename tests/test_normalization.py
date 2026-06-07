"""数据规范化层测试。"""

from __future__ import annotations

import pytest

from quant.data.normalization import (
    Bar,
    build_history_query,
    infer_asset_type,
    infer_snapshot_date,
    normalize_bar_for_persist,
    normalize_bars,
    normalize_date,
    pick_float,
    pick_text,
    to_float,
)


class TestToFloat:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            (None, None),
            ("", None),
            ("--", None),
            ("-", None),
            ("1.5", 1.5),
            ("1,234.5", 1234.5),
            ("1.2万", 12000.0),
            ("1.2亿", 1.2e8),
            ("15%", 15.0),  # % 符号仅剥离，不除 100
            (0, 0.0),
            (10, 10.0),
            (True, 1.0),
            (False, 0.0),
        ],
    )
    def test_valid(self, raw, expected):
        result = to_float(raw)
        if expected is None:
            assert result is None
        else:
            assert result == pytest.approx(expected)

    def test_invalid_string(self):
        assert to_float("not a number") is None

    def test_nan(self):
        assert to_float(float("nan")) is None
        assert to_float(float("inf")) is None


class TestPickText:
    def test_exact_match(self):
        row = {"股票代码": "300033.SZ", "北向代码": "12345"}
        assert pick_text(row, ("代码",), ("股票代码", "证券代码")) == "300033.SZ"

    def test_fuzzy_fallback(self):
        row = {"股票代码": "300033.SZ"}
        assert pick_text(row, ("not_exist",), ("股票代码",)) == "300033.SZ"

    def test_empty_value_skipped(self):
        row = {"股票代码": "", "北向代码": "12345"}
        # 精确匹配空字符串被跳过，fuzzy 也跳过空值
        assert pick_text(row, ("股票代码", "代码"), ("股票代码",)) == ""

    def test_no_match(self):
        assert pick_text({"foo": "bar"}, ("baz",), ("qux",)) == ""

    def test_fuzzy_no_false_match_substring(self):
        """修复历史 bug：fuzzy 不再用 `in` 子串匹配，避免误命中"北向代码"等。"""
        row = {"北向代码": "99999", "股票代码": "300033"}
        # 旧实现下 fuzzy 用 "代码" 子串会匹配到 "北向代码" → 错误
        # 新实现 fuzzy 用 "股票代码" 精确匹配 → 正确返回 300033
        assert pick_text(row, ("代码",), ("股票代码", "证券代码")) == "300033"


class TestPickFloat:
    def test_exact_match(self):
        row = {"收盘价": 10.5, "close": 9.0}
        assert pick_float(row, ("close", "收盘价")) == 9.0

    def test_fuzzy_fallback(self):
        row = {"最新价": 12.3}
        assert pick_float(row, ("xxx",), ("最新价",)) == 12.3

    def test_no_match(self):
        assert pick_float({"foo": "bar"}, ("baz",)) is None


class TestNormalizeDate:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("2024-01-05", "2024-01-05"),
            ("2024/01/05", "2024-01-05"),
            ("20240105", "2024-01-05"),
            ("2024-01-05 00:00:00", "2024-01-05"),
            ("", ""),
        ],
    )
    def test_valid(self, raw, expected):
        assert normalize_date(raw) == expected


class TestNormalizeBars:
    def test_long_format(self):
        rows = [
            {
                "交易日期": "2024-01-02",
                "开盘价": 100,
                "最高价": 105,
                "最低价": 99,
                "收盘价": 104,
                "成交量": 1000,
            }
        ]
        bars = normalize_bars(rows)
        assert len(bars) == 1
        assert bars[0].close == 104
        assert bars[0].open == 100
        assert bars[0].date == "2024-01-02"

    def test_wide_format(self):
        rows = [
            {
                "股票代码": "300033.SZ",
                "开盘价[20240102]": 100,
                "最高价[20240102]": 105,
                "最低价[20240102]": 99,
                "收盘价[20240102]": 104,
                "成交量[20240102]": 1000,
            }
        ]
        bars = normalize_bars(rows)
        assert len(bars) == 1
        assert bars[0].code == "300033.SZ"
        assert bars[0].close == 104
        assert bars[0].date == "2024-01-02"

    def test_dedup_by_code_date(self):
        rows = [
            {"股票代码": "300033", "交易日期": "2024-01-02", "收盘价": 100},
            {"股票代码": "300033", "交易日期": "2024-01-02", "收盘价": 105},  # 重复
            {"股票代码": "300033", "交易日期": "2024-01-03", "收盘价": 107},
        ]
        bars = normalize_bars(rows)
        assert len(bars) == 2
        # 后出现的覆盖前面的
        assert bars[0].close == 105

    def test_skip_invalid(self):
        rows = [
            {"foo": "bar"},  # 无日期
            {"交易日期": "2024-01-02"},  # 无收盘价
            {"交易日期": "2024-01-03", "收盘价": 100},
        ]
        bars = normalize_bars(rows)
        assert len(bars) == 1
        assert bars[0].close == 100

    def test_sort(self):
        rows = [
            {"股票代码": "300033", "交易日期": "2024-01-05", "收盘价": 105},
            {"股票代码": "300033", "交易日期": "2024-01-02", "收盘价": 100},
        ]
        bars = normalize_bars(rows)
        assert bars[0].date == "2024-01-02"
        assert bars[1].date == "2024-01-05"


class TestBuildHistoryQuery:
    def test_stock(self):
        q = build_history_query("300033", "2024-01-01", "2024-12-31")
        assert "300033" in q
        assert "2024-01-01到2024-12-31" in q
        assert "指数" not in q

    def test_index(self):
        q = build_history_query("000300.SH", "2024-01-01", "2024-12-31")
        assert "000300.SH" in q
        assert "指数" in q


class TestInferAssetType:
    @pytest.mark.parametrize(
        "symbol,expected",
        [
            ("000300.SH", "index"),
            ("000905.SH", "index"),
            ("000852.SH", "index"),
            ("399001.SZ", "index"),  # 深证指数段
            ("300033.SZ", "stock"),
            ("600519.SH", "stock"),
            ("830799.BJ", "stock"),
            ("unknown", "unknown"),
        ],
    )
    def test(self, symbol, expected):
        assert infer_asset_type(symbol) == expected


class TestInferSnapshotDate:
    def test_with_date_in_key(self):
        row = {"收盘价[20240105]": 100, "成交量[20240105]": 1000}
        assert infer_snapshot_date(row) == "2024-01-05"

    def test_with_date_range_in_key(self):
        row = {"涨跌幅[20240105-20240112]": 0.05}
        assert infer_snapshot_date(row) == "2024-01-05"

    def test_no_date_returns_default(self):
        assert infer_snapshot_date({"foo": "bar"}) == "1970-01-01"


class TestNormalizeBarForPersist:
    def test_basic(self):
        bar = Bar(date="2024-01-02", close=10.0, code="300033.SZ", name="同花顺")
        result = normalize_bar_for_persist(bar)
        assert result["symbol"] == "300033.SZ"
        assert result["name"] == "同花顺"
        assert result["trade_date"] == "2024-01-02"
        assert result["close"] == 10.0

    def test_missing_code_raises(self):
        bar = Bar(date="2024-01-02", close=10.0)
        with pytest.raises(ValueError, match="缺少证券代码"):
            normalize_bar_for_persist(bar)
