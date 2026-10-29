"""Causality, sizing, warmup and service integration for index research."""
from datetime import date, timedelta
import importlib

import pytest

from quant.data.normalization import Bar
from quant.strategies import make_strategy
from quant.strategies.base import ExecutionConfig
from quant.errors import ValidationError


def bars(count=120):
    first = date(2024, 1, 1)
    return [Bar(date=(first+timedelta(days=i)).isoformat(), close=100+i,
                open=100+i, high=102+i, low=99+i, volume=1000) for i in range(count)]


def strategy():
    instance = make_strategy('sse_monthly_trend', initial_cash=100000,
                             trend_window=5, momentum_window=5, buffer_pct=0.0,
                             trailing_stop_pct=0.12, position_fraction=.5)
    instance.configure_execution(ExecutionConfig(lot_size=1))
    return instance


def test_entry_only_on_month_change_and_fill_next_open():
    result = strategy().run(bars())
    first = result['trades'][0]
    assert first['signal_date'] == '2024-02-01'
    assert first['date'] == '2024-02-02'
    assert first['shares'] * first['price'] < 51000


def test_future_price_changes_do_not_change_past_signals_or_trades():
    original = bars()
    prefix = 75
    modified = original[:prefix] + [Bar(date=b.date, close=b.close*2, open=b.open*2,
                                      high=b.high*2, low=b.low*2, volume=1000) for b in original[prefix:]]
    left, right = strategy().run(original), strategy().run(modified)
    assert left['equity_curve'][:prefix] == right['equity_curve'][:prefix]
    cutoff = original[prefix].date
    assert [t for t in left['trades'] if t['date'] < cutoff] == [t for t in right['trades'] if t['date'] < cutoff]


def test_risk_exit_can_trigger_between_monthly_checks_and_fills_next_day():
    history = bars(70)
    history[40] = Bar(date=history[40].date, close=110, open=140, high=141, low=109, volume=1000)
    result = strategy().run(history)
    sell = next(t for t in result['trades'] if t['side'] == 'sell')
    assert sell['signal_date'] == history[40].date
    assert sell['date'] == history[41].date


def test_warmup_computes_indicators_without_trading_or_counting_returns():
    result = strategy().run(bars(), start_date='2024-02-01')
    assert result['summary']['start_date'] == '2024-02-01'
    assert result['equity_curve'][0]['equity'] == 100000
    assert result['trades'][0]['signal_date'] == '2024-02-01'
    assert all(row['date'] >= '2024-02-01' for row in result['bars'])
    assert result['equity_curve'][0]['trend_ma'] is not None


def test_rerun_does_not_reuse_prior_peak_or_positions():
    instance = strategy()
    assert instance.run(bars()) == instance.run(bars())


@pytest.mark.parametrize('params', [{'buffer_pct':-.1}, {'trailing_stop_pct':0}, {'position_fraction':1.5}])
def test_invalid_risk_parameters_rejected(params):
    with pytest.raises(ValueError):
        make_strategy('sse_monthly_trend', initial_cash=100000, **params)


def test_index_mode_uses_single_simulation_unit(monkeypatch):
    service = importlib.import_module('quant.services.backtest')
    history = [Bar(**{**b.to_dict(), 'close':b.close*30, 'open':b.open*30,
                     'high':b.high*30, 'low':b.low*30}) for b in bars()]
    monkeypatch.setattr(service, '_fetch_history_by_year', lambda *a: {'datas':[b.to_dict() for b in history]})
    result = service.run_single_backtest(service.BacktestRequest(
        strategy='sse_monthly_trend', backtest_mode='index', index_symbol='sse',
        start_date='2024-02-01', end_date='2024-04-29', initial_cash=100000,
        strategy_params={'trend_window':5,'momentum_window':5,'buffer_pct':0.0},
    ))
    assert result['execution']['lot_size'] == 1
    assert result['summary']['instrument_type'] == 'synthetic_index'
    assert result['summary']['trade_count'] > 0
    assert result['summary']['start_date'] == '2024-02-01'
    assert result['symbol'] == '000001.SH'


def test_empty_evaluation_period_is_a_validation_error(monkeypatch):
    service = importlib.import_module('quant.services.backtest')
    monkeypatch.setattr(service, '_fetch_history_by_year', lambda *a: {'datas':[b.to_dict() for b in bars()]})
    with pytest.raises(ValidationError, match='评估区间'):
        service.run_single_backtest(service.BacktestRequest(
            strategy='sse_monthly_trend', backtest_mode='index', index_symbol='sse',
            start_date='2025-01-01', end_date='2025-04-29',
            strategy_params={'trend_window':5,'momentum_window':5},
        ))
