/**
 * BTC market-structure series from CoinGlass v4 open-api.
 * Sole reader of CG_API_KEY for /api/structure (keys never leave this module).
 *
 * Documented CoinGlass endpoints (https://open-api-v4.coinglass.com):
 *   GET /api/futures/price/history
 *   GET /api/futures/aggregated-cvd/history
 *   GET /api/spot/aggregated-cvd/history
 *   GET /api/futures/funding-rate/oi-weight-history
 *   GET /api/futures/open-interest/aggregated-history
 *   GET /api/futures/orderbook/aggregated-ask-bids-history  (bid/ask delta)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CG_BASE = 'https://open-api-v4.coinglass.com';

/** Default multi-exchange list for aggregated CVD / orderbook. */
const DEFAULT_EXCHANGE_LIST = 'Binance,OKX,Bybit';

/** Price pair exchange (single-exchange OHLC). */
const DEFAULT_PRICE_EXCHANGE = 'Binance';

/** Depth % for aggregated bid/ask (±range). */
const DEFAULT_ORDERBOOK_RANGE = '1';

const ALLOWED_INTERVALS = Object.freeze(['30m', '1h', '4h', '1d']);
const ALLOWED_SYMBOL_PATTERN = /^[A-Z]{2,12}$/;

const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'structure_log.jsonl');

/**
 * Returns the CoinGlass API key from the environment.
 * Never expose this value to the client.
 * @returns {string}
 */
function getCgApiKey() {
  const key = process.env.CG_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) {
    const err = new Error('CG_API_KEY is not set');
    err.statusCode = 503;
    err.code = 'CONFIG_ERROR';
    throw err;
  }
  return key.trim();
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
 * Parses and validates structure request parameters.
 * @param {Record<string, unknown>} raw
 * @returns {{
 *   symbol: string,
 *   pair: string,
 *   interval: string,
 *   limit: number,
 *   exchangeList: string,
 *   priceExchange: string,
 *   range: string,
 * }}
 */
function validateStructureParams(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('Request parameters must be an object');
  }

  const symbolRaw = raw.symbol != null ? String(raw.symbol).trim().toUpperCase() : 'BTC';
  if (!ALLOWED_SYMBOL_PATTERN.test(symbolRaw)) {
    throw validationError('Invalid symbol. Use a coin ticker like BTC or ETH.');
  }

  const intervalRaw = raw.interval != null ? String(raw.interval).trim() : '30m';
  if (!ALLOWED_INTERVALS.includes(intervalRaw)) {
    throw validationError(`Invalid interval. Allowed: ${ALLOWED_INTERVALS.join(', ')}`);
  }

  let limit = 672; // ~14 days at 30m
  if (raw.limit != null && raw.limit !== '') {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw validationError('Invalid limit. Must be an integer from 1 to 1000');
    }
    limit = n;
  }

  const exchangeList =
    raw.exchange_list != null && String(raw.exchange_list).trim()
      ? String(raw.exchange_list).trim()
      : DEFAULT_EXCHANGE_LIST;

  const priceExchange =
    raw.price_exchange != null && String(raw.price_exchange).trim()
      ? String(raw.price_exchange).trim()
      : DEFAULT_PRICE_EXCHANGE;

  const range =
    raw.range != null && String(raw.range).trim()
      ? String(raw.range).trim()
      : DEFAULT_ORDERBOOK_RANGE;

  return {
    symbol: symbolRaw,
    pair: `${symbolRaw}USDT`,
    interval: intervalRaw,
    limit,
    exchangeList,
    priceExchange,
    range,
  };
}

/**
 * Unwraps a CoinGlass v4 { code, msg, data } envelope into a row array.
 * @param {unknown} body
 * @returns {object[]}
 */
function unwrapCgData(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const data = body.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['list', 'data', 'history']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

/**
 * Converts a CoinGlass time field (ms or seconds) to epoch milliseconds.
 * @param {unknown} t
 * @returns {number|null}
 */
function cgTimeToMs(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Picks the first finite numeric value among candidate field names.
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
 * Scrubs accidental key material from error messages.
 * @param {string} message
 * @returns {string}
 */
function scrubMessage(message) {
  return String(message || '')
    .replace(/CG-API-KEY\s*[:=]?\s*\S+/gi, 'CG-API-KEY=[REDACTED]')
    .slice(0, 240);
}

/**
 * Fetches one CoinGlass GET path and returns normalized row array.
 * @param {string} pathName - Absolute path under CG_BASE
 * @param {Record<string, string|number>} query
 * @param {string} apiKey
 * @returns {Promise<object[]>}
 */
async function fetchCg(pathName, query, apiKey) {
  const url = new URL(CG_BASE + pathName);
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
    const err = new Error(scrubMessage(msg));
    err.statusCode = 502;
    err.upstreamStatus = res.status;
    throw err;
  }

  if (body && body.code != null && String(body.code) !== '0') {
    const msg = body.msg || body.message || `CoinGlass code ${body.code}`;
    const err = new Error(scrubMessage(msg));
    err.statusCode = 502;
    err.upstreamCode = body.code;
    throw err;
  }

  return unwrapCgData(body);
}

/**
 * Builds a Map of epoch-ms → value from raw CG rows.
 * @param {object[]} rows
 * @param {(row: object) => number|null} valueFn
 * @returns {Map<number, number>}
 */
function rowsToTimeMap(rows, valueFn) {
  const map = new Map();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const t = cgTimeToMs(
      row.time ?? row.create_time ?? row.t ?? row.timestamp ?? row.datetime
    );
    const v = valueFn(row);
    if (t == null || v == null) return;
    map.set(t, v);
  });
  return map;
}

/**
 * Fetches all structure series in parallel. Bid/ask is best-effort:
 * failure → bidAskAvailable:false, series bidAskDelta null.
 * @param {ReturnType<typeof validateStructureParams>} params
 * @param {string} apiKey
 * @returns {Promise<{
 *   price: Map<number, number>,
 *   futCvd: Map<number, number>,
 *   spotCvd: Map<number, number>,
 *   funding: Map<number, number>,
 *   oi: Map<number, number>,
 *   bidAskDelta: Map<number, number>,
 *   bidAskAvailable: boolean,
 *   bidAskError: string|null,
 *   errors: Record<string, string>,
 * }>}
 */
async function fetchAllStructureMaps(params, apiKey) {
  const { symbol, pair, interval, limit, exchangeList, priceExchange, range } = params;
  const errors = {};

  const tasks = {
    price: () =>
      fetchCg(
        '/api/futures/price/history',
        { exchange: priceExchange, symbol: pair, interval, limit },
        apiKey
      ).then((rows) =>
        rowsToTimeMap(rows, (r) =>
          pickFiniteNumber(r, ['close', 'c', 'price'])
        )
      ),
    futCvd: () =>
      fetchCg(
        '/api/futures/aggregated-cvd/history',
        {
          exchange_list: exchangeList,
          symbol,
          interval,
          limit,
          unit: 'usd',
        },
        apiKey
      ).then((rows) =>
        rowsToTimeMap(rows, (r) =>
          pickFiniteNumber(r, ['cum_vol_delta', 'cvd', 'cumVolDelta'])
        )
      ),
    spotCvd: () =>
      fetchCg(
        '/api/spot/aggregated-cvd/history',
        {
          exchange_list: exchangeList,
          symbol,
          interval,
          limit,
          unit: 'usd',
        },
        apiKey
      ).then((rows) =>
        rowsToTimeMap(rows, (r) =>
          pickFiniteNumber(r, ['cum_vol_delta', 'cvd', 'cumVolDelta'])
        )
      ),
    funding: () =>
      fetchCg(
        '/api/futures/funding-rate/oi-weight-history',
        { symbol, interval, limit },
        apiKey
      ).then((rows) =>
        rowsToTimeMap(rows, (r) =>
          pickFiniteNumber(r, ['close', 'funding_rate', 'oi_weight_funding_rate'])
        )
      ),
    oi: () =>
      fetchCg(
        '/api/futures/open-interest/aggregated-history',
        { symbol, interval, limit, unit: 'usd' },
        apiKey
      ).then((rows) =>
        rowsToTimeMap(rows, (r) =>
          pickFiniteNumber(r, ['close', 'open_interest', 'oi'])
        )
      ),
  };

  const settled = await Promise.all(
    Object.entries(tasks).map(async ([name, fn]) => {
      try {
        const map = await fn();
        return { name, map, error: null };
      } catch (err) {
        const message = scrubMessage((err && err.message) || `${name} failed`);
        errors[name] = message;
        console.warn(`structure ${name} fetch failed:`, message);
        return { name, map: new Map(), error: message };
      }
    })
  );

  const out = {
    price: new Map(),
    futCvd: new Map(),
    spotCvd: new Map(),
    funding: new Map(),
    oi: new Map(),
    bidAskDelta: new Map(),
    bidAskAvailable: false,
    bidAskError: null,
    errors,
  };

  settled.forEach(({ name, map }) => {
    out[name] = map;
  });

  // Bid/ask aggregate delta — optional; plan/interval may block it.
  try {
    const rows = await fetchCg(
      '/api/futures/orderbook/aggregated-ask-bids-history',
      {
        exchange_list: exchangeList,
        symbol,
        interval,
        limit,
        range,
      },
      apiKey
    );
    out.bidAskDelta = rowsToTimeMap(rows, (r) => {
      const bids = pickFiniteNumber(r, [
        'aggregated_bids_usd',
        'bids_usd',
        'aggregatedBidsUsd',
      ]);
      const asks = pickFiniteNumber(r, [
        'aggregated_asks_usd',
        'asks_usd',
        'aggregatedAsksUsd',
      ]);
      if (bids == null || asks == null) return null;
      return bids - asks;
    });
    out.bidAskAvailable = out.bidAskDelta.size > 0;
    if (!out.bidAskAvailable) {
      out.bidAskError = 'empty CoinGlass bid/ask response';
    }
  } catch (err) {
    out.bidAskError = scrubMessage((err && err.message) || 'bid/ask fetch failed');
    out.bidAskAvailable = false;
    console.warn('structure bidAsk fetch failed:', out.bidAskError);
  }

  return out;
}

/**
 * Merges time maps into aligned structure rows sorted by t ascending.
 * Uses the union of all timestamps so overlays line up when present.
 * @param {{
 *   price: Map<number, number>,
 *   futCvd: Map<number, number>,
 *   spotCvd: Map<number, number>,
 *   funding: Map<number, number>,
 *   oi: Map<number, number>,
 *   bidAskDelta: Map<number, number>,
 * }} maps
 * @returns {{ t: number, price: number|null, futCvd: number|null, spotCvd: number|null, funding: number|null, oi: number|null, bidAskDelta: number|null }[]}
 */
function mergeStructureSeries(maps) {
  const times = new Set();
  ['price', 'futCvd', 'spotCvd', 'funding', 'oi', 'bidAskDelta'].forEach((key) => {
    const m = maps[key];
    if (m && typeof m.forEach === 'function') {
      m.forEach((_, t) => times.add(t));
    }
  });

  const sorted = [...times].sort((a, b) => a - b);
  return sorted.map((t) => ({
    t,
    price: maps.price.has(t) ? maps.price.get(t) : null,
    futCvd: maps.futCvd.has(t) ? maps.futCvd.get(t) : null,
    spotCvd: maps.spotCvd.has(t) ? maps.spotCvd.get(t) : null,
    funding: maps.funding.has(t) ? maps.funding.get(t) : null,
    oi: maps.oi.has(t) ? maps.oi.get(t) : null,
    bidAskDelta: maps.bidAskDelta.has(t) ? maps.bidAskDelta.get(t) : null,
  }));
}

/**
 * Latest non-null sample for a field from series (walking backwards).
 * @param {object[]} series
 * @param {string} field
 * @returns {number|null}
 */
function latestField(series, field) {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i][field];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Ensures data/ exists and appends one JSONL snapshot line.
 * @param {object} record
 * @returns {{ path: string, bytes: number }}
 */
function appendStructureLog(record) {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  return { path: LOG_FILE, bytes: Buffer.byteLength(line, 'utf8') };
}

/**
 * Reads the last N JSONL snapshot records (best-effort; skips bad lines).
 * @param {number} [maxLines=48]
 * @returns {object[]}
 */
function readStructureLog(maxLines = 48) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const slice = lines.slice(-Math.max(1, maxLines));
  const out = [];
  slice.forEach((line) => {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* skip corrupt line */
    }
  });
  return out;
}

/**
 * Main entry: validate, fetch CoinGlass series, normalize, optional log.
 * @param {Record<string, unknown>} rawParams
 * @param {{ appendLog?: boolean }} [opts]
 * @returns {Promise<object>}
 */
async function getStructure(rawParams, opts = {}) {
  const params = validateStructureParams(rawParams || {});
  const apiKey = getCgApiKey();
  const maps = await fetchAllStructureMaps(params, apiKey);
  const series = mergeStructureSeries(maps);

  const coreCounts = {
    price: maps.price.size,
    futCvd: maps.futCvd.size,
    spotCvd: maps.spotCvd.size,
    funding: maps.funding.size,
    oi: maps.oi.size,
  };
  const anyCore = Object.values(coreCounts).some((n) => n > 0);
  if (!anyCore) {
    const detail = Object.keys(maps.errors).length
      ? Object.entries(maps.errors)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ')
      : 'all CoinGlass series empty';
    const err = new Error(`No structure data returned (${detail})`);
    err.statusCode = 502;
    err.code = 'UPSTREAM_EMPTY';
    throw err;
  }

  const latest = {
    t: series.length ? series[series.length - 1].t : null,
    price: latestField(series, 'price'),
    futCvd: latestField(series, 'futCvd'),
    spotCvd: latestField(series, 'spotCvd'),
    funding: latestField(series, 'funding'),
    oi: latestField(series, 'oi'),
    bidAskDelta: latestField(series, 'bidAskDelta'),
  };

  let logInfo = null;
  if (opts.appendLog) {
    const record = {
      loggedAt: new Date().toISOString(),
      symbol: params.symbol,
      interval: params.interval,
      exchangeList: params.exchangeList,
      ...latest,
    };
    logInfo = appendStructureLog(record);
  }

  return {
    ok: true,
    params,
    series,
    latest,
    stats: {
      sampleCounts: {
        ...coreCounts,
        bidAskDelta: maps.bidAskDelta.size,
        aligned: series.length,
      },
      bidAskAvailable: maps.bidAskAvailable,
      bidAskError: maps.bidAskError,
      seriesErrors: maps.errors,
    },
    meta: {
      source: 'coinglass',
      baseUrl: CG_BASE,
      endpoints: [
        '/api/futures/price/history',
        '/api/futures/aggregated-cvd/history',
        '/api/spot/aggregated-cvd/history',
        '/api/futures/funding-rate/oi-weight-history',
        '/api/futures/open-interest/aggregated-history',
        '/api/futures/orderbook/aggregated-ask-bids-history',
      ],
      bidAsk: {
        available: maps.bidAskAvailable,
        path: '/api/futures/orderbook/aggregated-ask-bids-history',
        formula: 'aggregated_bids_usd - aggregated_asks_usd',
        note: maps.bidAskError || null,
      },
      log: logInfo,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Fetches fresh structure and appends one JSONL snapshot (for cron / CLI).
 * @param {Record<string, unknown>} [rawParams]
 * @returns {Promise<object>}
 */
async function snapshotStructure(rawParams) {
  return getStructure(rawParams || {}, { appendLog: true });
}

module.exports = {
  getStructure,
  snapshotStructure,
  validateStructureParams,
  appendStructureLog,
  readStructureLog,
  LOG_FILE,
  ALLOWED_INTERVALS,
};
