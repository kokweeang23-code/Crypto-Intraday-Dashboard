# CryptoQuant Intraday Dashboard

Vanilla JS + Express dashboard that batches five **documented** CryptoQuant API v2 market endpoints, computes clearly labeled **DERIVED** metrics, and serves an accessible Material Design UI plus a Telegram brief bot.

> Do **not** invent CQ endpoints. Source of truth: [docs.cryptoquant.com](https://docs.cryptoquant.com).

## Documented CQ v2 endpoints used

Base: `https://api.cryptoquant.com/v2` — auth: `Authorization: Bearer {CRYPTOQUANT_API_KEY}`

| Purpose | Path | Notes |
| --- | --- | --- |
| Price OHLCV | `/market/cq/swap/ohlcv?symbol=btc_all&window=min` | Native CQ |
| Long/short liquidations | `/market/cq/swap/liquidation?symbol=btc_all&window=min` | Native CQ |
| Trade flow | `/market/cq/swap/trade?symbol=btc_all&window=min` | Native CQ; buy/sell volumes for CVD |
| Funding rate | `/market/cq/swap/funding-rate?symbol=btc_all&window=min` | Native CQ; positive = longs pay shorts |
| Open interest | `/market/cq/swap/open-interest?symbol=btc_all&window=min` | Native CQ; outstanding swap notional |

Windows: `day` \| `hour` \| `10min` \| `min`. Limit max `10000` (dashboard default `1440` ≈ 24h at `min`).

## Optional CoinGlass long/short ratios

When `CG_API_KEY` is set, `/api/insight` also fetches Binance account long/short history from CoinGlass v4 (same env name as the TG bot). Missing or failed CG calls **do not** fail the CQ insight.

Base: `https://open-api-v4.coinglass.com` — header: `CG-API-KEY: {CG_API_KEY}`

| Purpose | Path | Params |
| --- | --- | --- |
| Global L/S account ratio | `/api/futures/global-long-short-account-ratio/history` | `exchange=Binance`, `symbol=BTCUSDT` (or `ETHUSDT` if CQ symbol starts with `eth`), `interval` mapped from CQ window, `limit` ≤ 1000 |
| Top-trader L/S account ratio | `/api/futures/top-long-short-account-ratio/history` | Same params |

CQ window → CG interval: `min`/`10min` → `15m`, `hour` → `1h`, `day` → `1d`.

Response additions when available:

- `series.lsGlobal` / `series.lsTop` — `{ datetime, long_percent, short_percent, long_short_ratio }[]`
- `stats.lsGlobalLatest` / `stats.lsTopLatest` — latest ratio + long/short %
- `stats.coinglass` — `{ available, pair?, interval?, error? }`
- `insights.panels.longShort` — plain English; also mentioned in the executive summary
- `meta.sources` — lists CryptoQuant (required) and CoinGlass (optional)


## BTC market structure (CoinGlass)

Dedicated page `/structure.html` and API `/api/structure` pull live CoinGlass v4 history so the chart is useful on day one (no waiting for local logs). Snapshots can also be appended every ~4h to `data/structure_log.jsonl`.

Base: `https://open-api-v4.coinglass.com` — header: `CG-API-KEY: {CG_API_KEY}` (**required** for this page).

| Series | Path | Notes |
| --- | --- | --- |
| BTC price | `/api/futures/price/history` | `exchange=Binance`, `symbol=BTCUSDT`, OHLC `close` |
| Futures CVD (agg) | `/api/futures/aggregated-cvd/history` | `exchange_list=Binance,OKX,Bybit`, `symbol=BTC`, `cum_vol_delta` |
| Spot CVD (agg) | `/api/spot/aggregated-cvd/history` | Same params; spot taker CVD |
| Funding (OI-weighted) | `/api/futures/funding-rate/oi-weight-history` | `symbol=BTC`, OHLC `close` |
| Open interest (agg) | `/api/futures/open-interest/aggregated-history` | `symbol=BTC`, `unit=usd`, OHLC `close` |
| Bid/ask delta (agg) | `/api/futures/orderbook/aggregated-ask-bids-history` | `aggregated_bids_usd − aggregated_asks_usd`; may be plan/interval limited |

Defaults: `interval=30m`, `limit=672` (~14 days). Allowed intervals: `30m` | `1h` | `4h` | `1d`.

### Structure API

```http
GET  /api/structure?symbol=BTC&interval=30m&limit=672
POST /api/structure
POST /api/structure/snapshot   # same params; also appends one JSONL row
```

Response shape (keys never returned):

- `series[]` — `{ t, price, futCvd, spotCvd, funding, oi, bidAskDelta }` (ms epoch `t`)
- `latest` — newest finite sample per field
- `stats.bidAskAvailable` / `stats.bidAskError` — UI disables the bid/ask toggle when false
- `meta.endpoints` / `meta.bidAsk` — documentation for overlays

When `CG_API_KEY` is missing the API returns HTTP 503 JSON `{ ok:false, error:{ code:"CONFIG_ERROR", message:"CG_API_KEY is not set" } }`. The Structure UI still loads and shows that error.

### 4h structure log

```bash
# One-shot CLI (loads .env if present)
npm run snapshot:structure
# or:
node scripts/log-structure-snapshot.js --symbol BTC --interval 30m --limit 672

# Same via HTTP (server must be running)
curl -X POST 'http://127.0.0.1:3000/api/structure/snapshot?symbol=BTC&interval=30m&limit=672'
```

Appends one line to `data/structure_log.jsonl` (gitignored). Schema example: `data/structure_log.example.jsonl`.

Suggested cron (Asia/Singapore, every 4 hours):

```cron
0 */4 * * * cd /path/to/Crypto-Intraday-Dashboard && /usr/bin/node scripts/log-structure-snapshot.js >> /var/log/structure-snapshot.log 2>&1
```

Or wire an external agent (e.g. Grok Bot) to hit `POST /api/structure/snapshot` on the same cadence. **Note:** Railway’s filesystem is ephemeral unless a volume is mounted — prefer the CLI/agent writing somewhere durable, or mount `data/` as a volume.

## DERIVED metrics (flagged in UI, API `meta.derived`, and README)

These are **not** CryptoQuant published series. They are computed in `API/insight.js`:

| Metric | Formula / method | Caveat |
| --- | --- | --- |
| **CVD** | `cumsum(base_buy_volume - base_sell_volume)` from trade endpoint | Not a native CQ field |
| **EMA regime** | EMA(9) / EMA(26) of OHLCV `close`; bull / bear / chop vs slow EMA (±0.25% band) | Periods documented; not a CQ indicator |
| **Volume-at-price** | Bin OHLCV `volume` by typical price `(H+L+C)/3` | Candle proxy only — true VAP needs ticks/order book |
| **Volatility index** | Annualized realized vol = `stdev(log returns) * sqrt(periods_per_year)` | Not a CQ published index |

Every API response includes `meta.derived` with formulas and caveats. The UI shows a yellow **DERIVED** chip on those panels.

## Project layout

```
Crypto-Intraday-Dashboard/
  README.md
  package.json
  server.js                 # Express: public/ + /api/insight + /api/structure
  railway.json
  Procfile
  .env.example
  .gitignore
  API/insight.js            # CRYPTOQUANT_API_KEY (+ optional CG_API_KEY); fetch; compute; insights
  API/structure.js          # CG_API_KEY; CoinGlass market-structure series + JSONL logger
  scripts/log-structure-snapshot.js  # CLI: append one 4h-style snapshot to data/
  data/.gitkeep
  data/structure_log.example.jsonl
  public/index.html         # Intraday dashboard
  public/structure.html     # Multi-axis structure chart
  public/css/*.css          # Material Design (no inline styles)
  public/js/*.js            # Chart.js CDN + fetch APIs (no keys)
  bot/telegram_bot.py       # /intraday [symbol] → insight API → TG brief
  bot/requirements.txt
```

## Security

- CryptoQuant key lives **only** in `API/insight.js` via `process.env.CRYPTOQUANT_API_KEY`.
- CoinGlass key: `process.env.CG_API_KEY` in `API/insight.js` and `API/structure.js` only (never sent to the client).
- Never put keys in `public/`, never use `NEXT_PUBLIC_` / `VITE_` / client env vars.
- Client and Telegram bot call **same-origin** `/api/insight` (or `INSIGHT_API_URL`) only.
- Every user input is validated server-side in `validateInsightParams`.

## Environment variables

| Variable | Required | Used by | Description |
| --- | --- | --- | --- |
| `CRYPTOQUANT_API_KEY` | Yes (server) | `API/insight.js` | CQ Bearer access token |
| `CG_API_KEY` | Required for Structure; optional for insight L/S | `API/structure.js`, `API/insight.js` | CoinGlass key — Structure page + optional insight L/S ratios |
| `PORT` | No (default 3000) | `server.js` | HTTP listen port (Railway sets this) |
| `TELEGRAM_BOT_TOKEN` | Yes (bot) | `bot/telegram_bot.py` | From @BotFather |
| `INSIGHT_API_URL` | Yes (bot) | `bot/telegram_bot.py` | Dashboard base URL, e.g. `http://127.0.0.1:3000` |

Copy `.env.example` → `.env` and fill values locally. Never commit `.env`.

## Local run (dashboard)

```bash
cd /workspace/Crypto-Intraday-Dashboard
cp .env.example .env
# Edit .env — CRYPTOQUANT_API_KEY (insight); CG_API_KEY (Structure + optional L/S)

npm install
node server.js
# or: npm start
```

Open `http://127.0.0.1:3000` (Intraday) or `http://127.0.0.1:3000/structure.html` (Structure).
Use **Refresh insight** for CQ panels; **Refresh structure** for CoinGlass overlays.

### API

```http
GET  /api/insight?symbol=btc_all&window=min&limit=1440
POST /api/insight
Content-Type: application/json

{ "symbol": "btc_all", "window": "min", "limit": 1440, "from": null, "to": null }
```

Optional `from` / `to`: `YYYYMMDDTHHMMSS` (UTC); for `window=day`, `YYYYMMDD` is also accepted.

Response includes `series`, `stats`, `insights` (executive + panel text), `meta.derived`, and `meta.sources` (CQ required; CoinGlass optional). Keys are never returned.

Health: `GET /health`

## Telegram bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather); copy the token.
2. Ensure the Node dashboard is running and reachable at `INSIGHT_API_URL`.
3. Install and run:

```bash
cd /workspace/Crypto-Intraday-Dashboard/bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export TELEGRAM_BOT_TOKEN=...
export INSIGHT_API_URL=http://127.0.0.1:3000
python telegram_bot.py
```

Commands:

- `/start` / `/help` — usage
- `/intraday [symbol]` — e.g. `/intraday btc_all` (default `btc_all`)

The bot formats the executive summary and flags DERIVED metrics. It does **not** hold the CryptoQuant key.

## Railway deploy

1. Create a new Railway project from this folder (Nixpacks / Node).
2. Set env vars: `CRYPTOQUANT_API_KEY` (insight), `CG_API_KEY` (Structure page + optional insight L/S); `PORT` is injected automatically.
3. Start command: `node server.js` (see `railway.json` / `Procfile`).
4. Deploy; open the public URL.
5. For Telegram, run the bot elsewhere (or a second Railway service) with:
   - `TELEGRAM_BOT_TOKEN`
   - `INSIGHT_API_URL=https://your-app.up.railway.app`

Do not set any client-side public env vars for the CQ key.

## Accessibility & frontend constraints

- Vanilla JS only (no React / Vue / Angular).
- No inline styles; no inline event handlers — external CSS + `addEventListener`.
- Material Design dark theme with WCAG 2.1 AA targets (contrast, labels, focus rings, keyboard, skip link, `aria-live` status).
- Chart.js loaded from CDN.

## License / data attribution

Market data © CryptoQuant; CoinGlass powers optional L/S ratios and the Structure page overlays. Derived analytics are computed by this project and must remain labeled **DERIVED**.
