"""Second, explicitly exploratory study after the first candidate failed the 2021+ test."""
import itertools
import json
from pathlib import Path
from study_sse_timing import load_bars, evaluate, SPLITS

ROOT = Path(__file__).resolve().parents[1]
NAME = 'sse_monthly_trend'

def main():
    bars, _ = load_bars()
    candidates = []
    for trend, momentum, buffer, stop in itertools.product([120, 200, 250], [63, 126, 252], [0.0, 0.01], [0.08, 0.12, 0.18]):
        params = dict(trend_window=trend, momentum_window=momentum, buffer_pct=buffer,
                      trailing_stop_pct=stop, position_fraction=1.0)
        train, _, _ = evaluate(bars, NAME, params, *SPLITS['train'])
        validation, _, _ = evaluate(bars, NAME, params, *SPLITS['validation'])
        score = min(train['annual_return'], validation['annual_return']) - .5 * max(train['max_drawdown'], validation['max_drawdown'])
        candidates.append({'params':params, 'train':train, 'validation':validation, 'score':score})
    candidates.sort(key=lambda row: row['score'], reverse=True)
    selected = candidates[0]
    (ROOT / '.local/research/sse_monthly_selection.json').write_text(json.dumps(selected, indent=2))
    models = {'selected':selected['params'], 'half':{**selected['params'], 'position_fraction':.5},
              'prior_fixed':dict(trend_window=200, momentum_window=126, buffer_pct=.01,
                                 trailing_stop_pct=.12, position_fraction=1.0)}
    results = {}
    for label, params in models.items():
        results[label] = {'params':params, 'periods':{}}
        for split, dates in SPLITS.items():
            stats, equity, _ = evaluate(bars, NAME, params, *dates)
            results[label]['periods'][split] = stats
            if split == 'full':
                (ROOT / f'.local/research/sse_monthly_curve_{label}.json').write_text(json.dumps(equity))
    baseline = {}
    for split, dates in SPLITS.items():
        baseline[split] = evaluate(bars, 'buy_hold', {}, *dates)[0]
    stress = evaluate(bars, NAME, selected['params'], *SPLITS['holdout'], cost_multiplier=2)[0]
    yearly = []
    for year in range(2017, 2027):
        dates = (f'{year}-01-01', f'{year}-12-31' if year < 2026 else '2026-10-28')
        yearly.append({'year':year, 'half':evaluate(bars, NAME, models['half'], *dates)[0],
                       'full':evaluate(bars, NAME, models['selected'], *dates)[0],
                       'buy_hold':evaluate(bars, 'buy_hold', {}, *dates)[0]})
    result = {'yearly_independent_checks':yearly, 'note':'Exploratory second family. 2021+ aggregate results had already been seen in the failed daily-trend study; this is not a pristine holdout.',
              'count':len(candidates), 'selected':selected, 'candidates':candidates,
              'models':results, 'buy_hold':baseline, 'cost_stress':stress}
    (ROOT / 'research/sse_monthly_results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({k:v for k,v in result.items() if k != 'candidates'}, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
