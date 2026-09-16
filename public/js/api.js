/**
 * Client API helper — talks only to same-origin /api/insight.
 * Never sends or stores CryptoQuant credentials in the browser.
 */

'use strict';

/**
 * Builds a query string from insight form parameters.
 * @param {{ symbol: string, window: string, limit: string|number, from?: string, to?: string }} params
 * @returns {string}
 */
function buildInsightQuery(params) {
  const q = new URLSearchParams();
  q.set('symbol', String(params.symbol || '').trim().toLowerCase());
  q.set('window', String(params.window || 'min').trim());
  q.set('limit', String(params.limit || '1440').trim());
  if (params.from) {
    q.set('from', String(params.from).trim());
  }
  if (params.to) {
    q.set('to', String(params.to).trim());
  }
  return q.toString();
}

/**
 * Fetches insight payload from the Express proxy (GET).
 * @param {{ symbol: string, window: string, limit: string|number, from?: string, to?: string }} params
 * @returns {Promise<object>}
 */
async function fetchInsight(params) {
  const qs = buildInsightQuery(params);
  const res = await fetch(`/api/insight?${qs}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });

  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`Insight API returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || (body && body.ok === false)) {
    const msg =
      (body && body.error && body.error.message) ||
      `Insight request failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return body;
}

window.InsightAPI = {
  buildInsightQuery,
  fetchInsight,
};
