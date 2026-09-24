/**
 * Structure page — fetch /api/structure and render one multi-axis Chart.js chart.
 * No API keys in the browser.
 */

'use strict';

/** @type {Chart|null} */
let structureChart = null;

/** Dataset metadata for toggles + colors (CQ-like: price dark, OI blue, CVD red). */
const SERIES_META = [
  {
    key: 'price',
    label: 'BTC price',
    color: '#e8eaed',
    yAxisID: 'yPrice',
    borderWidth: 2,
  },
  {
    key: 'futCvd',
    label: 'Futures CVD',
    color: '#f28b82',
    yAxisID: 'yFutCvd',
    borderWidth: 1.5,
  },
  {
    key: 'spotCvd',
    label: 'Spot CVD',
    color: '#fdd663',
    yAxisID: 'ySpotCvd',
    borderWidth: 1.5,
  },
  {
    key: 'funding',
    label: 'Funding ann. (OI-w)',
    color: '#81c995',
    yAxisID: 'yFunding',
    borderWidth: 1.25,
  },
  {
    key: 'oi',
    label: 'Open interest',
    color: '#8ab4f8',
    yAxisID: 'yOi',
    borderWidth: 1.5,
  },
  {
    key: 'bidAskDelta',
    label: 'Bid/ask delta',
    color: '#c58af9',
    yAxisID: 'yBidAsk',
    borderWidth: 1.25,
  },
];

/** Binance-style 8h funding: 3 settlements/day. CoinGlass returns period rate already in %. */
const FUNDING_SETTLEMENTS_PER_DAY = 3;
const FUNDING_ANN_FACTOR = FUNDING_SETTLEMENTS_PER_DAY * 365;

/**
 * Formats CoinGlass funding period rate (already in percent units).
 * @param {number|null|undefined} periodPct
 * @returns {string}
 */
function formatFundingPeriod(periodPct) {
  if (periodPct == null || !Number.isFinite(periodPct)) return '—';
  return `${periodPct.toFixed(5)}%`;
}

/**
 * Formats annualized funding from a CoinGlass period % rate.
 * ann% = period% × 3 × 365
 * @param {number|null|undefined} periodPct
 * @returns {string}
 */
function formatFundingAnn(periodPct) {
  if (periodPct == null || !Number.isFinite(periodPct)) return '—';
  return `${(periodPct * FUNDING_ANN_FACTOR).toFixed(2)}%`;
}

/**
 * Formats a compact number for axis ticks / stats.
 * @param {number|null|undefined} n
 * @param {{ digits?: number, pct?: boolean }} [opts]
 * @returns {string}
 */
function formatCompact(n, opts) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (opts && opts.pct) {
    return `${(n * 100).toFixed(4)}%`;
  }
  const abs = Math.abs(n);
  const digits = (opts && opts.digits) != null ? opts.digits : 2;
  if (abs >= 1e12) return `${(n / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  return n.toPrecision(3);
}

/**
 * Formats epoch ms for chart labels (Asia/Singapore-friendly local string).
 * @param {number} t
 * @returns {string}
 */
function formatTimeLabel(t) {
  try {
    return new Date(t).toLocaleString('en-SG', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Singapore',
    });
  } catch (_) {
    return new Date(t).toISOString();
  }
}

/**
 * Reads form values into API params.
 * @returns {{ symbol: string, interval: string, limit: string }}
 */
function readFormParams() {
  const form = document.getElementById('structure-form');
  const fd = new FormData(form);
  return {
    symbol: String(fd.get('symbol') || 'BTC').trim().toUpperCase(),
    interval: String(fd.get('interval') || '30m').trim(),
    limit: String(fd.get('limit') || '672').trim(),
  };
}

/**
 * Builds query string for /api/structure.
 * @param {{ symbol: string, interval: string, limit: string }} params
 * @returns {string}
 */
function buildQuery(params) {
  const q = new URLSearchParams();
  q.set('symbol', params.symbol);
  q.set('interval', params.interval);
  q.set('limit', params.limit);
  return q.toString();
}

/**
 * Sets status region text + tone.
 * @param {string} message
 * @param {'ok'|'error'|'loading'|''} [tone]
 */
function setStatus(message, tone) {
  const el = document.getElementById('status-region');
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('status--ok', 'status--error', 'status--loading');
  if (tone) el.classList.add(`status--${tone}`);
}

/**
 * Fetches structure payload (GET) or snapshot (POST).
 * @param {'live'|'snapshot'} mode
 * @param {{ symbol: string, interval: string, limit: string }} params
 * @returns {Promise<object>}
 */
async function fetchStructure(mode, params) {
  const qs = buildQuery(params);
  const url =
    mode === 'snapshot'
      ? `/api/structure/snapshot?${qs}`
      : `/api/structure?${qs}`;
  const method = mode === 'snapshot' ? 'POST' : 'GET';
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    throw new Error(`Structure API returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || (body && body.ok === false)) {
    const msg =
      (body && body.error && body.error.message) ||
      `Structure request failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Renders latest stats dl.
 * @param {object} payload
 */
function renderStats(payload) {
  const dl = document.getElementById('structure-stats');
  const note = document.getElementById('bidask-note');
  const latest = payload.latest || {};
  const rows = [
    ['Price', formatCompact(latest.price, { digits: 0 })],
    ['Futures CVD', formatCompact(latest.futCvd)],
    ['Spot CVD', formatCompact(latest.spotCvd)],
    ['Funding 8h (OI-w)', formatFundingPeriod(latest.funding)],
    ['Funding ann.', formatFundingAnn(latest.funding)],
    ['Open interest', formatCompact(latest.oi)],
    [
      'Bid/ask Δ',
      payload.stats && payload.stats.bidAskAvailable
        ? formatCompact(latest.bidAskDelta)
        : 'n/a',
    ],
  ];
  dl.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div><dt>${k}</dt><dd>${v}</dd></div>`
    )
    .join('');

  if (note) {
    if (payload.stats && !payload.stats.bidAskAvailable) {
      note.hidden = false;
      note.textContent =
        'Bid/ask delta toggle is disabled: ' +
        ((payload.stats && payload.stats.bidAskError) ||
          (payload.meta && payload.meta.bidAsk && payload.meta.bidAsk.note) ||
          'CoinGlass aggregated orderbook unavailable for this plan/interval.');
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }

  const gen = document.getElementById('generated-at');
  if (gen && payload.meta && payload.meta.generatedAt) {
    const d = new Date(payload.meta.generatedAt);
    gen.textContent = `Updated ${d.toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      hour12: false,
    })} SGT · ${payload.stats.sampleCounts.aligned} bars`;
  }
}

/**
 * Builds Chart.js datasets from aligned series rows.
 * @param {object[]} series
 * @param {boolean} bidAskAvailable
 * @returns {object[]}
 */
function buildDatasets(series, bidAskAvailable) {
  return SERIES_META.map((meta) => {
    const disabled = meta.key === 'bidAskDelta' && !bidAskAvailable;
    return {
      label: meta.label,
      data: series.map((row) => {
        const v = row[meta.key];
        if (v == null || !Number.isFinite(v)) return null;
        // Chart funding as annualized % for readability; raw API stays period %.
        if (meta.key === 'funding') return v * FUNDING_ANN_FACTOR;
        return v;
      }),
      borderColor: meta.color,
      backgroundColor: 'transparent',
      yAxisID: meta.yAxisID,
      borderWidth: meta.borderWidth,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.15,
      spanGaps: false,
      hidden: disabled,
      _structureKey: meta.key,
      _disabled: disabled,
    };
  });
}

/**
 * Rebuilds toggle chips bound to dataset visibility.
 * @param {Chart} chart
 * @param {boolean} bidAskAvailable
 */
function renderToggles(chart, bidAskAvailable) {
  const wrap = document.getElementById('series-toggles');
  if (!wrap) return;
  wrap.innerHTML = '';

  chart.data.datasets.forEach((ds, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-chip';
    btn.dataset.index = String(index);
    btn.style.setProperty('--chip-color', String(ds.borderColor));
    btn.textContent = ds.label;
    const isDisabled = Boolean(ds._disabled) || (ds._structureKey === 'bidAskDelta' && !bidAskAvailable);
    if (isDisabled) {
      btn.disabled = true;
      btn.classList.add('toggle-chip--disabled');
      btn.title = 'Bid/ask aggregate delta unavailable from CoinGlass for this request';
      btn.setAttribute('aria-pressed', 'false');
    } else {
      const visible = chart.isDatasetVisible(index);
      btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      if (!visible) btn.classList.add('toggle-chip--off');
      btn.addEventListener('click', () => {
        const next = !chart.isDatasetVisible(index);
        chart.setDatasetVisibility(index, next);
        chart.update();
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.classList.toggle('toggle-chip--off', !next);
      });
    }
    wrap.appendChild(btn);
  });
}

/**
 * Creates or updates the multi-axis structure chart.
 * @param {object} payload
 */
function renderChart(payload) {
  const canvas = document.getElementById('chart-structure');
  if (!canvas || typeof Chart === 'undefined') {
    setStatus('Chart.js failed to load', 'error');
    return;
  }

  const series = Array.isArray(payload.series) ? payload.series : [];
  const labels = series.map((row) => formatTimeLabel(row.t));
  const bidAskAvailable = Boolean(payload.stats && payload.stats.bidAskAvailable);
  const datasets = buildDatasets(series, bidAskAvailable);

  const gridColor = 'rgba(196, 199, 206, 0.18)';
  const tickColor = '#c4c7ce';

  const scales = {
    x: {
      ticks: {
        color: tickColor,
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 10,
        font: { size: 10 },
      },
      grid: { color: gridColor },
    },
    yPrice: {
      type: 'linear',
      position: 'right',
      title: { display: true, text: 'Price', color: '#e8eaed', font: { size: 11 } },
      ticks: {
        color: '#e8eaed',
        callback: (v) => formatCompact(v, { digits: 0 }),
      },
      grid: { drawOnChartArea: false },
    },
    yFutCvd: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: 'Fut CVD', color: '#f28b82', font: { size: 11 } },
      ticks: {
        color: '#f28b82',
        callback: (v) => formatCompact(v),
      },
      grid: { color: gridColor },
    },
    ySpotCvd: {
      type: 'linear',
      position: 'left',
      display: 'auto',
      title: { display: true, text: 'Spot CVD', color: '#fdd663', font: { size: 11 } },
      ticks: {
        color: '#fdd663',
        callback: (v) => formatCompact(v),
      },
      grid: { drawOnChartArea: false },
      offset: true,
    },
    yOi: {
      type: 'linear',
      position: 'left',
      display: 'auto',
      title: { display: true, text: 'OI', color: '#8ab4f8', font: { size: 11 } },
      ticks: {
        color: '#8ab4f8',
        callback: (v) => formatCompact(v),
      },
      grid: { drawOnChartArea: false },
      offset: true,
    },
    yFunding: {
      type: 'linear',
      position: 'left',
      display: 'auto',
      title: { display: true, text: 'Funding ann. %', color: '#81c995', font: { size: 11 } },
      ticks: {
        color: '#81c995',
        callback: (v) =>
          v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(2)}%`,
      },
      grid: { drawOnChartArea: false },
      offset: true,
    },
    yBidAsk: {
      type: 'linear',
      position: 'left',
      display: bidAskAvailable ? 'auto' : false,
      title: {
        display: bidAskAvailable,
        text: 'Bid−Ask',
        color: '#c58af9',
        font: { size: 11 },
      },
      ticks: {
        color: '#c58af9',
        callback: (v) => formatCompact(v),
      },
      grid: { drawOnChartArea: false },
      offset: true,
    },
  };

  if (structureChart) {
    structureChart.data.labels = labels;
    structureChart.data.datasets = datasets;
    structureChart.options.scales = scales;
    structureChart.update();
  } else {
    structureChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: tickColor,
              usePointStyle: true,
              filter(item, chartData) {
                const ds = chartData.datasets[item.datasetIndex];
                return !(ds && ds._disabled);
              },
            },
            onClick(e, legendItem, legend) {
              const chart = legend.chart;
              const i = legendItem.datasetIndex;
              const ds = chart.data.datasets[i];
              if (ds && ds._disabled) return;
              const next = !chart.isDatasetVisible(i);
              chart.setDatasetVisibility(i, next);
              chart.update();
              renderToggles(chart, bidAskAvailable);
            },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const key = ctx.dataset._structureKey;
                const raw = ctx.parsed.y;
                if (key === 'funding') {
                  const period = raw / FUNDING_ANN_FACTOR;
                  return `${ctx.dataset.label}: ${formatFundingAnn(period)} (8h ${formatFundingPeriod(period)})`;
                }
                if (key === 'price') {
                  return `${ctx.dataset.label}: ${formatCompact(raw, { digits: 0 })}`;
                }
                return `${ctx.dataset.label}: ${formatCompact(raw)}`;
              },
            },
          },
        },
        scales,
      },
    });
  }

  renderToggles(structureChart, bidAskAvailable);
}

/**
 * Loads structure data and updates UI.
 * @param {'live'|'snapshot'} [mode]
 */
async function refresh(mode) {
  const params = readFormParams();
  const refreshBtn = document.getElementById('refresh-btn');
  const snapshotBtn = document.getElementById('snapshot-btn');
  if (refreshBtn) refreshBtn.disabled = true;
  if (snapshotBtn) snapshotBtn.disabled = true;
  setStatus(
    mode === 'snapshot' ? 'Logging snapshot…' : 'Loading CoinGlass structure…',
    'loading'
  );

  try {
    const payload = await fetchStructure(mode || 'live', params);
    renderStats(payload);
    renderChart(payload);
    const note =
      mode === 'snapshot' && payload.meta && payload.meta.log
        ? ` Snapshot appended (${payload.meta.log.bytes} bytes).`
        : '';
    setStatus(
      `Loaded ${payload.stats.sampleCounts.aligned} bars @ ${payload.params.interval}.${note}`,
      'ok'
    );
  } catch (err) {
    const msg = (err && err.message) || 'Request failed';
    setStatus(msg, 'error');
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    if (snapshotBtn) snapshotBtn.disabled = false;
  }
}

function init() {
  const form = document.getElementById('structure-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      refresh('live');
    });
  }
  const snap = document.getElementById('snapshot-btn');
  if (snap) {
    snap.addEventListener('click', () => refresh('snapshot'));
  }
  refresh('live');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
