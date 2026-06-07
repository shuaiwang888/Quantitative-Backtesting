"""把"因子分"当买入信号接入回测管线。

策略逻辑（简化版，便于演示 + 教学）：
- 预计算 alpha 在每根 bar 上的因子分 v[t]
- 把 v[t] 在最近 ``lookback`` 个值上做 z-score：z = (v - mean) / std
- z > ``buy_z`` 且无持仓 → 全仓买入
- z < ``sell_z`` 且有持仓 → 全仓卖出
- 不可计算（None）→ 不操作

参数：
- ``factor_name``: ``quant.factors.list_factors()`` 里的名字
- ``lookback``: z-score 回看窗口
- ``buy_z`` / ``sell_z``: z 阈值
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.factors import get_factor
from quant.indicators import precompute_ma
from quant.strategies.base import BaseStrategy, _round_or_none


def _zscore(vals: List[Optional[float]], lookback: int) -> List[Optional[float]]:
    """滚动 z-score：使用最近 lookback 个有效值的 mean/std。"""
    out: List[Optional[float]] = [None] * len(vals)
    window: List[float] = []
    for i, v in enumerate(vals):
        if v is not None and not (v != v):  # 过滤 NaN
            window.append(v)
        if len(window) > lookback:
            window.pop(0)
        if len(window) < max(5, lookback // 2):
            continue
        m = sum(window) / len(window)
        var = sum((x - m) ** 2 for x in window) / max(1, len(window) - 1)
        if var <= 0 or vals[i] is None:
            continue
        std = var ** 0.5
        out[i] = (vals[i] - m) / std if std > 0 else 0.0
    return out


class FactorStrategy(BaseStrategy):
    """单因子 z-score 阈值策略。"""

    name = "因子 z-score 阈值策略"

    def __init__(
        self,
        initial_cash: float,
        fee_rate: float,
        factor_name: str,
        lookback: int = 20,
        buy_z: float = 1.0,
        sell_z: float = -0.5,
    ) -> None:
        super().__init__(initial_cash, fee_rate)
        if lookback < 5:
            raise ValueError("lookback 至少 5")
        if buy_z <= sell_z:
            raise ValueError("buy_z 必须大于 sell_z")
        self.factor_name = factor_name
        self.lookback = lookback
        self.buy_z = buy_z
        self.sell_z = sell_z
        self.factor = get_factor(factor_name)
        # 预计算缓存
        self._factor_values: List[Optional[float]] = []
        self._zscores: List[Optional[float]] = []

    def get_strategy_name(self) -> str:
        return f"factor:{self.factor_name} (z {self.sell_z}/{self.buy_z})"

    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:  # noqa: ARG002
        return {
            "factor_value": _round_or_none(self._factor_values[index]),
            "factor_z": _round_or_none(self._zscores[index]),
        }

    def on_bar(self, bar: Bar, index: int) -> None:
        z = self._zscores[index]
        if z is None:
            return
        if self.shares == 0 and z > self.buy_z:
            shares = self.calc_buyable_shares(bar.close)
            if shares > 0:
                self.buy(bar, bar.close, shares)
        elif self.shares > 0 and z < self.sell_z:
            self.sell(bar, bar.close)

    # --- 预计算入口 ---

    def _prepare_factor(self, bars: List[Bar]) -> None:
        values = self.factor.compute(bars)
        self._factor_values = list(values)
        self._zscores = _zscore(self._factor_values, self.lookback)

    def _prepare_series(self, bars: List[Bar]) -> None:
        # 同步做因子预计算，让 run() / on_bar() 能用
        super()._prepare_series(bars)
        self._prepare_factor(bars)


def run_factor_strategy(
    bars: List[Bar],
    factor_name: str,
    initial_cash: float = 100000.0,
    fee_rate: float = 0.0003,
    lookback: int = 20,
    buy_z: float = 1.0,
    sell_z: float = -0.5,
) -> Dict[str, Any]:
    """便捷入口。"""
    s = FactorStrategy(
        initial_cash=initial_cash,
        fee_rate=fee_rate,
        factor_name=factor_name,
        lookback=lookback,
        buy_z=buy_z,
        sell_z=sell_z,
    )
    return s.run(bars)


__all__ = ["FactorStrategy", "run_factor_strategy"]
