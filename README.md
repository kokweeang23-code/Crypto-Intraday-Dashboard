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

## DERIVED metrics (flagged in UI, API `meta.derived`, and README)

These are **not** CryptoQuant published series. They are computed in `API/insight.js`:

| Metric | Formula / method | Caveat |
| --- | --- | --- |
| **CVD** | `cumsum(base_buy_volume - base_sell_volume)` from trade endpoint | Not a native CQ field |
| **EMA regime** | EMA(12) / EMA(26) of OHLCV `close`; bull / bear / chop vs slow EMA (±0.25% band) | Periods documented; not a CQ indicator |
| **Volume-at-price** | Bin OHLCV `volume` by typical price `(H+L+C)/3` | Candle proxy only — true VAP needs ticks/order book |
| **Volatility index** | Annualized realized vol = `stdev(log returns) * sqrt(periods_per_year)` | Not a CQ published index |

Every API response includes `meta.derived` with formulas and caveats. The UI shows a yellow **DERIVED** chip on those panels.

## Project layout

```
Crypto-Intraday-Dashboard/
  README.md
  package.json
  server.js                 # Express: public/ + /api/insight
  railway.json
  Procfile
  .env.example
  .gitignore
  API/insight.js            # CRYPTOQUANT_API_KEY (+ optional CG_API_KEY); fetch; compute; insights
  public/index.html
  public/css/*.css          # Material Design (no inline styles)
  public/js/*.js            # Chart.js CDN + fetch /api/insight (no keys)
  bot/telegram_bot.py       # /intraday [symbol] → insight API → TG brief
  bot/requirements.txt
```

## Security

- CryptoQuant key lives **only** in `API/insight.js` via `process.env.CRYPTOQUANT_API_KEY`.
- Optional CoinGlass key: `process.env.CG_API_KEY` (same file; never sent to the client).
- Never put keys in `public/`, never use `NEXT_PUBLIC_` / `VITE_` / client env vars.
- Client and Telegram bot call **same-origin** `/api/insight` (or `INSIGHT_API_URL`) only.
- Every user input is validated server-side in `validateInsightParams`.

## Environment variables

| Variable | Required | Used by | Description |
| --- | --- | --- | --- |
| `CRYPTOQUANT_API_KEY` | Yes (server) | `API/insight.js` | CQ Bearer access token |
| `CG_API_KEY` | No (optional) | `API/insight.js` | CoinGlass key for Binance global/top L/S ratios |
| `PORT` | No (default 3000) | `server.js` | HTTP listen port (Railway sets this) |
| `TELEGRAM_BOT_TOKEN` | Yes (bot) | `bot/telegram_bot.py` | From @BotFather |
| `INSIGHT_API_URL` | Yes (bot) | `bot/telegram_bot.py` | Dashboard base URL, e.g. `http://127.0.0.1:3000` |

Copy `.env.example` → `.env` and fill values locally. Never commit `.env`.

## Local run (dashboard)

```bash
cd /workspace/Crypto-Intraday-Dashboard
cp .env.example .env
# Edit .env — set CRYPTOQUANT_API_KEY (required); CG_API_KEY optional

npm install
node server.js
# or: npm start
```

Open `http://127.0.0.1:3000`. Use **Refresh insight** to batch the five CQ calls (OHLCV, liquidation, trade, funding-rate, open-interest).

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
2. Set env vars: `CRYPTOQUANT_API_KEY` (required), optional `CG_API_KEY` for L/S ratios; `PORT` is injected automatically.
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

Market data © CryptoQuant; optional long/short ratios © CoinGlass. Derived analytics are computed by this project and must remain labeled **DERIVED**.
