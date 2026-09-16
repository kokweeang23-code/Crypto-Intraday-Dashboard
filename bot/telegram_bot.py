#!/usr/bin/env python3
"""
Telegram bot for CryptoQuant intraday briefs.

Command:
  /intraday [symbol]

Calls the dashboard insight API (INSIGHT_API_URL) — never CryptoQuant directly —
so the CQ API key stays on the Node server.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from typing import Any, Dict, Optional

import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("intraday-bot")

SYMBOL_RE = re.compile(r"^[a-z0-9]{2,16}_[a-z0-9]{2,16}$")
ALLOWED_WINDOWS = frozenset({"day", "hour", "10min", "min"})


def get_env(name: str, required: bool = True, default: Optional[str] = None) -> str:
    """Read an environment variable with optional default / required check."""
    value = os.environ.get(name, default)
    if required and (value is None or not str(value).strip()):
        raise RuntimeError(f"Missing required environment variable: {name}")
    return str(value).strip() if value is not None else ""


def validate_symbol(raw: str) -> str:
    """Validate and normalize a CQ aggregate symbol (server also validates)."""
    symbol = raw.strip().lower()
    if not SYMBOL_RE.match(symbol):
        raise ValueError(
            "Invalid symbol. Use CQ aggregate form like btc_all or eth_all."
        )
    return symbol


def fetch_insight(
    base_url: str,
    symbol: str,
    window: str = "min",
    limit: int = 1440,
) -> Dict[str, Any]:
    """
    GET /api/insight from the dashboard server.
    Never attaches CRYPTOQUANT_API_KEY — that stays server-side.
    """
    if window not in ALLOWED_WINDOWS:
        raise ValueError(f"Invalid window. Allowed: {', '.join(sorted(ALLOWED_WINDOWS))}")
    if not isinstance(limit, int) or limit < 1 or limit > 10000:
        raise ValueError("limit must be an integer from 1 to 10000")

    url = base_url.rstrip("/") + "/api/insight"
    params = {"symbol": symbol, "window": window, "limit": limit}
    resp = requests.get(url, params=params, timeout=60)
    try:
        body = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Insight API returned non-JSON (HTTP {resp.status_code})") from exc

    if resp.status_code >= 400 or body.get("ok") is False:
        err = body.get("error") or {}
        msg = err.get("message") or f"HTTP {resp.status_code}"
        raise RuntimeError(msg)
    return body


def format_telegram_brief(payload: Dict[str, Any]) -> str:
    """Format insight JSON into a concise Telegram message with DERIVED flags."""
    insights = payload.get("insights") or {}
    executive = insights.get("executive") or "No executive summary."
    stats = payload.get("stats") or {}
    meta = payload.get("meta") or {}
    derived = meta.get("derived") or {}

    lines = [
        "📊 *CryptoQuant Intraday Brief*",
        "",
        escape_md(executive),
        "",
        f"Regime: `{stats.get('emaRegime', 'n/a')}` "
        f"(EMA DERIVED { (stats.get('emaPeriods') or {}).get('fast', 12) }/"
        f"{ (stats.get('emaPeriods') or {}).get('slow', 26) })",
        f"CVD latest (DERIVED): `{stats.get('cvdLatest', 'n/a')}`",
    ]

    vol = stats.get("volatilityLatest")
    if isinstance(vol, (int, float)):
        lines.append(f"Vol index (DERIVED): `{vol * 100:.1f}%` ann.")

    if derived:
        lines.append("")
        lines.append("_DERIVED metrics: CVD, EMA regime, volume-at-price, volatility index_")

    return "\n".join(lines)


def escape_md(text: str) -> str:
    """Light escaping for Telegram MarkdownV1-ish plain sections."""
    # Keep message readable; escape only the riskiest characters for *parse_mode=Markdown*
    return (
        str(text)
        .replace("_", "\\_")
        .replace("*", "\\*")
        .replace("`", "\\`")
        .replace("[", "\\[")
    )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start — usage help."""
    text = (
        "CryptoQuant Intraday Bot\n\n"
        "Commands:\n"
        "/intraday [symbol] — e.g. /intraday btc_all\n"
        "/help — show this help\n\n"
        "Derived metrics (CVD, EMA, VAP, vol) are labeled DERIVED."
    )
    if update.message:
        await update.message.reply_text(text)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /help."""
    await cmd_start(update, context)


async def cmd_intraday(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Handle /intraday [symbol].
    Fetches insight from INSIGHT_API_URL and replies with a brief.
    """
    if not update.message:
        return

    args = context.args or []
    symbol_raw = args[0] if args else "btc_all"

    try:
        symbol = validate_symbol(symbol_raw)
    except ValueError as exc:
        await update.message.reply_text(str(exc))
        return

    base_url = context.application.bot_data.get("insight_api_url") or get_env(
        "INSIGHT_API_URL", required=True, default="http://127.0.0.1:3000"
    )

    await update.message.reply_text(f"Fetching intraday insight for `{symbol}`…")

    try:
        payload = fetch_insight(base_url, symbol=symbol, window="min", limit=1440)
        brief = format_telegram_brief(payload)
        await update.message.reply_text(brief, parse_mode="Markdown")
    except Exception as exc:  # noqa: BLE001
        logger.exception("intraday failed")
        await update.message.reply_text(f"Insight failed: {exc}")


def main() -> None:
    """Boot the Telegram long-polling bot."""
    token = get_env("TELEGRAM_BOT_TOKEN")
    insight_url = get_env("INSIGHT_API_URL", default="http://127.0.0.1:3000")

    app = Application.builder().token(token).build()
    app.bot_data["insight_api_url"] = insight_url

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("intraday", cmd_intraday))

    logger.info("Starting bot; insight API=%s", insight_url)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        logger.error("%s", exc)
        sys.exit(1)
