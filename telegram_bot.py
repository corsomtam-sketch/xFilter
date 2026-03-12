#!/usr/bin/env python3
"""
xFilter Telegram Bot

Send any URL to this bot and it will save it to your xFilter library
with an AI-generated summary.

Usage:
  python telegram_bot.py

Requires:
  - xFilter running at http://localhost:3000 (run: npx next dev)
  - TELEGRAM_BOT_TOKEN in .env.local
  - Optional: XFILTER_SHARE_TOKEN in .env.local (if you set one)
"""

import asyncio
import logging
import os
import re
import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, MessageHandler, CommandHandler, filters, ContextTypes

load_dotenv('.env.local')
load_dotenv()  # fallback to .env

logging.basicConfig(
    format='%(asctime)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

XFILTER_URL = os.getenv('XFILTER_URL', 'http://localhost:3000')
SHARE_TOKEN = os.getenv('XFILTER_SHARE_TOKEN', '').strip()

URL_PATTERN = re.compile(r'https?://[^\s]+')


def extract_url_and_note(text: str) -> tuple[str | None, str | None]:
    """Extract the first URL and any remaining text as a note."""
    match = URL_PATTERN.search(text)
    if not match:
        return None, None
    url = match.group(0).rstrip('.,)')
    note = (text[:match.start()] + text[match.end():]).strip() or None
    return url, note


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "xFilter Bot ready.\n\n"
        "Send me any URL and I'll save it to your xFilter library with an AI summary.\n\n"
        "You can add a note too:\n"
        "https://example.com this is really useful"
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    if not text:
        return

    url, note = extract_url_and_note(text)

    if not url:
        await update.message.reply_text("No URL found. Send me a link to save.")
        return

    processing = await update.message.reply_text("Saving...")

    try:
        headers = {'Content-Type': 'application/json'}
        if SHARE_TOKEN:
            headers['Authorization'] = f'Bearer {SHARE_TOKEN}'

        payload = {'url': url}
        if note:
            payload['note'] = note

        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f'{XFILTER_URL}/api/import/share',
                json=payload,
                headers=headers,
            )

        data = res.json()

        if res.status_code == 201:
            title = data.get('title', url)
            summary = data.get('summary', '')
            reply = f"Saved: *{title}*"
            if summary:
                reply += f"\n\n{summary}"
            await processing.edit_text(reply, parse_mode='Markdown')

        elif res.status_code == 200 and data.get('status') == 'exists':
            await processing.edit_text("Already in your library.")

        else:
            error = data.get('error', f'HTTP {res.status_code}')
            await processing.edit_text(f"Failed to save: {error}")

    except httpx.ConnectError:
        await processing.edit_text(
            "Can't reach xFilter. Make sure it's running:\n`npx next dev`",
            parse_mode='Markdown'
        )
    except Exception as e:
        logger.error(f"Error: {e}")
        await processing.edit_text(f"Error: {e}")


def main():
    token = os.getenv('TELEGRAM_BOT_TOKEN')
    if not token:
        print("Error: TELEGRAM_BOT_TOKEN not set in .env.local")
        raise SystemExit(1)

    print(f"Starting xFilter Telegram bot...")
    print(f"Connecting to xFilter at {XFILTER_URL}")
    print("Send any URL to your bot to save it. Press Ctrl+C to stop.\n")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler('start', start_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    app.run_polling()


if __name__ == '__main__':
    main()
