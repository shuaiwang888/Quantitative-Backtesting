/**
 * 技术指标库 —— 纯 JS O(n) 预计算
 *
 * 与 quant/indicators/* (Python) 对齐；返回 {values, latest}
 *   values: number[] —— 长度与 closes 一致，前 period-1 个为 null
 *   latest: 末根 bar 的指标值 + 信号文案/颜色
 *
 * 信号文案统一格式：
 *   MA:    "多头排列" / "空头排列" / "多头" / "空头" / "--"
 *   MACD:  "金叉" / "死叉" / "多头" / "空头" / "--"
 *   KDJ:   "金叉" / "死叉" / "超买" / "超卖" / "--"
 *   RSI:   "超买" / "超卖" / "强势" / "弱势" / "--"
 */

const UP = "var(--up-color)";
const DOWN = "var(--down-color)";
const NEUTRAL = "var(--text-secondary)";
const ACCENT = "var(--accent)";

/**
 * 朴素滑窗前缀和 O(n) MA。
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
export function ma(closes, period) {
  if (!Array.isArray(closes) || closes.length === 0) return [];
  const n = closes.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    if (typeof c !== "number" || !Number.isFinite(c)) {
      out[i] = null;
      continue;
    }
    sum += c;
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 算 MA 趋势：MA5/10/20 顺序排列 + 价格 vs MA5。
 * @returns {{trend: string, color: string}}
 */
export function maTrend(closes, period5 = 5, period10 = 10, period20 = 20) {
  const m5 = ma(closes, period5);
  const m10 = ma(closes, period10);
  const m20 = ma(closes, period20);
  const last = closes.length - 1;
  if (m5[last] == null || m10[last] == null || m20[last] == null) {
    return { trend: "--", color: NEUTRAL, m5, m10, m20 };
  }
  const above20 = closes[last] > m20[last];
  const bull = m5[last] > m10[last] && m10[last] > m20[last] && above20;
  const bear = m5[last] < m10[last] && m10[last] < m20[last] && !above20;
  if (bull) return { trend: "多头排列", color: UP, m5, m10, m20 };
  if (bear) return { trend: "空头排列", color: DOWN, m5, m10, m20 };
  return { trend: above20 ? "多头" : "空头", color: above20 ? UP : DOWN, m5, m10, m20 };
}

/**
 * EMA —— MACD/信号线 内部用。
 * @returns {number[]} 长度与 values 一致；前 period-1 个为 null；之后 EMA 值
 */
function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const n = values.length;
  const out = new Array(n).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let smaSeed = null;
  let seedCount = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      out[i] = null;
      continue;
    }
    if (i < period - 1) {
      // 累加 SMA 种子
      if (smaSeed == null) smaSeed = 0;
      smaSeed += v;
      seedCount++;
      out[i] = null;
      continue;
    }
    if (prev == null) {
      // 第一次：SMA 种子 + 当前值
      if (seedCount === period - 1) {
        prev = (smaSeed + v) / period;
      } else {
        // 补齐种子（中间有空值情况）
        prev = v;
      }
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/**
 * MACD(12, 26, 9)
 * @returns {{
 *   dif: number[], dea: number[], hist: number[],
 *   latest: {dif, dea, hist, cross: string, color: string}
 * }}
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const n = closes.length;
  const dif = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) {
      dif[i] = emaFast[i] - emaSlow[i];
    }
  }
  // DEA = DIF 的 EMA —— 但 DIF 前面有 null，ema 函数已能处理（累加种子用到的就是非 null 位置）
  // 这里直接用 ema 即可
  const dea = ema(dif, signal);
  const hist = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (dif[i] != null && dea[i] != null) {
      hist[i] = (dif[i] - dea[i]) * 2;
    }
  }

  const last = n - 1;
  if (last < 1 || dif[last] == null || dea[last] == null) {
    return {
      dif, dea, hist,
      latest: { dif: null, dea: null, hist: null, cross: "--", color: NEUTRAL },
    };
  }

  // 信号：上一根 vs 这一根的金叉/死叉
  let cross = "--";
  let color = NEUTRAL;
  const prevDif = dif[last - 1];
  const prevDea = dea[last - 1];
  if (prevDif != null && prevDea != null) {
    if (prevDif <= prevDea && dif[last] > dea[last]) {
      cross = "金叉";
      color = UP;
    } else if (prevDif >= prevDea && dif[last] < dea[last]) {
      cross = "死叉";
      color = DOWN;
    } else if (hist[last] != null && hist[last] > 0) {
      cross = "多头";
      color = UP;
    } else if (hist[last] != null && hist[last] < 0) {
      cross = "空头";
      color = DOWN;
    }
  }

  return {
    dif, dea, hist,
    latest: { dif: dif[last], dea: dea[last], hist: hist[last], cross, color },
  };
}

/**
 * 滚动 n 日最高 / 最低（O(n) 双端队列）；KDJ 用。
 */
function rollingHigh(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const deque = []; // 存 index；队首 = 当前最大
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    while (deque.length && values[deque[deque.length - 1]] <= v) deque.pop();
    deque.push(i);
    if (deque[0] <= i - period) deque.shift();
    if (i >= period - 1) out[i] = values[deque[0]];
  }
  return out;
}

function rollingLow(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const deque = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    while (deque.length && values[deque[deque.length - 1]] >= v) deque.pop();
    deque.push(i);
    if (deque[0] <= i - period) deque.shift();
    if (i >= period - 1) out[i] = values[deque[0]];
  }
  return out;
}

/**
 * SMA —— KDJ 用（处理含 null 的数组，前 period-1 个输出 null）。
 */
function smaIgnoreNull(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  let count = 0;
  const window = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    window.push(v);
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      count++;
    }
    if (window.length > period) {
      const old = window.shift();
      if (typeof old === "number" && Number.isFinite(old)) {
        sum -= old;
        count--;
      }
    }
    if (window.length === period && count === period) {
      out[i] = sum / period;
    }
  }
  return out;
}

/**
 * KDJ(9, 3, 3)
 * @returns {{
 *   k: number[], d: number[], j: number[],
 *   latest: {k, d, j, status: string, color: string}
 * }}
 */
export function kdj(highs, lows, closes, n = 9, m1 = 3, m2 = 3) {
  const len = closes.length;
  const rsv = new Array(len).fill(null);
  const hh = rollingHigh(highs, n);
  const ll = rollingLow(lows, n);
  for (let i = 0; i < len; i++) {
    if (hh[i] != null && ll[i] != null) {
      const range = hh[i] - ll[i];
      rsv[i] = range > 0 ? ((closes[i] - ll[i]) / range) * 100 : 50;
    }
  }
  const k = smaIgnoreNull(rsv, m1);
  const d = smaIgnoreNull(k, m2);
  const j = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (k[i] != null && d[i] != null) j[i] = 3 * k[i] - 2 * d[i];
  }

  const last = len - 1;
  if (last < 1 || k[last] == null || d[last] == null) {
    return { k, d, j, latest: { k: null, d: null, j: null, status: "--", color: NEUTRAL } };
  }

  let status = "--";
  let color = NEUTRAL;
  const prevK = k[last - 1];
  const prevD = d[last - 1];
  if (prevK != null && prevD != null) {
    if (prevK <= prevD && k[last] > d[last]) { status = "金叉"; color = UP; }
    else if (prevK >= prevD && k[last] < d[last]) { status = "死叉"; color = DOWN; }
    else if (j[last] != null && j[last] > 100) { status = "超买"; color = DOWN; }
    else if (j[last] != null && j[last] < 0) { status = "超卖"; color = UP; }
    else if (k[last] > d[last]) { status = "多头"; color = UP; }
    else { status = "空头"; color = DOWN; }
  }
  return { k, d, j, latest: { k: k[last], d: d[last], j: j[last], status, color } };
}

/**
 * RSI(14) —— Wilder 平滑。
 * @returns {{
 *   values: number[],
 *   latest: {value, status: string, color: string}
 * }}
 */
export function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) {
    return { values: out, latest: { value: null, status: "--", color: NEUTRAL } };
  }
  let gainSum = 0;
  let lossSum = 0;
  // 种子：前 period 个差值的均值
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const firstRs = avgLoss > 0 ? avgGain / avgLoss : Infinity;
  out[period] = avgLoss > 0 ? 100 - 100 / (1 + firstRs) : 100;
  // Wilder 平滑后续
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss > 0 ? avgGain / avgLoss : Infinity;
    out[i] = avgLoss > 0 ? 100 - 100 / (1 + rs) : 100;
  }

  const last = n - 1;
  const value = out[last];
  if (value == null) {
    return { values: out, latest: { value: null, status: "--", color: NEUTRAL } };
  }
  let status = "--";
  let color = NEUTRAL;
  if (value >= 70) { status = "超买"; color = DOWN; }
  else if (value <= 30) { status = "超卖"; color = UP; }
  else if (value >= 50) { status = "强势"; color = UP; }
  else { status = "弱势"; color = DOWN; }
  return { values: out, latest: { value, status, color } };
}

// 数字格式化
export function fmt(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  return Number(value).toFixed(digits);
}

export { UP, DOWN, NEUTRAL, ACCENT };
