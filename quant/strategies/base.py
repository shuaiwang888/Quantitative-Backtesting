"""回测基础：Bar、Trade、EquityPoint、BaseStrategy。

设计要点：
- 子类只关注 on_bar；buy/sell/equity 等公共逻辑在基类。
- 指标预计算在 run() 入口一次性完成，避免每个 bar 重复切片。
- run() 输出的 dict 保持与历史 API 兼容：summary/equity_curve/trades/bars 四个 key。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar
from quant.indicators import (
    precompute_atr,
    precompute_ma,
    precompute_rsi,
    precompute_rolling_high,
    precompute_rolling_low,
)


# --- 公共数据类 ---


@dataclass
class Trade:
    date: str
    side: str  # "buy" / "sell"
    shares: int
    price: float
    fee: float
    cash_after: float


@dataclass
class EquityPoint:
    date: str
    close: float
    position: int
    cash: float
    equity: float
    signal: str
    extras: Dict[str, Any] = field(default_factory=dict)


# --- 基类 ---


class BaseStrategy(ABC):
    """所有策略的抽象基类。子类必须实现 on_bar / get_strategy_name / get_extras。"""

    fee_rate: float = 0.0003

    def __init__(self, initial_cash: float, fee_rate: float = 0.0003) -> None:
        if initial_cash <= 0:
            raise ValueError("初始资金必须大于 0")
        self.initial_cash = float(initial_cash)
        self.fee_rate = float(fee_rate)
        self.cash = float(initial_cash)
        self.shares = 0
        self.trades: List[Trade] = []
        self.equity_curve: List[EquityPoint] = []
        self.current_signal = "hold"
        # 预计算缓存（每个 run() 重新填）
        self.closes: List[float] = []
        self.highs: List[float] = []
        self.lows: List[float] = []
        self.volumes: List[float] = []

    # --- 抽象方法 ---

    @abstractmethod
    def on_bar(self, bar: Bar, index: int) -> None:
        """子类的策略逻辑入口。"""
        raise NotImplementedError

    @abstractmethod
    def get_strategy_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def get_extras(self, bar: Bar, index: int) -> Dict[str, Any]:
        """返回该 bar 时刻附带的指标值，会被展开到 equity_curve。"""
        raise NotImplementedError

    # --- 公共方法 ---

    def buy(self, bar: Bar, price: float, shares: int) -> None:
        if shares <= 0:
            return
        cost = shares * price
        fee = cost * self.fee_rate
        self.cash -= cost + fee
        self.shares = shares
        self.trades.append(
            Trade(
                date=bar.date,
                side="buy",
                shares=shares,
                price=price,
                fee=fee,
                cash_after=round(self.cash, 2),
            )
        )
        self.current_signal = "buy"

    def sell(self, bar: Bar, price: float) -> None:
        if self.shares <= 0:
            return
        sold_shares = self.shares
        proceeds = self.shares * price
        fee = proceeds * self.fee_rate
        self.cash += proceeds - fee
        self.shares = 0
        self.trades.append(
            Trade(
                date=bar.date,
                side="sell",
                shares=sold_shares,
                price=price,
                fee=fee,
                cash_after=round(self.cash, 2),
            )
        )
        self.current_signal = "sell"

    def equity(self, bar: Bar) -> float:
        return self.cash + self.shares * bar.close

    def calc_buyable_shares(self, price: float) -> int:
        """按 A 股 100 股整手、扣除手续费计算可买股数。"""
        if price <= 0:
            return 0
        return int(self.cash / (price * (1 + self.fee_rate)) / 100) * 100

    # --- 预计算辅助 ---

    def _prepare_series(self, bars: List[Bar]) -> None:
        self.closes = [b.close for b in bars]
        self.highs = [b.high if b.high is not None else b.close for b in bars]
        self.lows = [b.low if b.low is not None else b.close for b in bars]
        self.volumes = [b.volume if b.volume is not None else 0.0 for b in bars]

    # --- 主入口 ---

    def run(self, bars: List[Bar]) -> Dict[str, Any]:
        if not bars:
            raise ValueError("没有获取到可用于回测的K线数据")
        self._prepare_series(bars)
        # 重置状态（同一 strategy 实例支持多次 run，但 trades/equity_curve 重新累计）
        self.cash = float(self.initial_cash)
        self.shares = 0
        self.trades = []
        self.equity_curve = []

        for i, bar in enumerate(bars):
            self.current_signal = "hold"
            self.on_bar(bar, i)
            equity = self.equity(bar)
            self.equity_curve.append(
                EquityPoint(
                    date=bar.date,
                    close=round(bar.close, 4),
                    position=self.shares,
                    cash=round(self.cash, 2),
                    equity=round(equity, 2),
                    signal=self.current_signal,
                    extras=self.get_extras(bar, i),
                )
            )
        return self.build_result(bars)

    # --- 结果汇总 ---

    def build_result(self, bars: List[Bar]) -> Dict[str, Any]:
        final_equity = self.equity_curve[-1].equity
        total_return = final_equity / self.initial_cash - 1
        benchmark_return = bars[-1].close / bars[0].close - 1
        max_dd = _max_drawdown([pt.equity for pt in self.equity_curve])
        wins, closed = _trade_win_stats(self.trades)
        return {
            "summary": {
                "strategy": self.get_strategy_name(),
                "initial_cash": round(self.initial_cash, 2),
                "final_equity": round(final_equity, 2),
                "total_return": round(total_return, 6),
                "benchmark_return": round(benchmark_return, 6),
                "excess_return": round(total_return - benchmark_return, 6),
                "max_drawdown": round(max_dd, 6),
                "trade_count": len(self.trades),
                "closed_trades": closed,
                "win_rate": round(wins / closed, 6) if closed else None,
                "start_date": bars[0].date,
                "end_date": bars[-1].date,
                "bar_count": len(bars),
            },
            "equity_curve": [
                {
                    "date": pt.date,
                    "close": pt.close,
                    "position": pt.position,
                    "cash": pt.cash,
                    "equity": pt.equity,
                    "signal": pt.signal,
                    **pt.extras,
                }
                for pt in self.equity_curve
            ],
            "trades": [
                {
                    "date": t.date,
                    "side": t.side,
                    "shares": t.shares,
                    "price": round(t.price, 4),
                    "fee": round(t.fee, 2),
                    "cash_after": t.cash_after,
                }
                for t in self.trades
            ],
            "bars": [b.to_dict() for b in bars],
        }


# --- 工具函数 ---


def _max_drawdown(equities: List[float]) -> float:
    peak = equities[0] if equities else 0.0
    max_dd = 0.0
    for equity in equities:
        if peak < equity:
            peak = equity
        if peak > 0:
            dd = equity / peak - 1
            if dd < max_dd:
                max_dd = dd
    return abs(max_dd)


def _trade_win_stats(trades: List[Trade]) -> tuple[int, int]:
    """统计 (wins, closed)；按买入-卖出配对，每对平仓算一次。"""
    wins = 0
    closed = 0
    entry_price: Optional[float] = None
    for trade in trades:
        if trade.side == "buy":
            entry_price = trade.price
        elif trade.side == "sell" and entry_price is not None:
            closed += 1
            if trade.price > entry_price:
                wins += 1
            entry_price = None
    return wins, closed


def _round_or_none(value: Optional[float]) -> Optional[float]:
    return round(value, 4) if value is not None else None


__all__ = [
    "Trade",
    "EquityPoint",
    "BaseStrategy",
]
