"""回测基础：Bar、Trade、EquityPoint、BaseStrategy。

设计要点：
- 子类只关注 on_bar；buy/sell/equity 等公共逻辑在基类。
- 收盘产生信号，下一根可交易 K 线的开盘价撮合，避免收盘信号同价成交的前视偏差。
- 统一处理滑点、佣金、印花税、过户费、停牌和一字涨跌停。
- 指标预计算在 run() 入口一次性完成，避免每个 bar 重复切片。
- run() 输出的 dict 保持与历史 API 兼容：summary/equity_curve/trades/bars 四个 key。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import math
import statistics
from typing import Any, Dict, List, Optional

from quant.data.normalization import Bar


# --- 公共数据类 ---


@dataclass
class Trade:
    date: str
    signal_date: str
    side: str  # "buy" / "sell"
    shares: int
    price: float
    fee: float
    commission: float
    stamp_duty: float
    transfer_fee: float
    slippage_cost: float
    cash_after: float


@dataclass(frozen=True)
class ExecutionConfig:
    """现实撮合参数。

    ``commission_rate`` 由原有 ``fee_rate`` 提供，以保持 API 兼容；
    其余默认值按沪深 A 股普通账户的常见成本模型设定，均可由请求覆盖。
    """

    slippage_rate: float = 0.0005
    min_commission: float = 5.0
    stamp_duty_rate: float = 0.0005
    transfer_fee_rate: float = 0.00001
    lot_size: int = 100
    max_pending_bars: int = 5
    price_limit_pct: Optional[float] = None

    def validate(self) -> None:
        rates = {
            "slippage_rate": self.slippage_rate,
            "stamp_duty_rate": self.stamp_duty_rate,
            "transfer_fee_rate": self.transfer_fee_rate,
        }
        if any(not math.isfinite(value) or not 0 <= value < 1 for value in rates.values()):
            raise ValueError("滑点和各类费率必须是 [0, 1) 内的有限数")
        if not math.isfinite(self.min_commission) or self.min_commission < 0:
            raise ValueError("最低佣金必须是非负有限数")
        if self.lot_size < 1 or self.max_pending_bars < 1:
            raise ValueError("交易单位和最大等待 K 线数必须大于 0")
        if self.price_limit_pct is not None and not 0 < self.price_limit_pct < 1:
            raise ValueError("涨跌停比例必须在 (0, 1) 之间，或留空自动判断")


@dataclass
class PendingOrder:
    side: str
    signal_date: str
    requested_shares: int
    reference_price: float
    waited_bars: int = 0


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
        if not math.isfinite(initial_cash) or initial_cash <= 0:
            raise ValueError("初始资金必须大于 0")
        if not math.isfinite(fee_rate) or not 0 <= fee_rate < 1:
            raise ValueError("手续费率必须在 [0, 1) 之间")
        self.initial_cash = float(initial_cash)
        self.fee_rate = float(fee_rate)
        self.cash = float(initial_cash)
        self.shares = 0
        self.trades: List[Trade] = []
        self.equity_curve: List[EquityPoint] = []
        self.current_signal = "hold"
        self.execution = ExecutionConfig()
        self.pending_order: Optional[PendingOrder] = None
        self.order_events: List[Dict[str, Any]] = []
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

    def on_trade(self, trade: Trade) -> None:  # noqa: ARG002
        """可选成交回调：需要真实成交价的止损策略可覆盖。"""

    def on_order_cancelled(self, order: PendingOrder) -> None:  # noqa: ARG002
        """可选取消回调：用于清理策略的待成交状态。"""

    def reset_strategy_state(self) -> None:
        """可选重置回调，保证同一策略实例重复 run 不泄漏上次状态。"""

    # --- 公共方法 ---

    def configure_execution(self, execution: Optional[ExecutionConfig] = None) -> None:
        """在策略构造后注入撮合参数，避免每个子类重复暴露服务级参数。"""
        config = execution or ExecutionConfig()
        config.validate()
        self.execution = config

    def buy(self, bar: Bar, price: float, shares: int) -> None:
        """提交买入指令；指令最早在下一根 K 线开盘成交。"""
        if shares <= 0 or self.shares > 0 or self.pending_order is not None:
            return
        lot = self.execution.lot_size
        shares = int(shares / lot) * lot
        if shares <= 0:
            return
        self.pending_order = PendingOrder(
            side="buy",
            signal_date=bar.date,
            requested_shares=shares,
            reference_price=price,
        )
        self.current_signal = "buy_signal"

    def sell(self, bar: Bar, price: float) -> None:
        """提交卖出指令；A 股 T+1 在日线模型中自然满足。"""
        if self.shares <= 0 or self.pending_order is not None:
            return
        self.pending_order = PendingOrder(
            side="sell",
            signal_date=bar.date,
            requested_shares=self.shares,
            reference_price=price,
        )
        self.current_signal = "sell_signal"

    def equity(self, bar: Bar) -> float:
        return self.cash + self.shares * bar.close

    def calc_buyable_shares(self, price: float) -> int:
        """按整手并预留买入佣金/过户费计算可买股数。"""
        if price <= 0:
            return 0
        lot = self.execution.lot_size
        shares = int(self.cash / price / lot) * lot
        while shares > 0:
            notional = shares * price
            fee = self._fees(notional, "buy")[0]
            if notional + fee <= self.cash + 1e-9:
                return shares
            shares -= lot
        return 0

    def _fees(self, notional: float, side: str) -> tuple[float, float, float, float]:
        commission = max(self.execution.min_commission, notional * self.fee_rate)
        transfer_fee = notional * self.execution.transfer_fee_rate
        stamp_duty = notional * self.execution.stamp_duty_rate if side == "sell" else 0.0
        total = commission + transfer_fee + stamp_duty
        return total, commission, stamp_duty, transfer_fee

    def _try_execute_pending(self, bar: Bar, previous_close: Optional[float]) -> None:
        order = self.pending_order
        if order is None:
            return
        reason = self._untradable_reason(bar, order.side, previous_close)
        if reason:
            order.waited_bars += 1
            if order.waited_bars >= self.execution.max_pending_bars:
                self._record_order_event(bar, order, "cancelled", reason)
                self.on_order_cancelled(order)
                self.pending_order = None
            else:
                self._record_order_event(bar, order, "deferred", reason)
            return

        open_price = bar.open if bar.open is not None else bar.close
        direction = 1.0 if order.side == "buy" else -1.0
        raw_fill = open_price * (1.0 + direction * self.execution.slippage_rate)
        low = bar.low if bar.low is not None else min(open_price, bar.close)
        high = bar.high if bar.high is not None else max(open_price, bar.close)
        fill_price = min(max(raw_fill, low), high)

        if order.side == "buy":
            shares = min(order.requested_shares, self.calc_buyable_shares(fill_price))
            if shares <= 0:
                self._record_order_event(bar, order, "cancelled", "可用资金不足")
                self.on_order_cancelled(order)
                self.pending_order = None
                return
            notional = shares * fill_price
            fee, commission, stamp_duty, transfer_fee = self._fees(notional, "buy")
            self.cash -= notional + fee
            self.shares = shares
        else:
            shares = min(order.requested_shares, self.shares)
            if shares <= 0:
                self._record_order_event(bar, order, "cancelled", "无可卖持仓")
                self.on_order_cancelled(order)
                self.pending_order = None
                return
            notional = shares * fill_price
            fee, commission, stamp_duty, transfer_fee = self._fees(notional, "sell")
            self.cash += notional - fee
            self.shares -= shares

        trade = Trade(
            date=bar.date,
            signal_date=order.signal_date,
            side=order.side,
            shares=shares,
            price=fill_price,
            fee=fee,
            commission=commission,
            stamp_duty=stamp_duty,
            transfer_fee=transfer_fee,
            slippage_cost=abs(fill_price - open_price) * shares,
            cash_after=round(self.cash, 2),
        )
        self.trades.append(trade)
        self.on_trade(trade)
        self.current_signal = order.side
        self._record_order_event(bar, order, "filled", "")
        self.pending_order = None

    def _untradable_reason(
        self, bar: Bar, side: str, previous_close: Optional[float]
    ) -> str:
        if bar.volume is not None and bar.volume <= 0:
            return "停牌或无成交量"
        if previous_close is None or previous_close <= 0:
            return ""
        high = bar.high
        low = bar.low
        if high is None or low is None or not math.isclose(high, low, rel_tol=1e-6):
            return ""
        limit = self.execution.price_limit_pct or _infer_price_limit(bar)
        change = high / previous_close - 1.0
        tolerance = 0.002
        if side == "buy" and change >= limit - tolerance:
            return "一字涨停无法买入"
        if side == "sell" and change <= -limit + tolerance:
            return "一字跌停无法卖出"
        return ""

    def _record_order_event(
        self, bar: Bar, order: PendingOrder, status: str, reason: str
    ) -> None:
        self.order_events.append(
            {
                "date": bar.date,
                "signal_date": order.signal_date,
                "side": order.side,
                "status": status,
                "reason": reason,
            }
        )

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
        self.pending_order = None
        self.order_events = []
        self.reset_strategy_state()

        for i, bar in enumerate(bars):
            self.current_signal = "hold"
            self._try_execute_pending(bar, bars[i - 1].close if i > 0 else None)
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
        if self.pending_order is not None:
            self._record_order_event(
                bars[-1], self.pending_order, "cancelled", "回测结束，无下一根 K 线可成交"
            )
            self.on_order_cancelled(self.pending_order)
            self.pending_order = None
        return self.build_result(bars)

    # --- 结果汇总 ---

    def build_result(self, bars: List[Bar]) -> Dict[str, Any]:
        final_equity = self.equity_curve[-1].equity
        total_return = final_equity / self.initial_cash - 1
        benchmark_return = bars[-1].close / bars[0].close - 1
        max_dd = _max_drawdown([pt.equity for pt in self.equity_curve])
        wins, closed = _trade_win_stats(self.trades)
        annual_return = _annualized_return(
            self.initial_cash, final_equity, max(0, len(self.equity_curve) - 1)
        )
        sharpe_ratio = _sharpe_ratio([pt.equity for pt in self.equity_curve])
        total_cost = sum(t.fee + t.slippage_cost for t in self.trades)
        return {
            "summary": {
                "strategy": self.get_strategy_name(),
                "initial_cash": round(self.initial_cash, 2),
                "final_equity": round(final_equity, 2),
                "total_return": round(total_return, 6),
                "annual_return": round(annual_return, 6) if annual_return is not None else None,
                "benchmark_return": round(benchmark_return, 6),
                "excess_return": round(total_return - benchmark_return, 6),
                "max_drawdown": round(max_dd, 6),
                "sharpe_ratio": round(sharpe_ratio, 6) if sharpe_ratio is not None else None,
                "trade_count": len(self.trades),
                "closed_trades": closed,
                "win_rate": round(wins / closed, 6) if closed else None,
                "start_date": bars[0].date,
                "end_date": bars[-1].date,
                "bar_count": len(bars),
                "total_cost": round(total_cost, 2),
                "commission": round(sum(t.commission for t in self.trades), 2),
                "stamp_duty": round(sum(t.stamp_duty for t in self.trades), 2),
                "transfer_fee": round(sum(t.transfer_fee for t in self.trades), 2),
                "slippage_cost": round(sum(t.slippage_cost for t in self.trades), 2),
                "deferred_orders": sum(e["status"] == "deferred" for e in self.order_events),
                "cancelled_orders": sum(e["status"] == "cancelled" for e in self.order_events),
                "execution_model": "next_bar_open",
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
                    "signal_date": t.signal_date,
                    "side": t.side,
                    "shares": t.shares,
                    "price": round(t.price, 4),
                    "fee": round(t.fee, 2),
                    "commission": round(t.commission, 2),
                    "stamp_duty": round(t.stamp_duty, 2),
                    "transfer_fee": round(t.transfer_fee, 2),
                    "slippage_cost": round(t.slippage_cost, 2),
                    "cash_after": t.cash_after,
                }
                for t in self.trades
            ],
            "order_events": self.order_events,
            "execution": {
                "model": "next_bar_open",
                "commission_rate": self.fee_rate,
                "slippage_rate": self.execution.slippage_rate,
                "min_commission": self.execution.min_commission,
                "stamp_duty_rate": self.execution.stamp_duty_rate,
                "transfer_fee_rate": self.execution.transfer_fee_rate,
                "lot_size": self.execution.lot_size,
                "max_pending_bars": self.execution.max_pending_bars,
                "price_limit_pct": self.execution.price_limit_pct,
            },
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
    entry: Optional[Trade] = None
    for trade in trades:
        if trade.side == "buy":
            entry = trade
        elif trade.side == "sell" and entry is not None:
            closed += 1
            shares = min(entry.shares, trade.shares)
            entry_cost = shares * entry.price + entry.fee
            exit_proceeds = shares * trade.price - trade.fee
            if exit_proceeds > entry_cost:
                wins += 1
            entry = None
    return wins, closed


def _annualized_return(
    initial_equity: float, final_equity: float, periods: int
) -> Optional[float]:
    if periods <= 0 or initial_equity <= 0 or final_equity <= 0:
        return None
    try:
        result = (final_equity / initial_equity) ** (252.0 / periods) - 1.0
    except OverflowError:
        return None
    return result if math.isfinite(result) else None


def _sharpe_ratio(equities: List[float]) -> Optional[float]:
    returns = [
        current / previous - 1.0
        for previous, current in zip(equities, equities[1:])
        if previous > 0 and math.isfinite(previous) and math.isfinite(current)
    ]
    if len(returns) < 2:
        return None
    volatility = statistics.stdev(returns)
    if volatility <= 0:
        return 0.0
    return statistics.mean(returns) / volatility * math.sqrt(252.0)


def _round_or_none(value: Optional[float]) -> Optional[float]:
    return round(value, 4) if value is not None else None


def _infer_price_limit(bar: Bar) -> float:
    """根据代码/名称推断普通交易日涨跌幅。

    新股上市初期等特例无法仅从 K 线可靠识别，调用方可用
    ``price_limit_pct`` 显式覆盖。
    """
    code = (bar.code or "").upper()
    name = (bar.name or "").upper().replace(" ", "")
    digits = code.split(".", 1)[0]
    if "ST" in name:
        return 0.05
    if code.endswith(".BJ") or digits.startswith(("4", "8", "92")):
        return 0.30
    if digits.startswith(("300", "301", "688", "689")):
        return 0.20
    return 0.10


__all__ = [
    "Trade",
    "ExecutionConfig",
    "PendingOrder",
    "EquityPoint",
    "BaseStrategy",
]
