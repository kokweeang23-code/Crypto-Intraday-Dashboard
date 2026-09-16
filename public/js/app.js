/**
 * Dashboard application — form wiring, status, stats, and copy brief.
 * Uses addEventListener only (no inline handlers). No API keys in client.
 */

'use strict';

/** @type {object|null} Last successful insight payload for copy / redraw. */
let lastInsight = null;

/**
 * Formats a number for display with fixed digits.
 * @param {number|null|undefined} n
 * @param {number} digits
 * @returns {string}
 */
function fmt(n, digits) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Formats compact USD.
 * @param {number|null|undefined} n
 * @returns {string}
 */
function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Formats a native CQ funding_rate for compact UI display.
 * @param {number|null|undefined} n
 * @returns {string}
 */
function fmtFunding(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 0.01) return v.toFixed(4);
  if (abs >= 0.0001) return v.toFixed(6);
  return v.toExponential(2);
}

/**
 * Converts ISO timestamp to Asia/Singapore display string.
 * @param {string|undefined} iso
 * @returns {string}
 */
function formatGeneratedAt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const sgt = new Intl.DateTimeFormat('en-SG', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
    return `Generated ${sgt} SGT`;
  } catch (e) {
    return `Generated ${iso}`;
  }
}

/**
 * Sets the live status region message and tone.
 * @param {string} message
 * @param {'ok'|'error'|'loading'|''} tone
 */
function setStatus(message, tone) {
  const el = document.getElementById('status-region');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('status--ok', 'status--error', 'status--loading');
  if (tone) {
    el.classList.add(`status--${tone}`);
  }
}

/**
 * Reads validated-enough form values (server still validates).
 * @param {HTMLFormElement} form
 * @returns {{ symbol: string, window: string, limit: string, from: string, to: string }}
 */
function readFormParams(form) {
  const fd = new FormData(form);
  return {
    symbol: String(fd.get('symbol') || '').trim(),
    window: String(fd.get('window') || 'min').trim(),
    limit: String(fd.get('limit') || '1440').trim(),
    from: String(fd.get('from') || '').trim(),
    to: String(fd.get('to') || '').trim(),
  };
}

/**
 * Client-side soft validation before network call (server is authoritative).
 * @param {{ symbol: string, window: string, limit: string, from: string, to: string }} params
 * @returns {string|null} Error message or null if ok
 */
function softValidate(params) {
  if (!/^[a-z0-9]{2,16}_[a-z0-9]{2,16}$/.test(params.symbol.toLowerCase())) {
    return 'Symbol must look like btc_all (lowercase letters/digits + underscore).';
  }
  const allowed = ['day', 'hour', '10min', 'min'];
  if (!allowed.includes(params.window)) {
    return 'Window must be day, hour, 10min, or min.';
  }
  const limit = Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    return 'Limit must be an integer from 1 to 10000.';
  }
  const full = /^\d{8}T\d{6}$/;
  const day = /^\d{8}$/;
  if (params.from) {
    const ok = params.window === 'day' ? day.test(params.from) || full.test(params.from) : full.test(params.from);
    if (!ok) return 'From datetime format is invalid for the selected window.';
  }
  if (params.to) {
    const ok = params.window === 'day' ? day.test(params.to) || full.test(params.to) : full.test(params.to);
    if (!ok) return 'To datetime format is invalid for the selected window.';
  }
  return null;
}

/**
 * Clears and fills a definition list with stat pairs.
 * @param {HTMLElement|null} dl
 * @param {{ label: string, value: string, className?: string }[]} items
 */
function fillStats(dl, items) {
  if (!dl) return;
  while (dl.firstChild) {
    dl.removeChild(dl.firstChild);
  }
  items.forEach((item) => {
    const dt = document.createElement('dt');
    dt.textContent = item.label;
    const dd = document.createElement('dd');
    dd.textContent = item.value;
    if (item.className) {
      dd.className = item.className;
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
}

/**
 * Updates textual panels and stats from insight payload.
 * @param {object} data
 */
function renderTextPanels(data) {
  const exec = document.getElementById('executive-summary');
  if (exec) {
    exec.textContent = (data.insights && data.insights.executive) || '';
  }

  const gen = document.getElementById('generated-at');
  if (gen) {
    gen.textContent = formatGeneratedAt(data.meta && data.meta.generatedAt);
  }

  const panels = (data.insights && data.insights.panels) || {};
  const map = [
    ['insight-price-liq', panels.priceLiq],
    ['insight-vap', panels.vap],
    ['insight-cvd-ema', panels.cvdEma],
    ['insight-vol', panels.vol],
    ['insight-funding', panels.funding],
    ['insight-open-interest', panels.openInterest],
  ];
  map.forEach(([id, text]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '';
  });

  const stats = data.stats || {};
  const liq = stats.liquidationTotals || {};
  const chg =
    stats.priceChangePct != null
      ? `${stats.priceChangePct >= 0 ? '+' : ''}${stats.priceChangePct.toFixed(2)}%`
      : '—';

  fillStats(document.getElementById('price-liq-stats'), [
    { label: 'Last price', value: fmt(stats.lastPrice, 2) },
    { label: 'Change', value: chg },
    { label: 'Long liq', value: fmtUsd(liq.long_liquidations_usd) },
    { label: 'Short liq', value: fmtUsd(liq.short_liquidations_usd) },
    { label: 'Bias', value: (liq.bias || '—').replace(/_/g, ' ') },
  ]);

  const regime = stats.emaRegime || 'unknown';
  fillStats(document.getElementById('cvd-ema-stats'), [
    { label: 'EMA regime (DERIVED)', value: regime, className: `regime-${regime}` },
    { label: 'CVD latest (DERIVED)', value: fmt(stats.cvdLatest, 2) },
    {
      label: 'EMA periods',
      value: stats.emaPeriods
        ? `${stats.emaPeriods.fast} / ${stats.emaPeriods.slow}`
        : '12 / 26',
    },
  ]);

  const volPct =
    stats.volatilityLatest != null
      ? `${(stats.volatilityLatest * 100).toFixed(1)}%`
      : '—';
  fillStats(document.getElementById('vol-stats'), [
    { label: 'Vol latest (DERIVED)', value: volPct },
    {
      label: 'Full-sample',
      value:
        stats.volatilityFullSample != null
          ? `${(stats.volatilityFullSample * 100).toFixed(1)}%`
          : '—',
    },
    {
      label: 'Samples (OHLCV)',
      value: String((stats.sampleCounts && stats.sampleCounts.ohlcv) || 0),
    },
  ]);

  // Native CQ funding + open interest (not DERIVED)
  const fundChg =
    stats.fundingChange != null
      ? `${stats.fundingChange >= 0 ? '+' : ''}${fmtFunding(stats.fundingChange)}`
      : '—';
  const oiChg =
    stats.openInterestChangePct != null
      ? `${stats.openInterestChangePct >= 0 ? '+' : ''}${stats.openInterestChangePct.toFixed(2)}%`
      : '—';
  fillStats(document.getElementById('funding-oi-stats'), [
    { label: 'Funding latest (CQ)', value: fmtFunding(stats.fundingLatest) },
    { label: 'Funding Δ (sample)', value: fundChg },
    { label: 'Open interest (CQ)', value: fmtUsd(stats.openInterestLatest) },
    { label: 'OI change (sample)', value: oiChg },
  ]);
}

/**
 * Enables or disables the copy-brief button.
 * @param {boolean} enabled
 */
function setCopyEnabled(enabled) {
  const btn = document.getElementById('copy-brief-btn');
  if (btn) btn.disabled = !enabled;
}

/**
 * Copies the executive summary to the clipboard for Telegram.
 * @returns {Promise<void>}
 */
async function copyTelegramBrief() {
  if (!lastInsight || !lastInsight.insights) {
    setStatus('Nothing to copy yet.', 'error');
    return;
  }
  const text = lastInsight.insights.executive;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Telegram brief copied to clipboard.', 'ok');
  } catch (e) {
    setStatus('Clipboard copy failed — select the executive summary manually.', 'error');
  }
}

/**
 * Loads insight data and refreshes UI.
 * @param {HTMLFormElement} form
 * @returns {Promise<void>}
 */
async function refreshInsight(form) {
  const params = readFormParams(form);
  const softErr = softValidate(params);
  if (softErr) {
    setStatus(softErr, 'error');
    return;
  }

  const btn = document.getElementById('refresh-btn');
  if (btn) btn.disabled = true;
  setStatus('Fetching CryptoQuant series via /api/insight…', 'loading');

  try {
    const data = await window.InsightAPI.fetchInsight(params);
    lastInsight = data;
    renderTextPanels(data);
    if (window.InsightCharts) {
      window.InsightCharts.updateAllCharts(data);
    }
    setCopyEnabled(true);
    const n = data.stats && data.stats.sampleCounts ? data.stats.sampleCounts.ohlcv : 0;
    setStatus(`Updated — ${n} OHLCV bars. Derived metrics flagged in UI and meta.derived.`, 'ok');
  } catch (err) {
    setCopyEnabled(false);
    setStatus(err.message || 'Request failed', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Wires form submit and button listeners once DOM is ready.
 */
function initApp() {
  const form = document.getElementById('insight-form');
  const copyBtn = document.getElementById('copy-brief-btn');

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      refreshInsight(form);
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      copyTelegramBrief();
    });
  }

  // Auto-load defaults when Chart.js is available
  const start = () => {
    if (form) {
      refreshInsight(form);
    }
  };

  if (typeof Chart !== 'undefined') {
    start();
  } else {
    // Chart.js is deferred; wait briefly then start anyway (text still works)
    window.addEventListener('load', start);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
