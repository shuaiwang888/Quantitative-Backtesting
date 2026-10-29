"""Download a bounded, auditable daily SSE index history through the project's SDK."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import _load_dotenv
from quant.data.iwencai import fetch_all
from quant.data.normalization import build_history_query, normalize_bars


def main():
    _load_dotenv()
    target = ROOT / '.local/research/sse'
    target.mkdir(parents=True, exist_ok=True)
    for year in range(2004, 2027):
        path = target / f'{year}.json'
        if path.exists():
            continue
        end = f'{year}-12-31' if year < 2026 else '2026-10-28'
        text = build_history_query('000001.SH', f'{year}-01-01', end)
        response = fetch_all(text, max_pages=4, limit=100)
        bars = normalize_bars(response.get('datas', []))
        bars = [bar for bar in bars if f'{year}-01-01' <= bar.date <= end]
        if len(bars) < 180:
            raise RuntimeError(f'{year}: insufficient daily bars: {len(bars)}')
        if any(bar.code not in ('000001', '000001.SH', '') for bar in bars):
            raise RuntimeError('Unexpected security in response')
        payload = {'query': text, 'source': 'Iwencai OpenAPI', 'fetched_on': date.today().isoformat(),
                   'trace_ids': response.get('trace_ids', []), 'bars': [bar.to_dict() for bar in bars]}
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f'{year}: {len(bars)} bars, {bars[0].date} .. {bars[-1].date}', flush=True)


if __name__ == '__main__':
    main()
