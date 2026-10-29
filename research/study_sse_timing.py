"""Reproducible index timing study; select only on training/validation, then report holdout.

Data: project Iwencai wrapper; optional fetched data cached outside Git.
Execution: real project strategy engine, next open, long-only/no borrowing, conservative stock costs.
"""
from __future__ import annotations
import hashlib
import itertools
import json
import math
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from quant.data.normalization import Bar
from quant.strategies import make_strategy
from quant.strategies.index_trend import IndexTrendStrategy
from quant.strategies.base import BaseStrategy, ExecutionConfig, _max_drawdown

INITIAL = 1_000_000.0
SPLITS = {'train': ('2005-01-01', '2016-12-31'),
          'validation': ('2017-01-01', '2020-12-31'),
          'holdout': ('2021-01-01', '2026-10-28'),
          'full': ('2005-01-01', '2026-10-28')}
EXECUTION = ExecutionConfig(lot_size=1)

class BuyHold(BaseStrategy):
    def get_strategy_name(self): return 'Buy and hold'
    def get_extras(self, bar, index): return {}
    def on_bar(self, bar, index):
        if not self.shares and not self.trades:
            self.buy(bar, bar.close, self.calc_buyable_shares(bar.close))


def load_bars():
    rows = []
    sources = []
    for path in sorted((ROOT / '.local/research/sse').glob('*.json')):
        data = json.loads(path.read_text())
        rows.extend(data['bars'])
        sources.append({'file': path.name, 'query': data['query'], 'trace_ids': data['trace_ids']})
    bars = [Bar(**row) for row in rows]
    dates = [bar.date for bar in bars]
    if len(dates) != len(set(dates)) or dates != sorted(dates):
        raise RuntimeError('Duplicate or unsorted trading days')
    if any(bar.open is None or bar.high is None or bar.low is None for bar in bars):
        raise RuntimeError('Incomplete OHLC')
    return bars, sources


def evaluate(bars, name, params, start, end, cost_multiplier=1.0):
    segment_end = [i for i, bar in enumerate(bars) if bar.date <= end][-1] + 1
    segment_start = next(i for i, bar in enumerate(bars) if bar.date >= start)
    window = bars[max(0, segment_start - 252):segment_end]
    if name == 'buy_hold':
        strategy = BuyHold(INITIAL, 0.0003 * cost_multiplier)
    elif name == 'index_trend':
        strategy = IndexTrendStrategy(INITIAL, 0.0003 * cost_multiplier, **params)
    else:
        strategy = make_strategy(name, initial_cash=INITIAL, fee_rate=0.0003 * cost_multiplier, **params)
    strategy.configure_execution(ExecutionConfig(
        lot_size=1, slippage_rate=0.0005 * cost_multiplier,
        min_commission=5 * cost_multiplier, stamp_duty_rate=0.0005 * cost_multiplier,
        transfer_fee_rate=0.00001 * cost_multiplier))
    result = strategy.run(window, start_date=start)
    equity = [p for p in result['equity_curve'] if p['date'] >= start]
    prices = [bar for bar in window if bar.date >= start]
    amounts = [p['equity'] for p in equity]
    returns = [amounts[i] / amounts[i-1] - 1 for i in range(1, len(amounts))]
    ret = amounts[-1] / INITIAL - 1
    annual = (1 + ret)**(252 / (len(amounts)-1)) - 1
    dd = _max_drawdown(amounts)
    sd = statistics.stdev(returns) if len(returns) > 1 else 0
    stats = {'start': equity[0]['date'], 'end': equity[-1]['date'], 'bars': len(equity),
             'total_return': ret, 'annual_return': annual, 'max_drawdown': dd,
             'sharpe': statistics.mean(returns) / sd * math.sqrt(252) if sd else 0,
             'trades': len(result['trades']), 'exposure': sum(p['position'] > 0 for p in equity)/len(equity),
             'benchmark_return': prices[-1].close / prices[0].close - 1}
    return stats, equity, result['trades']


def candidates():
    for fast, slow, buffer, stop in itertools.product([10, 20, 40], [60, 120, 200], [0.0, 0.01, 0.02], [0.08, 0.12, 0.16]):
        yield 'index_trend', dict(fast_window=fast, slow_window=slow, entry_buffer=buffer,
                                 exit_buffer=buffer, trailing_stop_pct=stop, position_fraction=1.0)
    for fast, slow in itertools.product([5, 10, 20, 40], [60, 120, 200]):
        yield 'moving_average', dict(fast_window=fast, slow_window=slow)
    for window, stop in itertools.product([5, 10, 20], [0.03, 0.06, 0.1]):
        yield 'channel_reversal', dict(channel_window=window, stop_loss_pct=stop)


def main():
    bars, sources = load_bars()
    output = ROOT / 'research/sse_timing_results.json'
    records = []
    for name, params in candidates():
        stats, _, _ = evaluate(bars, name, params, *SPLITS['train'])
        if stats['trades'] < 8:
            continue
        score = stats['annual_return'] - 0.5 * stats['max_drawdown']
        records.append({'strategy': name, 'params': params, 'train': stats, 'train_score': score})
    records.sort(key=lambda row: row['train_score'], reverse=True)
    finalists = records[:24]
    for row in finalists:
        stats, _, _ = evaluate(bars, row['strategy'], row['params'], *SPLITS['validation'])
        row['validation'] = stats
        row['selection_score'] = min(row['train']['annual_return'], stats['annual_return']) - 0.5 * max(row['train']['max_drawdown'], stats['max_drawdown'])
    finalists.sort(key=lambda row: row['selection_score'], reverse=True)
    # Selection is frozen on disk before evaluating any held-out observations.
    selection = {'method': 'Top 24 on train CAGR - 0.5*DD, then maximize min(train CAGR, validation CAGR) - 0.5*max(train DD, validation DD)',
                 'candidate_count': len(records), 'finalists': finalists, 'selected': finalists[0]}
    (ROOT / '.local/research/sse_selection_frozen.json').write_text(json.dumps(selection, ensure_ascii=False, indent=2))
    chosen = finalists[0]
    evaluations = {}
    curve = {}
    names = [('selected', chosen['strategy'], chosen['params']), ('buy_hold', 'buy_hold', {}),
             ('ma_20_120', 'moving_average', {'fast_window':20, 'slow_window':120})]
    if chosen['strategy'] == 'index_trend':
        names += [('selected_half', chosen['strategy'], {**chosen['params'], 'position_fraction':0.5})]
    for label, name, params in names:
        evaluations[label] = {'strategy': name, 'params': params, 'periods': {}}
        for period, (start, end) in SPLITS.items():
            stats, equity, trades = evaluate(bars, name, params, start, end)
            evaluations[label]['periods'][period] = stats
            if period == 'full':
                curve[label] = equity
            if period == 'holdout' and label == 'selected':
                (ROOT / '.local/research/sse_holdout_trades.json').write_text(json.dumps(trades, ensure_ascii=False, indent=2))
    sensitivity = []
    if chosen['strategy'] == 'index_trend':
        for slow in sorted({max(50, chosen['params']['slow_window'] - 20), chosen['params']['slow_window'], chosen['params']['slow_window'] + 20}):
            for stop in sorted({round(chosen['params']['trailing_stop_pct'] * v, 3) for v in [0.8, 1.0, 1.2]}):
                params = {**chosen['params'], 'slow_window':slow, 'trailing_stop_pct':stop}
                stats, _, _ = evaluate(bars, chosen['strategy'], params, *SPLITS['holdout'])
                sensitivity.append({'params': params, 'holdout':stats})
    stress, _, _ = evaluate(bars, chosen['strategy'], chosen['params'], *SPLITS['holdout'], cost_multiplier=2)
    yearly = []
    for year in range(2005, 2027):
        end = f'{year}-12-31' if year < 2026 else '2026-10-28'
        stats, _, _ = evaluate(bars, chosen['strategy'], chosen['params'], f'{year}-01-01', end)
        baseline, _, _ = evaluate(bars, 'buy_hold', {}, f'{year}-01-01', end)
        yearly.append({'year': year, 'strategy': stats, 'buy_hold':baseline})
    checksum = hashlib.sha256(json.dumps([bar.to_dict() for bar in bars], sort_keys=True).encode()).hexdigest()
    report = {'data': {'symbol':'000001.SH', 'source':'Iwencai OpenAPI', 'first':bars[0].date, 'last':bars[-1].date,
                       'count':len(bars), 'missing_volume_count':sum(bar.volume is None for bar in bars), 'sha256':checksum, 'sources':sources},
              'assumptions': {'initial_cash':INITIAL, 'lot_size':1, 'commission_rate':0.0003,
                              'slippage_rate':0.0005, 'min_commission':5, 'stamp_duty_rate':0.0005,
                              'transfer_fee_rate':0.00001, 'warmup_bars':252,
                              'cash_yield':0, 'dividends':False, 'execution':'next_bar_open',
                              'note':'Index-unit simulation, not ETF returns; no leverage/shorts; each evaluation period starts in cash.'},
              'selection':selection, 'evaluations':evaluations, 'holdout_cost_stress':stress,
              'holdout_sensitivity':sensitivity, 'yearly_independent_runs':yearly}
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (ROOT / '.local/research/sse_curves.json').write_text(json.dumps(curve, ensure_ascii=False))
    print(json.dumps({'selected':chosen, 'evaluations':evaluations, 'stress':stress}, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
