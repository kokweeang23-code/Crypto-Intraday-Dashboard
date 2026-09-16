/**
 * Express server: static public/ + GET/POST /api/insight.
 * API keys never leave API/insight.js (CRYPTOQUANT_API_KEY; optional CG_API_KEY).
 */

'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { getInsight, validateInsightParams } = require('./API/insight');

const app = express();
const PORT = parsePort(process.env.PORT);

/**
 * Parses and validates the listen port.
 * @param {unknown} value
 * @returns {number}
 */
function parsePort(value) {
  if (value == null || value === '') {
    return 3000;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn('Invalid PORT; falling back to 3000');
    return 3000;
  }
  return n;
}

/**
 * Merges query and JSON body into one params object (body wins on conflict).
 * @param {import('express').Request} req
 * @returns {Record<string, unknown>}
 */
function collectParams(req) {
  const out = {};
  if (req.query && typeof req.query === 'object') {
    Object.assign(out, req.query);
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    Object.assign(out, req.body);
  }
  return out;
}

/**
 * Express error responder that never leaks the API key or stack to clients in production.
 * @param {Error & { statusCode?: number, code?: string }} err
 * @param {import('express').Response} res
 */
function sendError(err, res) {
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = err.message || 'Internal server error';
  // Scrub accidental key echoes
  const safe = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/CG-API-KEY\s*[:=]?\s*\S+/gi, 'CG-API-KEY=[REDACTED]');
  res.status(status).json({
    ok: false,
    error: {
      code: err.code || (status === 400 ? 'VALIDATION_ERROR' : 'SERVER_ERROR'),
      message: safe,
    },
  });
}

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

/**
 * Health check for Railway / load balancers.
 */
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'crypto-intraday-dashboard' });
});

/**
 * Shared handler for GET and POST /api/insight.
 * Validates every user input server-side via validateInsightParams.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleInsight(req, res) {
  try {
    const raw = collectParams(req);
    // Early validation so bad requests never hit CQ
    validateInsightParams(raw);
    const payload = await getInsight(raw);
    res.json(payload);
  } catch (err) {
    sendError(err, res);
  }
}

app.get('/api/insight', handleInsight);
app.post('/api/insight', handleInsight);

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
}));

/**
 * SPA-style fallback: unknown non-API routes serve the dashboard shell.
 */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Unknown API route' },
    });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) next(err);
  });
});

/**
 * Global error middleware.
 */
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  sendError(err, res);
});

app.listen(PORT, () => {
  console.log(`Crypto Intraday Dashboard listening on port ${PORT}`);
  if (!process.env.CRYPTOQUANT_API_KEY) {
    console.warn('WARNING: CRYPTOQUANT_API_KEY is not set — /api/insight will fail until configured.');
  }
  if (!process.env.CG_API_KEY) {
    console.warn('NOTE: CG_API_KEY is not set — CoinGlass long/short ratios will be skipped.');
  }
});
