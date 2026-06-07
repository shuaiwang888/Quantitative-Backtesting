"""30 个纯价量型 Alpha101 因子（去财务依赖）。

每个因子都是 ``quant.factors.Factor`` 的具体实现，接收 List[Bar]，返回等长因子分。
公式来自 WorldQuant Alpha101 论文 (Kakushadze 2016) 的 1-101 号，
本文件挑出仅依赖 OHLCV(+volume) 的子集，
并且在单标的场景下把"截面 rank"退化为"窗口 ts_rank/全序列 rank"。

新增因子只需：
1. 继承 ``Alpha101Factor``
2. 实现 ``formula(opens, highs, lows, closes, volumes, returns)``
3. ``register_alpha`` 一次
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

from quant.data.normalization import Bar
from quant.factors.base import Factor, register_factor
from quant.factors.operators import (
    Series,
    _to_float,
    adv,
    decay_linear,
    delay,
    delta,
    product,
    rank,
    rolling_corr,
    scale,
    sign,
    signedpower,
    ts_argmax,
    ts_max,
    ts_mean,
    ts_min,
    ts_rank,
    ts_stddev,
    ts_sum,
    vwap_from_bars,
    where,
)


def _bar_series(bars: Sequence[Bar]) -> Tuple[Series, Series, Series, Series, Series, Series]:
    """从 bars 抽出 (open, high, low, close, volume, returns) 6 条等长序列。"""
    opens: Series = [_to_float(b.open) for b in bars]
    highs: Series = [_to_float(b.high) for b in bars]
    lows: Series = [_to_float(b.low) for b in bars]
    closes: Series = [_to_float(b.close) for b in bars]
    volumes: Series = [_to_float(b.volume) for b in bars]
    rets: Series = [None] * len(closes)
    for i in range(1, len(closes)):
        a, b = closes[i - 1], closes[i]
        if a is None or b is None or a == 0:
            continue
        rets[i] = b / a - 1
    return opens, highs, lows, closes, volumes, rets


class Alpha101Factor(Factor):
    """所有 Alpha101 因子的基类：只暴露 6 条等长序列给 formula。"""

    display_name: str = ""

    def compute(self, bars: List[Bar]) -> Series:
        if len(bars) < 2:
            return [None] * len(bars)
        opens, highs, lows, closes, volumes, rets = _bar_series(bars)
        try:
            return self.formula(opens, highs, lows, closes, volumes, rets)
        except Exception:
            return [None] * len(bars)

    def formula(  # noqa: D401
        self,
        opens: Series,
        highs: Series,
        lows: Series,
        closes: Series,
        volumes: Series,
        returns: Series,
    ) -> Series:
        raise NotImplementedError


def register_alpha(name: str, instance: Alpha101Factor) -> None:
    """注册一个 alpha 因子到全局表。"""
    register_factor(name, instance)


# =============================================================================
# 30 个纯价量 alpha 实现
# =============================================================================


class Alpha001(Alpha101Factor):
    """(rank(ts_argmax(signedpower(returns<0?stddev(returns,20):close, 2), 5)) - 0.5)"""

    display_name = "1-均值回归(波动率加权)"

    def formula(self, o, h, l, c, v, r):
        std_20 = ts_stddev(r, 20)
        cond = [(1.0 if (rv is not None and rv < 0) else 0.0) for rv in r]
        base: Series = [
            std_20[i] if cond[i] else c[i] for i in range(len(c))
        ]
        signed = signedpower(base, 2.0)
        argmax_pos = ts_argmax(signed, 5)
        return [((x - 0.5) if x is not None else None) for x in argmax_pos]


class Alpha002(Alpha101Factor):
    """-1 * corr(rank(delta(log(volume), 2)), rank((close-open)/open), 6)"""

    display_name = "2-量价背离(2日)"

    def formula(self, o, h, l, c, v, r):
        if len(v) < 3:
            return [None] * len(c)
        log_v: Series = [None if x is None else math.log(x + 1.0) for x in v]
        d_logv = delta(log_v, 2)
        rank_v = rank(d_logv)
        intraday = [(c[i] - o[i]) / o[i] if (c[i] is not None and o[i] not in (None, 0)) else None
                    for i in range(len(c))]
        rank_i = rank(intraday)
        return [-1.0 * x if x is not None else None
                for x in rolling_corr(rank_v, rank_i, 6)]


class Alpha003(Alpha101Factor):
    """-1 * corr(rank(open), rank(volume), 10)"""

    display_name = "3-开盘量相关"

    def formula(self, o, h, l, c, v, r):
        return [-1.0 * x if x is not None else None
                for x in rolling_corr(rank(o), rank(v), 10)]


class Alpha004(Alpha101Factor):
    """-1 * ts_rank(rank(low), 9)"""

    display_name = "4-最低位 ts_rank"

    def formula(self, o, h, l, c, v, r):
        return [-1.0 * x if x is not None else None for x in ts_rank(rank(l), 9)]


class Alpha006(Alpha101Factor):
    """-1 * corr(close, open, 10)"""

    display_name = "6-收开相关"

    def formula(self, o, h, l, c, v, r):
        return [-1.0 * x if x is not None else None for x in rolling_corr(c, o, 10)]


class Alpha010(Alpha101Factor):
    """rank(where(0<ts_min(delta(close,1),4), delta(close,1),
                  where(ts_max(delta(close,1),4)<0, delta(close,1), -1*delta(close,1))))"""

    display_name = "10-1日动量方向"

    def formula(self, o, h, l, c, v, r):
        d1 = delta(c, 1)
        min_d = ts_min(d1, 4)
        max_d = ts_max(d1, 4)
        cond1 = [(0.0 if m is None else (1.0 if 0 < m else 0.0)) for m in min_d]
        cond2 = [(0.0 if m is None else (1.0 if m < 0 else 0.0)) for m in max_d]
        chosen: Series = []
        for i in range(len(c)):
            d = d1[i]
            if d is None:
                chosen.append(None)
            elif cond1[i] > 0:
                chosen.append(d)
            elif cond2[i] > 0:
                chosen.append(d)
            else:
                chosen.append(-d)
        return rank(chosen)


class Alpha012(Alpha101Factor):
    """sign(delta(volume,1)) * -1 * delta(close,1)"""

    display_name = "12-量价方向背离"

    def formula(self, o, h, l, c, v, r):
        dv = delta(v, 1)
        dc = delta(c, 1)
        sgn = sign(dv)
        return [(s * (-1.0) * d) if (s is not None and d is not None) else None
                for s, d in zip(sgn, dc)]


class Alpha014(Alpha101Factor):
    """(-1 * rank(delta(returns, 3))) * corr(open, volume, 10)"""

    display_name = "14-3日收益 × 开盘量"

    def formula(self, o, h, l, c, v, r):
        dr = rank(delta(r, 3))
        corr_ov = rolling_corr(o, v, 10)
        return [(-1.0 * a * b) if (a is not None and b is not None) else None
                for a, b in zip(dr, corr_ov)]


class Alpha016(Alpha101Factor):
    """-1 * rank(corr(rank(high), rank(volume), 5))"""

    display_name = "16-高量相关"

    def formula(self, o, h, l, c, v, r):
        return [-1.0 * x if x is not None else None
                for x in rank(rolling_corr(rank(h), rank(v), 5))]


class Alpha018(Alpha101Factor):
    """-1 * rank((stddev(abs(close-open), 5) + (close-open) + corr(close, open, 10)))"""

    display_name = "18-日内振幅合成"

    def formula(self, o, h, l, c, v, r):
        abs_co: Series = [None if (a is None or b is None) else abs(b - a) for a, b in zip(c, o)]
        std_co = ts_stddev(abs_co, 5)
        co: Series = [None if (a is None or b is None) else (b - a) for a, b in zip(c, o)]
        corr_co = rolling_corr(c, o, 10)
        composite: Series = []
        for i in range(len(c)):
            s, dc, cr = std_co[i], co[i], corr_co[i]
            if s is None or dc is None or cr is None:
                composite.append(None)
            else:
                composite.append(s + dc + cr)
        return [-1.0 * x if x is not None else None for x in rank(composite)]


class Alpha019(Alpha101Factor):
    """(-1 * sign((close - delay(close, 7) + delta(close, 7)))) * (1 + rank(1 + sum(returns, 250)))"""

    display_name = "19-7日反转 × 长期收益"

    def formula(self, o, h, l, c, v, r):
        d7 = delay(c, 7)
        dc7 = delta(c, 7)
        s_arg: Series = [None if (a is None or b is None) else (a - b + b) for a, b in zip(c, d7)]
        s_arg = [None if (a is None or b is None) else (a + b) for a, b in zip(c, d7)]
        # 重新算干净: close - delay(close,7) + delta(close,7) = 2*close - 2*delay(close,7)
        s_arg = [None if (a is None or b is None) else (2 * a - 2 * b) for a, b in zip(c, d7)]
        s_sign = sign(s_arg)
        sum_r = ts_sum(r, 250)
        long_rank = rank([None if x is None else (1 + x) for x in sum_r])
        out: Series = []
        for i in range(len(c)):
            s, lr = s_sign[i], long_rank[i]
            if s is None or lr is None:
                out.append(None)
            else:
                out.append(-1.0 * s * (1 + lr))
        return out


class Alpha022(Alpha101Factor):
    """-1 * delta(corr(high, volume, 5), 5) * rank(stddev(close, 20))"""

    display_name = "22-高量相关 5 日变化"

    def formula(self, o, h, l, c, v, r):
        corr_hv = rolling_corr(h, v, 5)
        d_corr = delta(corr_hv, 5)
        r_std = rank(ts_stddev(c, 20))
        return [(-1.0 * a * b) if (a is not None and b is not None) else None
                for a, b in zip(d_corr, r_std)]


class Alpha023(Alpha101Factor):
    """((delta(sum(volume, 20), 20) / 20) / sum(volume, 20)) * 100"""

    display_name = "23-20日量变化率"

    def formula(self, o, h, l, c, v, r):
        sv = ts_sum(v, 20)
        d_sv = delta(sv, 20)
        out: Series = []
        for i in range(len(c)):
            d, s = d_sv[i], sv[i]
            if d is None or s is None or s == 0:
                out.append(None)
            else:
                out.append(d / 20.0 / s * 100.0)
        return out


class Alpha026(Alpha101Factor):
    """-1 * ts_max(corr(ts_rank(volume, 5), ts_rank(high, 5), 5), 3)"""

    display_name = "26-量高位相关最大"

    def formula(self, o, h, l, c, v, r):
        tv5 = ts_rank(v, 5)
        th5 = ts_rank(h, 5)
        corr_vh = rolling_corr(tv5, th5, 5)
        mxv = ts_max(corr_vh, 3)
        return [-1.0 * x if x is not None else None for x in mxv]


class Alpha028(Alpha101Factor):
    """scale(((corr(adv20, low, 5) + ((high + low) / 2)) - close))"""

    display_name = "28-均价低相关"

    def formula(self, o, h, l, c, v, r):
        a20 = adv(v, 20)
        corr_al = rolling_corr(a20, l, 5)
        mid: Series = [None if (a is None or b is None) else (a + b) / 2 for a, b in zip(h, l)]
        comp: Series = [None if (a is None or b is None or d is None) else (a + b - d)
                        for a, b, d in zip(corr_al, mid, c)]
        return scale(comp)


class Alpha033(Alpha101Factor):
    """rank(-1 * (1 - (open / close)))"""

    display_name = "33-开收比反转"

    def formula(self, o, h, l, c, v, r):
        ratios: Series = [None if (a is None or b is None or b == 0) else (1 - a / b)
                          for a, b in zip(o, c)]
        neg: Series = [None if x is None else -x for x in ratios]
        return rank(neg)


class Alpha034(Alpha101Factor):
    """rank((1 - rank(stddev(returns, 2) / stddev(returns, 5))) + (1 - rank(delta(close, 1))))"""

    display_name = "34-短长波动率比"

    def formula(self, o, h, l, c, v, r):
        std2 = ts_stddev(r, 2)
        std5 = ts_stddev(r, 5)
        ratio: Series = [None if (a is None or b is None or b == 0) else a / b
                         for a, b in zip(std2, std5)]
        r1 = rank(ratio)
        r2 = rank(delta(c, 1))
        out: Series = [None if (a is None or b is None) else (1 - a) + (1 - b)
                       for a, b in zip(r1, r2)]
        return rank(out)


class Alpha038(Alpha101Factor):
    """(-1 * rank(ts_rank(close, 10))) * rank(close / open)"""

    display_name = "38-收位 ts_rank × 收开比"

    def formula(self, o, h, l, c, v, r):
        trc = ts_rank(c, 10)
        rk1 = rank(trc)
        ratio: Series = [None if (a is None or b is None or b == 0) else a / b
                         for a, b in zip(c, o)]
        rk2 = rank(ratio)
        return [(-1.0 * a * b) if (a is not None and b is not None) else None
                for a, b in zip(rk1, rk2)]


class Alpha040(Alpha101Factor):
    """-1 * rank(stddev(high, 10) * corr(high, volume, 10))"""

    display_name = "40-高波 × 高量相关"

    def formula(self, o, h, l, c, v, r):
        s_h = ts_stddev(h, 10)
        c_hv = rolling_corr(h, v, 10)
        prod: Series = [None if (a is None or b is None) else a * b for a, b in zip(s_h, c_hv)]
        return [-1.0 * x if x is not None else None for x in rank(prod)]


class Alpha046(Alpha101Factor):
    """((0.25 < mid20_10) ? -1 : (mid20_10 < 0 ? 1 : (-1 * (close - delay(close, 1)))))"""

    display_name = "46-20/10日中期动量"

    def formula(self, o, h, l, c, v, r):
        d20 = delay(c, 20)
        d10 = delay(c, 10)
        mid: Series = [None if (a is None or b is None) else (a - b) / 10.0 - (b - cc) / 10.0
                       for a, b, cc in zip(d20, d10, c)]
        d1 = delay(c, 1)
        dc1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d1)]
        out: Series = []
        for i in range(len(c)):
            m, d = mid[i], dc1[i]
            if m is None or d is None:
                out.append(None)
            elif 0.25 < m:
                out.append(-1.0)
            elif m < 0:
                out.append(1.0)
            else:
                out.append(-1.0 * d)
        return out


class Alpha049(Alpha101Factor):
    """((mid < -0.1) ? 1 : (-1 * (close - delay(close, 1))))"""

    display_name = "49-强中期反转"

    def formula(self, o, h, l, c, v, r):
        d20 = delay(c, 20)
        d10 = delay(c, 10)
        mid: Series = [None if (a is None or b is None) else (a - b) / 10.0 - (b - cc) / 10.0
                       for a, b, cc in zip(d20, d10, c)]
        d1 = delay(c, 1)
        dc1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d1)]
        out: Series = []
        for i in range(len(c)):
            m, d = mid[i], dc1[i]
            if m is None or d is None:
                out.append(None)
            elif m < -0.1:
                out.append(1.0)
            else:
                out.append(-1.0 * d)
        return out


class Alpha051(Alpha101Factor):
    """((mid < -0.05) ? 1 : (-1 * (close - delay(close, 1))))"""

    display_name = "51-中度中期反转"

    def formula(self, o, h, l, c, v, r):
        d20 = delay(c, 20)
        d10 = delay(c, 10)
        mid: Series = [None if (a is None or b is None) else (a - b) / 10.0 - (b - cc) / 10.0
                       for a, b, cc in zip(d20, d10, c)]
        d1 = delay(c, 1)
        dc1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d1)]
        out: Series = []
        for i in range(len(c)):
            m, d = mid[i], dc1[i]
            if m is None or d is None:
                out.append(None)
            elif m < -0.05:
                out.append(1.0)
            else:
                out.append(-1.0 * d)
        return out


class Alpha053(Alpha101Factor):
    """-1 * delta(((close - low) - (high - close)) / (close - low), 9)"""

    display_name = "53-中价 9 日变化"

    def formula(self, o, h, l, c, v, r):
        ratio: Series = []
        for i in range(len(c)):
            ci, li, hi = c[i], l[i], h[i]
            if None in (ci, li, hi) or ci == li:
                ratio.append(None)
            else:
                ratio.append(((ci - li) - (hi - ci)) / (ci - li))
        d9 = delta(ratio, 9)
        return [-1.0 * x if x is not None else None for x in d9]


class Alpha054(Alpha101Factor):
    """-1 * ((low - close) * open^5) / ((low - high) * close^5)"""

    display_name = "54-日内形态"

    def formula(self, o, h, l, c, v, r):
        out: Series = []
        for i in range(len(c)):
            li, ci, hi, oi = l[i], c[i], h[i], o[i]
            if None in (li, ci, hi, oi) or li == hi or ci == 0:
                out.append(None)
            else:
                num = (li - ci) * (oi ** 5)
                den = (li - hi) * (ci ** 5)
                if den == 0:
                    out.append(None)
                else:
                    out.append(-1.0 * num / den)
        return out


class Alpha060(Alpha101Factor):
    """-(2 * scale(rank(((close - low - (high - close)) / (high - low)) * volume)) - scale(rank(ts_argmax(close, 10))))"""

    display_name = "60-影线 × 量"

    def formula(self, o, h, l, c, v, r):
        shape: Series = []
        for i in range(len(c)):
            ci, li, hi, vi = c[i], l[i], h[i], v[i]
            if None in (ci, li, hi, vi) or hi == li:
                shape.append(None)
            else:
                shape.append(((ci - li - (hi - ci)) / (hi - li)) * vi)
        rk1 = rank(shape)
        sc1 = scale(rk1)
        rk2 = rank(ts_argmax(c, 10))
        sc2 = scale(rk2)
        out: Series = [None if (a is None or b is None) else -(2 * a - b) for a, b in zip(sc1, sc2)]
        return out


class Alpha066(Alpha101Factor):
    """-1 * rank(open - delay(close, 1)) * rank(open - close) * rank(close - delay(close, 1))"""

    display_name = "66-隔夜缺口 × 日内反转"

    def formula(self, o, h, l, c, v, r):
        d1 = delay(c, 1)
        gap: Series = [None if (a is None or b is None) else a - b for a, b in zip(o, d1)]
        intraday: Series = [None if (a is None or b is None) else a - b for a, b in zip(o, c)]
        ret1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d1)]
        rk1 = rank(gap)
        rk2 = rank(intraday)
        rk3 = rank(ret1)
        out: Series = [None if (a is None or b is None or d is None) else -1.0 * a * b * d
                       for a, b, d in zip(rk1, rk2, rk3)]
        return out


class Alpha068(Alpha101Factor):
    """-(ts_rank(corr(rank(high), rank(adv15), 9), 14) < rank(delta(close*0.518+low*0.482, 1)))"""

    display_name = "68-高 × 15日均量相关"

    def formula(self, o, h, l, c, v, r):
        a15 = adv(v, 15)
        corr_ha = rolling_corr(rank(h), rank(a15), 9)
        left = ts_rank(corr_ha, 14)
        blend: Series = [None if (ci is None or li is None) else (0.518371 * ci + 0.481629 * li)
                         for ci, li in zip(c, l)]
        right = rank(delta(blend, 1))
        out: Series = [None if (a is None or b is None) else (-1.0 if a < b else 0.0)
                       for a, b in zip(left, right)]
        return out


class Alpha091(Alpha101Factor):
    """(rank(close - ts_max(close, 5)) + ts_rank(ts_min(close - delay(close, 5), 5), 2)) * rank(close - delay(close, 1))"""

    display_name = "91-5日新低 × 短期反转"

    def formula(self, o, h, l, c, v, r):
        max5 = ts_max(c, 5)
        part1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, max5)]
        d5 = delay(c, 5)
        diff: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d5)]
        min_d5 = ts_min(diff, 5)
        part2 = ts_rank(min_d5, 2)
        rk1 = rank(part1)
        d1 = delay(c, 1)
        ret1: Series = [None if (a is None or b is None) else a - b for a, b in zip(c, d1)]
        rk2 = rank(ret1)
        out: Series = [None if (a is None or b is None or d is None) else (a + b) * d
                       for a, b, d in zip(rk1, part2, rk2)]
        return out


class Alpha093(Alpha101Factor):
    """(rank(volume - ts_min(volume, 4)) < ts_rank(delta(close, 3), 5)) * 1"""

    display_name = "93-量近 4 日新低 × 3日价变"

    def formula(self, o, h, l, c, v, r):
        min4 = ts_min(v, 4)
        vol_diff: Series = [None if (a is None or b is None) else a - b for a, b in zip(v, min4)]
        left = rank(vol_diff)
        right = ts_rank(delta(c, 3), 5)
        out: Series = [None if (a is None or b is None) else (1.0 if a < b else 0.0)
                       for a, b in zip(left, right)]
        return out


class Alpha101(Alpha101Factor):
    """(close - open) / ((high - low) + 0.001) — 经典 K 线实体/振幅"""

    display_name = "101-K线实体/振幅"

    def formula(self, o, h, l, c, v, r):
        out: Series = []
        for i in range(len(c)):
            ci, oi, hi, li = c[i], o[i], h[i], l[i]
            if None in (ci, oi, hi, li):
                out.append(None)
            else:
                out.append((ci - oi) / (hi - li + 0.001))
        return out


# =============================================================================
# 注册 30 个 alpha
# =============================================================================


_ALPHA_INSTANCES: List[Tuple[str, Alpha101Factor]] = [
    ("alpha_001", Alpha001()),
    ("alpha_002", Alpha002()),
    ("alpha_003", Alpha003()),
    ("alpha_004", Alpha004()),
    ("alpha_006", Alpha006()),
    ("alpha_010", Alpha010()),
    ("alpha_012", Alpha012()),
    ("alpha_014", Alpha014()),
    ("alpha_016", Alpha016()),
    ("alpha_018", Alpha018()),
    ("alpha_019", Alpha019()),
    ("alpha_022", Alpha022()),
    ("alpha_023", Alpha023()),
    ("alpha_026", Alpha026()),
    ("alpha_028", Alpha028()),
    ("alpha_033", Alpha033()),
    ("alpha_034", Alpha034()),
    ("alpha_038", Alpha038()),
    ("alpha_040", Alpha040()),
    ("alpha_046", Alpha046()),
    ("alpha_049", Alpha049()),
    ("alpha_051", Alpha051()),
    ("alpha_053", Alpha053()),
    ("alpha_054", Alpha054()),
    ("alpha_060", Alpha060()),
    ("alpha_066", Alpha066()),
    ("alpha_068", Alpha068()),
    ("alpha_091", Alpha091()),
    ("alpha_093", Alpha093()),
    ("alpha_101", Alpha101()),
]


for _name, _inst in _ALPHA_INSTANCES:
    register_alpha(_name, _inst)


__all__ = ["Alpha101Factor", "register_alpha"] + [n for n, _ in _ALPHA_INSTANCES]
