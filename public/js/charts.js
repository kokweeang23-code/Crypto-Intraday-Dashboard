/**
 * Chart.js helpers for the four dashboard panels.
 * Labels DERIVED series in legends where applicable.
 */

'use strict';

/** @type {Record<string, import('chart.js').Chart|null>} */
const chartInstances = {
  priceLiq: null,
  vap: null,
  cvdEma: null,
  vol: null,
};

/**
 * Shared Chart.js defaults for dark Material theme and accessibility.
 */
function applyChartDefaults() {
  if (typeof Chart === 'undefined') {
    return;
  }
  Chart.defaults.color = getCssVar('--chart-text', '#c4c7ce');
  Chart.defaults.borderColor = getCssVar('--chart-grid', 'rgba(196,199,206,0.18)');
  Chart.defaults.font.family = '"Roboto", system-ui, sans-serif';
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
}

/**
 * Reads a CSS custom property from :root.
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function getCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

/**
 * Destroys an existing chart instance safely.
 * @param {keyof typeof chartInstances} key
 */
function destroyChart(key) {
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    chartInstances[key] = null;
  }
}

/**
 * Thin labels for dense minute series (show ~8 ticks).
 * @param {string[]} labels
 * @returns {(string|undefined)[]}
 */
function sparseLabels(labels) {
  if (!labels.length) return labels;
  const step = Math.max(1, Math.floor(labels.length / 8));
  return labels.map((lab, i) => (i % step === 0 || i === labels.length - 1 ? shortTime(lab) : ''));
}

/**
 * Shortens CQ datetime for axis labels.
 * @param {string} dt
 * @returns {string}
 */
function shortTime(dt) {
  if (!dt) return '';
  const parts = String(dt).split(' ');
  if (parts.length === 2) {
    return parts[1].slice(0, 5);
  }
  return String(dt).slice(5, 16);
}

/**
 * Renders price line + long/short liquidation bars (dual axis).
 * @param {HTMLCanvasElement} canvas
 * @param {object} data - insight payload
 */
function renderPriceLiqChart(canvas, data) {
  destroyChart('priceLiq');
  applyChartDefaults();

  const price = data.series.price || [];
  const liq = data.series.liquidation || [];
  const labels = price.map((r) => r.datetime);
  const closes = price.map((r) => r.close);

  const liqByDt = new Map(liq.map((r) => [r.datetime, r]));
  const longUsd = labels.map((dt) => {
    const row = liqByDt.get(dt);
    return row ? row.long_liquidations_usd : 0;
  });
  const shortUsd = labels.map((dt) => {
    const row = liqByDt.get(dt);
    return row ? row.short_liquidations_usd : 0;
  });

  chartInstances.priceLiq = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sparseLabels(labels),
      datasets: [
        {
          type: 'line',
          label: 'Close',
          data: closes,
          yAxisID: 'yPrice',
          borderColor: getCssVar('--md-sys-color-primary', '#8ab4f8'),
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          order: 0,
        },
        {
          type: 'bar',
          label: 'Long liq USD',
          data: longUsd,
          yAxisID: 'yLiq',
          backgroundColor: 'rgba(242, 139, 130, 0.55)',
          borderWidth: 0,
          order: 1,
        },
        {
          type: 'bar',
          label: 'Short liq USD',
          data: shortUsd,
          yAxisID: 'yLiq',
          backgroundColor: 'rgba(129, 201, 149, 0.55)',
          borderWidth: 0,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: true,
          ticks: { maxRotation: 0, autoSkip: false },
          grid: { display: false },
        },
        yPrice: {
          position: 'left',
          title: { display: true, text: 'Price' },
        },
        yLiq: {
          position: 'right',
          stacked: true,
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'Liq USD' },
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title(items) {
              const i = items[0] && items[0].dataIndex;
              return labels[i] || '';
            },
          },
        },
      },
    },
  });
}

/**
 * Renders horizontal volume-at-price histogram (DERIVED).
 * @param {HTMLCanvasElement} canvas
 * @param {object} data
 */
function renderVapChart(canvas, data) {
  destroyChart('vap');
  applyChartDefaults();

  const bins = data.series.volumeAtPrice || [];
  const labels = bins.map((b) => Number(b.priceMid).toFixed(0));
  const volumes = bins.map((b) => b.volume);

  chartInstances.vap = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Volume (DERIVED)',
          data: volumes,
          backgroundColor: 'rgba(253, 214, 99, 0.65)',
          borderColor: getCssVar('--md-sys-color-derived', '#fdd663'),
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Base volume' },
        },
        y: {
          title: { display: true, text: 'Price mid' },
          ticks: { autoSkip: true, maxTicksLimit: 12 },
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title(items) {
              const i = items[0] && items[0].dataIndex;
              const b = bins[i];
              if (!b) return '';
              return `${Number(b.priceLow).toFixed(2)} – ${Number(b.priceHigh).toFixed(2)}`;
            },
          },
        },
      },
    },
  });
}

/**
 * Renders CVD (DERIVED) with close and EMA overlays (DERIVED).
 * @param {HTMLCanvasElement} canvas
 * @param {object} data
 */
function renderCvdEmaChart(canvas, data) {
  destroyChart('cvdEma');
  applyChartDefaults();

  const ema = data.series.ema || [];
  const cvd = data.series.cvd || [];
  const labels = ema.map((r) => r.datetime);
  const closes = ema.map((r) => r.close);
  const emaFast = ema.map((r) => r.ema_fast);
  const emaSlow = ema.map((r) => r.ema_slow);

  const cvdByDt = new Map(cvd.map((r) => [r.datetime, r.cvd]));
  const cvdVals = labels.map((dt) => {
    const v = cvdByDt.get(dt);
    return v != null ? v : null;
  });

  chartInstances.cvdEma = new Chart(canvas, {
    data: {
      labels: sparseLabels(labels),
      datasets: [
        {
          type: 'line',
          label: 'Close',
          data: closes,
          yAxisID: 'yPrice',
          borderColor: getCssVar('--md-sys-color-primary', '#8ab4f8'),
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
        },
        {
          type: 'line',
          label: `EMA ${data.stats.emaPeriods?.fast || 12} (DERIVED)`,
          data: emaFast,
          yAxisID: 'yPrice',
          borderColor: '#fdd663',
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [4, 3],
        },
        {
          type: 'line',
          label: `EMA ${data.stats.emaPeriods?.slow || 26} (DERIVED)`,
          data: emaSlow,
          yAxisID: 'yPrice',
          borderColor: '#aecbfa',
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [2, 2],
        },
        {
          type: 'line',
          label: 'CVD (DERIVED)',
          data: cvdVals,
          yAxisID: 'yCvd',
          borderColor: getCssVar('--md-sys-color-secondary', '#81c995'),
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { maxRotation: 0, autoSkip: false },
          grid: { display: false },
        },
        yPrice: {
          position: 'left',
          title: { display: true, text: 'Price / EMA' },
        },
        yCvd: {
          position: 'right',
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'CVD' },
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title(items) {
              const i = items[0] && items[0].dataIndex;
              return labels[i] || '';
            },
          },
        },
      },
    },
  });
}

/**
 * Renders annualized realized volatility series (DERIVED).
 * @param {HTMLCanvasElement} canvas
 * @param {object} data
 */
function renderVolChart(canvas, data) {
  destroyChart('vol');
  applyChartDefaults();

  const series = data.series.volatility || [];
  const labels = series.map((r) => r.datetime);
  const vols = series.map((r) => (r.realizedVol != null ? r.realizedVol * 100 : null));

  chartInstances.vol = new Chart(canvas, {
    type: 'line',
    data: {
      labels: sparseLabels(labels),
      datasets: [
        {
          label: 'Realized vol % ann. (DERIVED)',
          data: vols,
          borderColor: '#f28b82',
          backgroundColor: 'rgba(242, 139, 130, 0.15)',
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { maxRotation: 0, autoSkip: false },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: '% annualized' },
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title(items) {
              const i = items[0] && items[0].dataIndex;
              return labels[i] || '';
            },
            label(ctx) {
              const v = ctx.parsed.y;
              return v == null ? 'n/a' : `${v.toFixed(2)}% ann.`;
            },
          },
        },
      },
    },
  });
}

/**
 * Updates all four panel charts from an insight payload.
 * @param {object} data
 */
function updateAllCharts(data) {
  const priceCanvas = document.getElementById('chart-price-liq');
  const vapCanvas = document.getElementById('chart-vap');
  const cvdCanvas = document.getElementById('chart-cvd-ema');
  const volCanvas = document.getElementById('chart-vol');

  if (priceCanvas) renderPriceLiqChart(priceCanvas, data);
  if (vapCanvas) renderVapChart(vapCanvas, data);
  if (cvdCanvas) renderCvdEmaChart(cvdCanvas, data);
  if (volCanvas) renderVolChart(volCanvas, data);
}

window.InsightCharts = {
  updateAllCharts,
  destroyChart,
};
