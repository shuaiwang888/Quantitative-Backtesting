CREATE DATABASE IF NOT EXISTS quant_backtest
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE quant_backtest;

CREATE TABLE IF NOT EXISTS securities (
  symbol VARCHAR(32) NOT NULL COMMENT '证券代码，例如 300033.SZ、000300.SH',
  name VARCHAR(128) NOT NULL DEFAULT '' COMMENT '证券名称',
  asset_type VARCHAR(32) NOT NULL DEFAULT 'stock' COMMENT 'stock/index/fund/unknown',
  exchange VARCHAR(16) NOT NULL DEFAULT '' COMMENT '交易所后缀，例如 SZ/SH',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol),
  KEY idx_name (name),
  KEY idx_asset_type (asset_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_bars (
  symbol VARCHAR(32) NOT NULL COMMENT '证券代码',
  trade_date DATE NOT NULL COMMENT '交易日期',
  name VARCHAR(128) NOT NULL DEFAULT '' COMMENT '证券名称',
  open DECIMAL(18, 6) NULL,
  high DECIMAL(18, 6) NULL,
  low DECIMAL(18, 6) NULL,
  close DECIMAL(18, 6) NOT NULL,
  volume DECIMAL(24, 4) NULL,
  amount DECIMAL(24, 4) NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'iwencai',
  query_text TEXT NULL COMMENT '产生该数据的问财查询语句',
  raw_json JSON NULL COMMENT '预留原始扩展字段',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, trade_date),
  KEY idx_trade_date (trade_date),
  KEY idx_symbol_date (symbol, trade_date),
  CONSTRAINT fk_daily_bars_symbol FOREIGN KEY (symbol) REFERENCES securities(symbol)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS indicator_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  symbol VARCHAR(32) NOT NULL COMMENT '证券代码',
  snapshot_date DATE NOT NULL DEFAULT '1970-01-01' COMMENT '指标日期，无法识别时使用 1970-01-01',
  name VARCHAR(128) NOT NULL DEFAULT '' COMMENT '证券名称',
  query_hash CHAR(64) NOT NULL COMMENT '查询语句 SHA256',
  query_text TEXT NOT NULL COMMENT '问财查询语句',
  metrics_json JSON NOT NULL COMMENT '问财返回的全部指标字段和值',
  source VARCHAR(64) NOT NULL DEFAULT 'iwencai',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_symbol_query_date (symbol, query_hash, snapshot_date),
  KEY idx_symbol_snapshot (symbol, snapshot_date),
  KEY idx_query_hash (query_hash),
  CONSTRAINT fk_indicator_symbol FOREIGN KEY (symbol) REFERENCES securities(symbol)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
