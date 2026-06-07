#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

: "${HOST:=127.0.0.1}"
: "${PORT:=8000}"
: "${MYSQL_PERSIST_ENABLED:=0}"
: "${MYSQL_AUTO_PERSIST:=0}"
: "${MYSQL_HOST:=127.0.0.1}"
: "${MYSQL_PORT:=3306}"
# MySQL 凭据不提供默认值，强制要求用户显式设置
: "${MYSQL_USER:=}"
: "${MYSQL_PASSWORD:=}"
: "${MYSQL_DATABASE:=quant_backtest}"
: "${PYTHONPYCACHEPREFIX:=/private/tmp/astock-pycache}"

export HOST PORT
export MYSQL_PERSIST_ENABLED MYSQL_AUTO_PERSIST
export MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE
export PYTHONPYCACHEPREFIX

if [[ -z "${IWENCAI_API_KEY:-}" ]]; then
  echo "错误: .env 中未设置 IWENCAI_API_KEY" >&2
  exit 1
fi

# 当 MySQL 持久化启用时强制要求提供凭据
if [[ "${MYSQL_PERSIST_ENABLED}" == "1" ]]; then
  if [[ -z "${MYSQL_USER}" || -z "${MYSQL_PASSWORD}" ]]; then
    echo "错误: 启用 MySQL 持久化时必须设置 MYSQL_USER 和 MYSQL_PASSWORD" >&2
    exit 1
  fi
fi

if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "错误: 端口 $PORT 已被占用，请先停止旧服务或在 .env 中设置 PORT=其他端口" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
fi

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "/usr/local/opt/python@3.10/bin/python3.10" ]]; then
    PYTHON_BIN="/usr/local/opt/python@3.10/bin/python3.10"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  else
    echo "错误: 未找到 python3，请先安装 Python" >&2
    exit 1
  fi
fi

echo "启动 A股量化回测平台: http://${HOST}:${PORT}"
echo "MySQL 持久化: ${MYSQL_PERSIST_ENABLED}, 自动持久化: ${MYSQL_AUTO_PERSIST}, 数据库: ${MYSQL_DATABASE}"
exec "$PYTHON_BIN" app.py
