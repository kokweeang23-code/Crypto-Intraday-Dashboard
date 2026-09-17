/**
 * CryptoQuant insight engine — sole reader of CRYPTOQUANT_API_KEY.
 * Optionally reads CG_API_KEY for CoinGlass long/short account ratios.
 * Fetches documented v2 CQ aggregated swap endpoints, computes DERIVED
 * metrics, and returns series + stats + insights text for the dashboard.
 *
 * Documented CQ endpoints (https://docs.cryptoquant.com):
 *   GET /v2/market/cq/swap/ohlcv
 *   GET /v2/market/cq/swap/liquidation
 *   GET /v2/market/cq/swap/trade
 *   GET /v2/market/cq/swap/funding-rate
 *   GET /v2/market/cq/swap/open-interest
 *
 * Optional CoinGlass (https://open-api-v4.coinglass.com):
 *   GET /api/futures/global-long-short-account-ratio/history
 *   GET /api/futures/top-long-short-account-ratio/history
 */

'use strict';

const CQ_BASE = 'https://api.cryptoquant.com/v2';

/** Optional CoinGlass v4 open API base (long/short ratios). */
const CG_BASE = 'https://open-api-v4.coinglass.com';

/** Allowed CQ aggregation windows (market data). */
const ALLOWED_WINDOWS = Object.freeze(['day', 'hour', '10min', 'min']);

/** Default CQ aggregate symbols commonly used for all-exchange swap data. */
const ALLOWED_SYMBOL_PATTERN = /^[a-z0-9]{2,16}_[a-z0-9]{2,16}$/;

/** EMA periods used for regime detection (documented as DERIVED). */
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 26;

/** Number of price bins for volume-at-price histogram (DERIVED). */
const VAP_BIN_COUNT = 24;

/** Chop band: close within this fraction of slow EMA → chop regime. */
const CHOP_BAND = 0.0025;

/**
 * Returns the CryptoQuant API key from the environment.
 * Never expose this value to the client.
 * @returns {string}
 */
function getApiKey() {
  const key = process.env.CRYPTOQUANT_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) {
    const err = new Error('CRYPTOQUANT_API_KEY is not set');
    err.statusCode = 503;
    err.code = 'CONFIG_ERROR';
    throw err;
  }
  return key.trim();
}

/**
 * Parses and validates insight request parameters from query or body.
 * Rejects unknown keys and unsafe values server-side.
 * @param {Record<string, unknown>} raw
 * @returns {{ symbol: string, window: string, from: string|null, to: string|null, limit: number }}
 */
function validateInsightParams(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('Request parameters must be an object');
  }

  const symbolRaw = raw.symbol != null ? String(raw.symbol).trim().toLowerCase() : 'btc_all';
  if (!ALLOWED_SYMBOL_PATTERN.test(symbolRaw)) {
    throw validationError(
      'Invalid symbol. Use CQ aggregate form like btc_all or eth_all (lowercase alphanumeric + underscore).'
    );
  }

  const windowRaw = raw.window != null ? String(raw.window).trim() : 'min';
  if (!ALLOWED_WINDOWS.includes(windowRaw)) {
    throw validationError(`Invalid window. Allowed: ${ALLOWED_WINDOWS.join(', ')}`);
  }

  const from = normalizeOptionalDatetime(raw.from, 'from', windowRaw);
  const to = normalizeOptionalDatetime(raw.to, 'to', windowRaw);

  let limit = 1440;
  if (raw.limit != null && raw.limit !== '') {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      throw validationError('Invalid limit. Must be an integer from 1 to 10000');
    }
    limit = n;
  }

  return { symbol: symbolRaw, window: windowRaw, from, to, limit };
}

/**
 * Normalizes an optional CQ from/to datetime string.
 * Day window accepts YYYYMMDD; others require YYYYMMDDTHHMMSS.
 * @param {unknown} value
 * @param {string} fieldName
 * @param {string} window
 * @returns {string|null}
 */
function normalizeOptionalDatetime(value, fieldName, window) {
  if (value == null || value === '') {
    return null;
  }
  const s = String(value).trim();
  const dayOk = /^\d{8}$/;
  const fullOk = /^\d{8}T\d{6}$/;
  if (window === 'day') {
    if (!dayOk.test(s) && !fullOk.test(s)) {
      throw validationError(`Invalid ${fieldName}. Use YYYYMMDD or YYYYMMDDTHHMMSS`);
    }
  } else if (!fullOk.test(s)) {
    throw validationError(`Invalid ${fieldName}. Use YYYYMMDDTHHMMSS for window=${window}`);
  }
  return s;
}

/**
 * Creates a validation error with HTTP-friendly status.
 * @param {string} message
 * @returns {Error}
 */
function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  return err;
}

/**
 * Builds periods-per-year for annualized realized volatility by window.
 * @param {string} window
 * @returns {number}
 */
function periodsPerYear(window) {
  switch (window) {
    case 'min':
      return 365.25 * 24 * 60;
    case '10min':
      return 365.25 * 24 * 6;
    case 'hour':
      return 365.25 * 24;
    case 'day':
      return 365.25;
    default:
      return 365.25 * 24 * 60;
  }
}

/**
 * Fetches a CryptoQuant v2 market path with Bearer auth.
 * @param {string} path - Path under /v2 (e.g. /market/cq/swap/ohlcv)
 * @param {Record<string, string|number>} query
 * @returns {Promise<object[]>}
 */
async function fetchCq(path, query) {
  const key = getApiKey();
  const url = new URL(CQ_BASE + path);
  Object.entries(query).forEach(([k, v]) => {
    if (v != null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body && body.status && body.status.message) ||
      `CryptoQuant HTTP ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status === 401 || res.status === 403 ? 502 : 502;
    err.upstreamStatus = res.status;
    throw err;
  }

  if (!body || !body.status || body.status.code !== 200) {
    const msg = (body && body.status && body.status.message) || 'Unexpected CQ response';
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  const data = body.result && Array.isArray(body.result.data) ? body.result.data : [];
  return data;
}

/**
 * Batches the five documented CQ swap endpoints for one refresh.
 * Native CQ only: ohlcv, liquidation, trade, funding-rate, open-interest.
 * @param {{ symbol: string, window: string, from: string|null, to: string|null, limit: number }} params
 * @returns {Promise<{ ohlcv: object[], liquidation: object[], trade: object[], funding: object[], openInterest: object[] }>}
 */
async function fetchAllMarketSeries(params) {
  const query = {
    symbol: params.symbol,
    window: params.window,
    limit: params.limit,
  };
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;

  const [ohlcv, liquidation, trade, funding, openInterest] = await Promise.all([
    fetchCq('/market/cq/swap/ohlcv', query),
    fetchCq('/market/cq/swap/liquidation', query),
    fetchCq('/market/cq/swap/trade', query),
    fetchCq('/market/cq/swap/funding-rate', query),
    fetchCq('/market/cq/swap/open-interest', query),
  ]);

  return { ohlcv, liquidation, trade, funding, openInterest };
}

/**
 * Returns the optional CoinGlass API key, or null when unset.
 * Never expose this value to the client.
 * @returns {string|null}
 */
function getCgApiKey() {
  const key = process.env.CG_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) {
    return null;
  }
  return key.trim();
}

/**
 * Maps a CQ aggregate symbol (e.g. btc_all / eth_all) to a CoinGlass pair.
 * ETH* → ETHUSDT; everything else defaults to BTCUSDT per product brief.
 * @param {string} cqSymbol
 * @returns {string}
 */
function mapCqSymbolToCgPair(cqSymbol) {
  const raw = String(cqSymbol || 'btc_all').trim().toLowerCase();
  // Brief: ETHUSDT when CQ symbol starts with eth; else BTCUSDT.
  if (raw.startsWith('eth')) {
    return 'ETHUSDT';
  }
  return 'BTCUSDT';
}

/**
 * Maps a CQ window to a CoinGlass interval.
 * min/10min → 15m, hour → 1h, day → 1d.
 * @param {string} window
 * @returns {string}
 */
function mapCqWindowToCgInterval(window) {
  switch (window) {
    case 'min':
    case '10min':
      return '15m';
    case 'hour':
      return '1h';
    case 'day':
      return '1d';
    default:
      return '15m';
  }
}

/**
 * Unwraps a CoinGlass v4 { code, msg, data } envelope into a row array.
 * @param {unknown} body
 * @returns {object[]}
 */
function unwrapCgData(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (!body || typeof body !== 'object') {
    return [];
  }
  const data = body.data;
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === 'object') {
    for (const key of ['list', 'data', 'history']) {
      if (Array.isArray(data[key])) {
        return data[key];
      }
    }
  }
  return [];
}

/**
 * Converts a CoinGlass time field (ms or seconds) to an ISO datetime string.
 * @param {unknown} t
 * @returns {string|null}
 */
function cgTimeToDatetime(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

/**
 * Picks the first finite numeric value among candidate field names on a row.
 * @param {object} row
 * @param {string[]} keys
 * @returns {number|null}
 */
function pickFiniteNumber(row, keys) {
  for (const key of keys) {
    if (row[key] == null || row[key] === '') continue;
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Normalizes one CoinGlass L/S history row into the dashboard series shape.
 * Accepts both short field names and v4 global_/top_account_* aliases.
 * @param {object} row
 * @returns {{ datetime: string, long_percent: number, short_percent: number, long_short_ratio: number }|null}
 */
function normalizeLsRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const datetime = cgTimeToDatetime(
    row.create_time ?? row.time ?? row.t ?? row.timestamp ?? row.datetime
  );
  const longPercent = pickFiniteNumber(row, [
    'long_percent',
    'global_account_long_percent',
    'top_account_long_percent',
    'longAccount',
    'long_account',
  ]);
  const shortPercent = pickFiniteNumber(row, [
    'short_percent',
    'global_account_short_percent',
    'top_account_short_percent',
    'shortAccount',
    'short_account',
  ]);
  let ratio = pickFiniteNumber(row, [
    'long_short_ratio',
    'global_account_long_short_ratio',
    'top_account_long_short_ratio',
    'longShortRatio',
    'ratio',
  ]);
  if (ratio == null && longPercent != null && shortPercent != null && shortPercent !== 0) {
    ratio = longPercent / shortPercent;
  }
  if (!datetime || longPercent == null || shortPercent == null || ratio == null) {
    return null;
  }
  return {
    datetime,
    long_percent: longPercent,
    short_percent: shortPercent,
    long_short_ratio: ratio,
  };
}

/**
 * Fetches one CoinGlass L/S history endpoint and normalizes rows.
 * @param {string} path - Absolute path under CG_BASE
 * @param {{ exchange: string, symbol: string, interval: string, limit: number }} query
 * @param {string} apiKey
 * @returns {Promise<object[]>}
 */
async function fetchCgLsHistory(path, query, apiKey) {
  const url = new URL(CG_BASE + path);
  Object.entries(query).forEach(([k, v]) => {
    if (v != null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'CG-API-KEY': apiKey,
      Accept: 'application/json',
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body && (body.msg || body.message)) ||
      `CoinGlass HTTP ${res.status}`;
    throw new Error(String(msg).slice(0, 200));
  }

  // CoinGlass success codes are typically "0" (string) or 0
  if (body && body.code != null && String(body.code) !== '0') {
    const msg = body.msg || body.message || `CoinGlass code ${body.code}`;
    throw new Error(String(msg).slice(0, 200));
  }

  const rows = unwrapCgData(body);
  const cleaned = [];
  rows.forEach((row) => {
    const norm = normalizeLsRow(row);
    if (norm) cleaned.push(norm);
  });
  cleaned.sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
  return cleaned;
}

/**
 * Optionally fetches CoinGlass global + top-trader long/short account ratios.
 * Never throws: missing key or upstream failure → available:false with safe error.
 * @param {{ symbol: string, window: string, limit: number }} params
 * @returns {Promise<{
 *   available: boolean,
 *   error?: string,
 *   pair?: string,
 *   interval?: string,
 *   lsGlobal: object[],
 *   lsTop: object[],
 * }>}
 */
async function fetchCoinGlassLongShort(params) {
  const apiKey = getCgApiKey();
  if (!apiKey) {
    return { available: false, lsGlobal: [], lsTop: [] };
  }

  const pair = mapCqSymbolToCgPair(params.symbol);
  const interval = mapCqWindowToCgInterval(params.window);
  const limit = Math.max(1, Math.min(Number(params.limit) || 1440, 1000));
  const query = {
    exchange: 'Binance',
    symbol: pair,
    interval,
    limit,
  };

  try {
    const [lsGlobal, lsTop] = await Promise.all([
      fetchCgLsHistory(
        '/api/futures/global-long-short-account-ratio/history',
        query,
        apiKey
      ),
      fetchCgLsHistory(
        '/api/futures/top-long-short-account-ratio/history',
        query,
        apiKey
      ),
    ]);
    const available = lsGlobal.length > 0 || lsTop.length > 0;
    const out = {
      available,
      pair,
      interval,
      lsGlobal,
      lsTop,
    };
    if (!available) {
      out.error = 'empty CoinGlass L/S response';
    }
    return out;
  } catch (err) {
    const message = (err && err.message) ? String(err.message).slice(0, 200) : 'CoinGlass request failed';
    // Scrub accidental key material from logs/messages
    const safe = message.replace(/CG-API-KEY\s*[:=]?\s*\S+/gi, 'CG-API-KEY=[REDACTED]');
    console.warn('CoinGlass L/S fetch failed:', safe);
    return {
      available: false,
      error: safe,
      pair,
      interval,
      lsGlobal: [],
      lsTop: [],
    };
  }
}

/**
 * Builds latest L/S snapshot stats from a normalized series (or null).
 * @param {object[]} series
 * @returns {{ long_percent: number, short_percent: number, long_short_ratio: number, datetime: string }|null}
 */
function latestLsSnapshot(series) {
  if (!Array.isArray(series) || !series.length) {
    return null;
  }
  const last = series[series.length - 1];
  return {
    long_percent: last.long_percent,
    short_percent: last.short_percent,
    long_short_ratio: last.long_short_ratio,
    datetime: last.datetime,
  };
}

/**
 * Plain-English long/short panel text from CoinGlass global + top snapshots.
 * @param {{ available: boolean, error?: string, lsGlobalLatest: object|null, lsTopLatest: object|null, pair?: string }} cg
 * @returns {string}
 */
function describeLongShort(cg) {
  if (!cg || !cg.available) {
    if (cg && cg.error) {
      return `Long/short (CoinGlass): unavailable (${cg.error}).`;
    }
    return 'Long/short (CoinGlass): skipped — CG_API_KEY not set.';
  }
  const parts = [];
  if (cg.lsGlobalLatest) {
    const g = cg.lsGlobalLatest;
    parts.push(
      `Global accounts L/S ${g.long_short_ratio.toFixed(2)} ` +
        `(long ${g.long_percent.toFixed(1)}% / short ${g.short_percent.toFixed(1)}%)`
    );
  }
  if (cg.lsTopLatest) {
    const t = cg.lsTopLatest;
    parts.push(
      `Top traders L/S ${t.long_short_ratio.toFixed(2)} ` +
        `(long ${t.long_percent.toFixed(1)}% / short ${t.short_percent.toFixed(1)}%)`
    );
  }
  if (!parts.length) {
    return 'Long/short (CoinGlass): no usable rows.';
  }
  const pairNote = cg.pair ? ` on Binance ${cg.pair}` : '';
  return `Long/short (CoinGlass${pairNote}): ${parts.join('; ')}.`;
}


/**
 * Sorts rows ascending by datetime string.
 * @param {object[]} rows
 * @returns {object[]}
 */
function sortByDatetimeAsc(rows) {
  return [...rows].sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
}

/**
 * Computes Exponential Moving Average of close prices.
 * DERIVED — not a CryptoQuant published series.
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]}
 */
function computeEma(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period || period < 1) {
    return out;
  }
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) {
    sum += closes[i];
  }
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * Classifies EMA regime from price vs slow EMA (and fast/slow relationship).
 * DERIVED — periods: fast=9, slow=26.
 * @param {number} close
 * @param {number|null} emaFast
 * @param {number|null} emaSlow
 * @returns {'bull'|'bear'|'chop'|'unknown'}
 */
function classifyEmaRegime(close, emaFast, emaSlow) {
  if (emaFast == null || emaSlow == null || !Number.isFinite(close)) {
    return 'unknown';
  }
  const dist = Math.abs(close - emaSlow) / emaSlow;
  if (dist <= CHOP_BAND) {
    return 'chop';
  }
  if (close > emaSlow && emaFast >= emaSlow) {
    return 'bull';
  }
  if (close < emaSlow && emaFast <= emaSlow) {
    return 'bear';
  }
  return 'chop';
}

/**
 * Builds CVD series: cumulative sum of (base_buy_volume - base_sell_volume).
 * DERIVED — CVD is not a native CQ field.
 * @param {object[]} tradeRows
 * @returns {{ datetime: string, delta: number, cvd: number }[]}
 */
function computeCvd(tradeRows) {
  const sorted = sortByDatetimeAsc(tradeRows);
  let cvd = 0;
  return sorted.map((row) => {
    const buy = Number(row.base_buy_volume) || 0;
    const sell = Number(row.base_sell_volume) || 0;
    const delta = buy - sell;
    cvd += delta;
    return {
      datetime: row.datetime,
      delta,
      cvd,
      buy_ratio: row.buy_ratio != null ? Number(row.buy_ratio) : null,
      sell_ratio: row.sell_ratio != null ? Number(row.sell_ratio) : null,
    };
  });
}

/**
 * Builds OHLCV + EMA overlay series and latest regime.
 * DERIVED for EMA fields.
 * @param {object[]} ohlcvRows
 * @returns {{ series: object[], regime: string, emaFastPeriod: number, emaSlowPeriod: number }}
 */
function computeEmaRegimeSeries(ohlcvRows) {
  const sorted = sortByDatetimeAsc(ohlcvRows);
  const closes = sorted.map((r) => Number(r.close));
  const emaFast = computeEma(closes, EMA_FAST_PERIOD);
  const emaSlow = computeEma(closes, EMA_SLOW_PERIOD);

  const series = sorted.map((row, i) => {
    const close = closes[i];
    const ef = emaFast[i];
    const es = emaSlow[i];
    return {
      datetime: row.datetime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close,
      volume: Number(row.volume) || 0,
      quote_volume: Number(row.quote_volume) || 0,
      ema_fast: ef,
      ema_slow: es,
      regime: classifyEmaRegime(close, ef, es),
    };
  });

  const last = series.length ? series[series.length - 1] : null;
  return {
    series,
    regime: last ? last.regime : 'unknown',
    emaFastPeriod: EMA_FAST_PERIOD,
    emaSlowPeriod: EMA_SLOW_PERIOD,
  };
}

/**
 * Bins OHLCV volume by typical price (H+L+C)/3 into a volume-at-price profile.
 * DERIVED candle proxy — true VAP needs tick/order-book data.
 * @param {object[]} ohlcvRows
 * @param {number} [binCount=VAP_BIN_COUNT]
 * @returns {{ bins: { priceLow: number, priceHigh: number, priceMid: number, volume: number }[], caveat: string }}
 */
function computeVolumeAtPrice(ohlcvRows, binCount = VAP_BIN_COUNT) {
  const caveat =
    'DERIVED candle proxy: volume is attributed to each bar\'s typical price (H+L+C)/3. ' +
    'True volume-at-price requires tick or order-book data; this is not a CQ published metric.';

  if (!ohlcvRows.length) {
    return { bins: [], caveat };
  }

  const points = ohlcvRows.map((r) => {
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    const typical = (h + l + c) / 3;
    const vol = Number(r.volume) || 0;
    return { typical, vol };
  }).filter((p) => Number.isFinite(p.typical) && p.vol > 0);

  if (!points.length) {
    return { bins: [], caveat };
  }

  let minP = points[0].typical;
  let maxP = points[0].typical;
  points.forEach((p) => {
    if (p.typical < minP) minP = p.typical;
    if (p.typical > maxP) maxP = p.typical;
  });

  if (minP === maxP) {
    return {
      bins: [{ priceLow: minP, priceHigh: maxP, priceMid: minP, volume: points.reduce((s, p) => s + p.vol, 0) }],
      caveat,
    };
  }

  const width = (maxP - minP) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => {
    const priceLow = minP + i * width;
    const priceHigh = i === binCount - 1 ? maxP : priceLow + width;
    return {
      priceLow,
      priceHigh,
      priceMid: (priceLow + priceHigh) / 2,
      volume: 0,
    };
  });

  points.forEach((p) => {
    let idx = Math.floor((p.typical - minP) / width);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].volume += p.vol;
  });

  return { bins, caveat };
}

/**
 * Computes annualized realized volatility from log returns of close.
 * DERIVED — not a CryptoQuant published volatility index.
 * @param {object[]} ohlcvRows
 * @param {string} window
 * @returns {{ series: { datetime: string, close: number, logReturn: number|null, realizedVol: number|null }[], latest: number|null, periodsPerYear: number, caveat: string }}
 */
function computeVolatilityIndex(ohlcvRows, window) {
  const caveat =
    'DERIVED annualized realized volatility from log returns of OHLCV close ' +
    `(stdev * sqrt(periods_per_year=${periodsPerYear(window)})). Not a CQ published index.`;

  const sorted = sortByDatetimeAsc(ohlcvRows);
  const ppy = periodsPerYear(window);
  const series = [];
  const logReturns = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const close = Number(sorted[i].close);
    let logReturn = null;
    if (i > 0) {
      const prev = Number(sorted[i - 1].close);
      if (prev > 0 && close > 0) {
        logReturn = Math.log(close / prev);
        logReturns.push(logReturn);
      }
    }
    series.push({
      datetime: sorted[i].datetime,
      close,
      logReturn,
      realizedVol: null,
    });
  }

  // Rolling 60-bar annualized vol when possible; else full-sample.
  const roll = Math.min(60, Math.max(10, Math.floor(sorted.length / 4) || 10));
  for (let i = 0; i < series.length; i += 1) {
    if (i < 1) continue;
    const start = Math.max(1, i - roll + 1);
    const slice = [];
    for (let j = start; j <= i; j += 1) {
      if (series[j].logReturn != null) slice.push(series[j].logReturn);
    }
    if (slice.length >= 2) {
      series[i].realizedVol = annualizeStdev(slice, ppy);
    }
  }

  const fullSample =
    logReturns.length >= 2 ? annualizeStdev(logReturns, ppy) : null;

  return {
    series,
    latest: series.length ? series[series.length - 1].realizedVol : fullSample,
    fullSample,
    periodsPerYear: ppy,
    caveat,
  };
}

/**
 * Annualizes sample standard deviation of log returns.
 * @param {number[]} returns
 * @param {number} ppy
 * @returns {number}
 */
function annualizeStdev(returns, ppy) {
  const n = returns.length;
  const mean = returns.reduce((s, x) => s + x, 0) / n;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = returns[i] - mean;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / (n - 1));
  return stdev * Math.sqrt(ppy);
}

/**
 * Summarizes liquidation series for the price+liq panel.
 * @param {object[]} liqRows
 * @returns {object}
 */
function summarizeLiquidations(liqRows) {
  const sorted = sortByDatetimeAsc(liqRows);
  let longUsd = 0;
  let shortUsd = 0;
  let longBase = 0;
  let shortBase = 0;
  let count = 0;

  const series = sorted.map((r) => {
    const lUsd = Number(r.long_liquidations_usd) || 0;
    const sUsd = Number(r.short_liquidations_usd) || 0;
    const lBase = Number(r.long_liquidations) || 0;
    const sBase = Number(r.short_liquidations) || 0;
    longUsd += lUsd;
    shortUsd += sUsd;
    longBase += lBase;
    shortBase += sBase;
    count += Number(r.liquidation_count) || 0;
    return {
      datetime: r.datetime,
      long_liquidations: lBase,
      short_liquidations: sBase,
      long_liquidations_usd: lUsd,
      short_liquidations_usd: sUsd,
      liquidation_count: Number(r.liquidation_count) || 0,
      avg_price: r.avg_price != null ? Number(r.avg_price) : null,
    };
  });

  const netUsd = shortUsd - longUsd;
  let bias = 'balanced';
  if (longUsd > shortUsd * 1.2) bias = 'longs_liquidated';
  else if (shortUsd > longUsd * 1.2) bias = 'shorts_liquidated';

  return {
    series,
    totals: {
      long_liquidations_usd: longUsd,
      short_liquidations_usd: shortUsd,
      long_liquidations: longBase,
      short_liquidations: shortBase,
      liquidation_count: count,
      net_short_minus_long_usd: netUsd,
      bias,
    },
  };
}

/**
 * Normalizes native CQ funding-rate rows and computes latest + sample change.
 * Native CQ field `funding_rate` (not DERIVED): positive = longs pay shorts.
 * @param {object[]} fundingRows
 * @returns {{ series: { datetime: string, funding_rate: number }[], latest: number|null, change: number|null }}
 */
function summarizeFunding(fundingRows) {
  const sorted = sortByDatetimeAsc(fundingRows);
  const series = sorted.map((r) => ({
    datetime: r.datetime,
    funding_rate: Number(r.funding_rate),
  })).filter((r) => Number.isFinite(r.funding_rate));

  const latest = series.length ? series[series.length - 1].funding_rate : null;
  // Sample change: latest minus earliest bar in the returned window (easy delta lookback).
  let change = null;
  if (series.length >= 2) {
    change = series[series.length - 1].funding_rate - series[0].funding_rate;
    // Trim binary float noise for typical funding magnitudes.
    change = Number(change.toPrecision(12));
  }

  return { series, latest, change };
}

/**
 * Normalizes native CQ open-interest rows and computes latest + optional pct change.
 * Native CQ field `open_interest` (not DERIVED).
 * @param {object[]} oiRows
 * @returns {{ series: { datetime: string, open_interest: number }[], latest: number|null, changePct: number|null }}
 */
function summarizeOpenInterest(oiRows) {
  const sorted = sortByDatetimeAsc(oiRows);
  const series = sorted.map((r) => ({
    datetime: r.datetime,
    open_interest: Number(r.open_interest),
  })).filter((r) => Number.isFinite(r.open_interest));

  const latest = series.length ? series[series.length - 1].open_interest : null;
  const first = series.length ? series[0].open_interest : null;
  const changePct =
    latest != null && first != null && first !== 0
      ? ((latest - first) / first) * 100
      : null;

  return { series, latest, changePct };
}

/**
 * Builds human-readable insight paragraphs for UI and Telegram.
 * Funding and open interest notes use native CQ fields (not DERIVED).
 * Long/short panel uses optional CoinGlass data when available.
 * @param {object} ctx
 * @returns {{ executive: string, panels: { priceLiq: string, vap: string, cvdEma: string, vol: string, funding: string, openInterest: string, longShort: string } }}
 */
function buildInsightsText(ctx) {
  const {
    symbol,
    window,
    price,
    priceChangePct,
    liq,
    cvd,
    regime,
    vap,
    vol,
    funding,
    openInterest,
    coinglass,
  } = ctx;

  const priceStr = price != null ? formatNum(price, 2) : 'n/a';
  const chg =
    priceChangePct != null
      ? `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`
      : 'n/a';

  const liqBias =
    liq.totals.bias === 'longs_liquidated'
      ? 'Long liquidations dominate — cascade risk on dips if leverage remains elevated.'
      : liq.totals.bias === 'shorts_liquidated'
        ? 'Short liquidations dominate — squeezes can extend upside momentum.'
        : 'Long/short liquidations are roughly balanced.';

  const cvdLast = cvd.length ? cvd[cvd.length - 1].cvd : null;
  const cvdStart = cvd.length ? cvd[0].cvd : null;
  const cvdTrend =
    cvdLast != null && cvdStart != null
      ? cvdLast > cvdStart
        ? 'rising (net taker-buy pressure)'
        : cvdLast < cvdStart
          ? 'falling (net taker-sell pressure)'
          : 'flat'
      : 'unknown';

  const peakBin = vap.bins.reduce(
    (best, b) => (b.volume > (best ? best.volume : -1) ? b : best),
    null
  );
  const vapNote = peakBin
    ? `Highest candle-proxy volume near ${formatNum(peakBin.priceMid, 2)} (DERIVED).`
    : 'Insufficient volume for VAP bins.';

  const volPct =
    vol.latest != null ? `${(vol.latest * 100).toFixed(1)}% ann.` : 'n/a';

  const fundingNote = describeFunding(funding.latest, funding.change);
  const oiNote = describeOpenInterest(openInterest.latest, openInterest.changePct);
  const lsNote = describeLongShort(coinglass || { available: false });

  const executiveParts = [
    `${symbol.toUpperCase()} intraday (${window}): last ${priceStr} (${chg}).`,
    `EMA regime (DERIVED ${EMA_FAST_PERIOD}/${EMA_SLOW_PERIOD}): ${regime}.`,
    `CVD (DERIVED): ${cvdTrend}.`,
    `Liq bias: ${liq.totals.bias.replace(/_/g, ' ')} ` +
      `(L $${formatCompact(liq.totals.long_liquidations_usd)} / S $${formatCompact(liq.totals.short_liquidations_usd)}).`,
    fundingNote,
    oiNote,
  ];
  if (coinglass && coinglass.available) {
    executiveParts.push(lsNote);
  }
  executiveParts.push(`Realized vol (DERIVED): ${volPct}.`, vapNote);

  const executive = executiveParts.join(' ');

  return {
    executive,
    panels: {
      priceLiq:
        `Price ${priceStr} (${chg}). ${liqBias} ` +
        `Events: ${liq.totals.liquidation_count}.`,
      vap: `${vapNote} ${vap.caveat}`,
      cvdEma:
        `CVD is DERIVED as cumsum(base_buy_volume − base_sell_volume); trend ${cvdTrend}. ` +
        `EMA regime DERIVED from close vs EMA${EMA_SLOW_PERIOD} (fast EMA${EMA_FAST_PERIOD}): ${regime}.`,
      vol: `Volatility index DERIVED: ${volPct}. ${vol.caveat}`,
      funding: fundingNote,
      openInterest: oiNote,
      longShort: lsNote,
    },
  };
}

/**
 * Plain-language funding note from native CQ funding_rate.
 * Positive = longs pay shorts; negative = shorts pay longs.
 * @param {number|null} latest
 * @param {number|null} change
 * @returns {string}
 */
function describeFunding(latest, change) {
  if (latest == null || !Number.isFinite(latest)) {
    return 'Funding (CQ): n/a.';
  }
  const who =
    latest > 0
      ? 'longs pay shorts (bullish leverage tilt)'
      : latest < 0
        ? 'shorts pay longs (bearish leverage tilt)'
        : 'balanced (near zero)';
  const chgStr =
    change != null && Number.isFinite(change)
      ? ` Sample Δ ${change >= 0 ? '+' : ''}${formatFundingRate(change)}.`
      : '';
  return `Funding (CQ): ${formatFundingRate(latest)} — ${who}.${chgStr}`;
}

/**
 * Plain-language open-interest note from native CQ open_interest.
 * @param {number|null} latest
 * @param {number|null} changePct
 * @returns {string}
 */
function describeOpenInterest(latest, changePct) {
  if (latest == null || !Number.isFinite(latest)) {
    return 'Open interest (CQ): n/a.';
  }
  const trend =
    changePct == null
      ? ''
      : changePct > 0.5
        ? ' Rising OI — new leverage entering.'
        : changePct < -0.5
          ? ' Falling OI — positions closing or liquidated.'
          : ' OI roughly flat over the sample.';
  const pctStr =
    changePct != null
      ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% over sample)`
      : '';
  return `Open interest (CQ): $${formatCompact(latest)}${pctStr}.${trend}`;
}

/**
 * Formats a funding rate with enough precision for typical CQ magnitudes.
 * @param {number} n
 * @returns {string}
 */
function formatFundingRate(n) {
  const abs = Math.abs(n);
  if (abs >= 0.01) return n.toFixed(4);
  if (abs >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}

/**
 * Formats a number with fixed decimals and thousands separators.
 * @param {number} n
 * @param {number} digits
 * @returns {string}
 */
function formatNum(n, digits) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Formats large USD figures compactly (e.g. 1.2M).
 * @param {number} n
 * @returns {string}
 */
function formatCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/**
 * Main entry: validate params, batch CQ calls, compute derived metrics, insights.
 * Also exposes native CQ funding_rate and open_interest series/stats.
 * @param {Record<string, unknown>} rawParams
 * @returns {Promise<object>}
 */
async function getInsight(rawParams) {
  const params = validateInsightParams(rawParams || {});
  // CQ is required; CoinGlass is best-effort and must not fail the insight.
  const [{ ohlcv, liquidation, trade, funding, openInterest }, cgRaw] =
    await Promise.all([
      fetchAllMarketSeries(params),
      fetchCoinGlassLongShort(params),
    ]);

  const priceSeries = sortByDatetimeAsc(ohlcv).map((r) => ({
    datetime: r.datetime,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume) || 0,
    quote_volume: Number(r.quote_volume) || 0,
  }));

  const lastClose = priceSeries.length ? priceSeries[priceSeries.length - 1].close : null;
  const firstClose = priceSeries.length ? priceSeries[0].close : null;
  const priceChangePct =
    lastClose != null && firstClose != null && firstClose !== 0
      ? ((lastClose - firstClose) / firstClose) * 100
      : null;

  const liq = summarizeLiquidations(liquidation);
  const cvdSeries = computeCvd(trade);
  const ema = computeEmaRegimeSeries(ohlcv);
  const vap = computeVolumeAtPrice(ohlcv);
  const vol = computeVolatilityIndex(ohlcv, params.window);
  const fundingSummary = summarizeFunding(funding);
  const oiSummary = summarizeOpenInterest(openInterest);

  const lsGlobalLatest = latestLsSnapshot(cgRaw.lsGlobal);
  const lsTopLatest = latestLsSnapshot(cgRaw.lsTop);
  const coinglassStats = {
    available: Boolean(cgRaw.available),
  };
  if (cgRaw.pair) coinglassStats.pair = cgRaw.pair;
  if (cgRaw.interval) coinglassStats.interval = cgRaw.interval;
  if (cgRaw.error) coinglassStats.error = cgRaw.error;

  const insights = buildInsightsText({
    symbol: params.symbol,
    window: params.window,
    price: lastClose,
    priceChangePct,
    liq,
    cvd: cvdSeries,
    regime: ema.regime,
    vap,
    vol,
    funding: fundingSummary,
    openInterest: oiSummary,
    coinglass: {
      available: coinglassStats.available,
      error: cgRaw.error,
      pair: cgRaw.pair,
      lsGlobalLatest,
      lsTopLatest,
    },
  });

  const sources = [
    {
      id: 'cryptoquant',
      required: true,
      baseUrl: CQ_BASE,
      endpoints: [
        '/market/cq/swap/ohlcv',
        '/market/cq/swap/liquidation',
        '/market/cq/swap/trade',
        '/market/cq/swap/funding-rate',
        '/market/cq/swap/open-interest',
      ],
    },
    {
      id: 'coinglass',
      required: false,
      optional: true,
      available: coinglassStats.available,
      baseUrl: CG_BASE,
      endpoints: [
        '/api/futures/global-long-short-account-ratio/history',
        '/api/futures/top-long-short-account-ratio/history',
      ],
      note: 'Optional — enabled when CG_API_KEY is set; failures do not block CQ insight.',
    },
  ];

  return {
    ok: true,
    params,
    series: {
      price: priceSeries,
      liquidation: liq.series,
      cvd: cvdSeries,
      ema: ema.series,
      volumeAtPrice: vap.bins,
      volatility: vol.series,
      funding: fundingSummary.series,
      openInterest: oiSummary.series,
      lsGlobal: cgRaw.lsGlobal,
      lsTop: cgRaw.lsTop,
    },
    stats: {
      lastPrice: lastClose,
      priceChangePct,
      liquidationTotals: liq.totals,
      emaRegime: ema.regime,
      emaPeriods: { fast: ema.emaFastPeriod, slow: ema.emaSlowPeriod },
      cvdLatest: cvdSeries.length ? cvdSeries[cvdSeries.length - 1].cvd : null,
      volatilityLatest: vol.latest,
      volatilityFullSample: vol.fullSample,
      fundingLatest: fundingSummary.latest,
      fundingChange: fundingSummary.change,
      openInterestLatest: oiSummary.latest,
      openInterestChangePct: oiSummary.changePct,
      lsGlobalLatest,
      lsTopLatest,
      coinglass: coinglassStats,
      sampleCounts: {
        ohlcv: ohlcv.length,
        liquidation: liquidation.length,
        trade: trade.length,
        funding: funding.length,
        openInterest: openInterest.length,
        lsGlobal: cgRaw.lsGlobal.length,
        lsTop: cgRaw.lsTop.length,
      },
    },
    insights,
    meta: {
      source: 'cryptoquant',
      sources,
      baseUrl: CQ_BASE,
      endpoints: [
        '/market/cq/swap/ohlcv',
        '/market/cq/swap/liquidation',
        '/market/cq/swap/trade',
        '/market/cq/swap/funding-rate',
        '/market/cq/swap/open-interest',
      ],
      derived: {
        cvd: {
          derived: true,
          formula: 'cumsum(base_buy_volume - base_sell_volume)',
          note: 'Not a native CryptoQuant field; computed from /market/cq/swap/trade.',
        },
        emaRegime: {
          derived: true,
          formula: `EMA(${EMA_FAST_PERIOD}) / EMA(${EMA_SLOW_PERIOD}) of OHLCV close; regime = bull|bear|chop vs slow EMA`,
          periods: { fast: EMA_FAST_PERIOD, slow: EMA_SLOW_PERIOD },
          chopBand: CHOP_BAND,
          note: 'Not a CryptoQuant published indicator.',
        },
        volumeAtPrice: {
          derived: true,
          formula: 'bin OHLCV volume by typical price (H+L+C)/3',
          binCount: VAP_BIN_COUNT,
          caveat: vap.caveat,
        },
        volatilityIndex: {
          derived: true,
          formula: `annualized realized vol = stdev(log returns) * sqrt(${vol.periodsPerYear})`,
          periodsPerYear: vol.periodsPerYear,
          caveat: vol.caveat,
        },
      },
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  getInsight,
  validateInsightParams,
  // Exported for unit-style reuse / testing without leaking the key path to clients
  computeCvd,
  computeEma,
  computeVolumeAtPrice,
  computeVolatilityIndex,
  summarizeFunding,
  summarizeOpenInterest,
  fetchCoinGlassLongShort,
  mapCqSymbolToCgPair,
  mapCqWindowToCgInterval,
  normalizeLsRow,
};
