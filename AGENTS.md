# A股量化回测平台 - Agent Instructions

This platform is a local web server for strategy backtesting using natural language queries to Iwencai (问财) OpenAPI.

## Build and Run

- **Start Backend**: The primary entry point is `app.py`. Run it directly via Python.
  ```bash
  export IWENCAI_API_KEY="your_api_key"
  python app.py
  ```
  *(See [README.md](README.md) for full production startup script with MiniMax and MySQL variables).*
- **Dependencies**: Listed in `requirements.txt`. Requires `PyMySQL` and `DBUtils` if MySQL persistence is enabled.

## Architecture

- **Backend**: Python (Stdlib `http.server`, no frameworks like Flask/FastAPI).
  - [app.py](app.py): HTTP Server, routing, requests caching.
  - [backtester.py](backtester.py): Backtesting engine and strategy implementations.
  - [astock_api.py](astock_api.py) & [cli.py](cli.py): API wrappers for Iwencai OpenAPI.
  - [db.py](db.py): Conditional MySQL persistence logic.
- **Frontend**: Vanilla HTML/JS/CSS.
  - [static/app.js](static/app.js): Handles state, API calls, and ECharts rendering.
- **Database**: MySQL. Schema available at [mysql_schema.sql](mysql_schema.sql).

## Conventions

- **API Wrapping**: Always use [astock_api.py](astock_api.py) to interact with Iwencai, as it handles the strict header auth and trace IDs prescribed in [cli.py](cli.py).
- **Data Normalization**: `backtester.py` accepts and normalizes both English (`close`) and Chinese (`收盘价`) keys. Stick to this bilingual mapping convention when adding new fields.
- **Database Persistence**: Persistence is *optional* and conditional on `MYSQL_PERSIST_ENABLED=1`. Always degrade gracefully if the database or connection pool (`DBUtils`) is unavailable.
