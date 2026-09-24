#!/usr/bin/env node
/**
 * CLI: fetch CoinGlass structure series and append one JSONL row to data/structure_log.jsonl.
 *
 * Usage:
 *   node scripts/log-structure-snapshot.js
 *   node scripts/log-structure-snapshot.js --symbol BTC --interval 30m --limit 672
 *
 * Requires CG_API_KEY in the environment (or .env via dotenv).
 * Never prints the API key.
 */

'use strict';

const path = require('path');

// Load .env from project root when present
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { snapshotStructure, LOG_FILE } = require('../API/structure');

/**
 * Minimal argv parser: --key value | --key=value
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = {};
  if (args.symbol) raw.symbol = args.symbol;
  if (args.interval) raw.interval = args.interval;
  if (args.limit) raw.limit = args.limit;
  if (args.exchange_list) raw.exchange_list = args.exchange_list;

  const payload = await snapshotStructure(raw);
  const latest = payload.latest || {};
  const logPath = (payload.meta && payload.meta.log && payload.meta.log.path) || LOG_FILE;

  console.log(
    JSON.stringify(
      {
        ok: true,
        loggedAt: payload.meta && payload.meta.generatedAt,
        logFile: logPath,
        symbol: payload.params.symbol,
        interval: payload.params.interval,
        aligned: payload.stats.sampleCounts.aligned,
        bidAskAvailable: payload.stats.bidAskAvailable,
        latest: {
          t: latest.t,
          price: latest.price,
          futCvd: latest.futCvd,
          spotCvd: latest.spotCvd,
          funding: latest.funding,
          oi: latest.oi,
          bidAskDelta: latest.bidAskDelta,
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  const message = (err && err.message) || 'snapshot failed';
  const safe = String(message)
    .replace(/CG-API-KEY\s*[:=]?\s*\S+/gi, 'CG-API-KEY=[REDACTED]')
    .slice(0, 240);
  console.error(JSON.stringify({ ok: false, error: safe }));
  process.exit(1);
});
