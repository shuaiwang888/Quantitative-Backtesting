/**
 * 把 iwencai 行转成 SymbolChartModal 的 target。
 *
 * 统一用 "日期范围 + 字段白名单 + 每日行情" 的 query 模板（与回测模块一致），
 * 适用于个股和指数，能稳定返回完整 OHLCV。
 *
 * 用法：
 *   import { buildChartTarget } from "../utils/chart.js";
 *   const target = buildChartTarget(row, "stock");
 *   if (target) setChartTarget(target);
 *
 * 返回：{ name, symbol, type, query } 或 null（行无名称时）
 *   type: "stock" | "index"（影响后端解析）
 */

export function buildChartTarget(row, type) {
  const name = row["股票简称"] || row["指数简称"];
  if (!name || name === "--") return null;
  const code = row["股票代码"] || row["code"] || "";
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const query = `${name} ${fmt(start)}到${fmt(end)} 每日行情 交易日期 开盘价 最高价 最低价 收盘价 成交量`;
  return { name, symbol: code, type, query };
}