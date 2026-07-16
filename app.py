import os
import threading
import logging
import time
import requests
import pytesseract
from flask import Flask
from PIL import Image, ImageFilter
from io import BytesIO
from rapidfuzz import fuzz
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ── KONFIGURASI ──────────────────────────
BOT_TOKEN           = os.environ.get('BOT_TOKEN')
RENDER_URL          = os.environ.get('RENDER_URL')  # ← isi setelah deploy
PING_INTERVAL       = 60 * 10  # ping setiap 10 menit

REQUIRED_KEYWORDS   = ['worklog', 'summary', 'record']
WORKLOG_ALTERNATIVE = ['agentnote', 'agentno', 'attachment']
MIN_KEYWORD_MATCH   = 2
FUZZY_THRESHOLD     = 65
PARTIAL_THRESHOLD   = 92
MIN_WORD_LENGTH     = 4

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


# ── FLASK (keep-alive) ────────────────────
flask_app = Flask(__name__)

@flask_app.route('/')
def home():
    return 'WorkLog Bot is running! 🤖', 200

@flask_app.route('/ping')
def ping():
    return 'pong', 200


# ── SELF PING ────────────────────────────
def self_ping():
    while True:
        time.sleep(PING_INTERVAL)
        try:
            url = RENDER_URL or 'http://localhost:8080'
            res = requests.get(f'{url}/ping', timeout=10)
            logger.info(f'Self-ping OK: {res.status_code}')
        except Exception as e:
            logger.warning(f'Self-ping failed: {e}')


# ── OCR HELPER ───────────────────────────
def preprocess_zone(zone):
    zone = zone.resize((zone.width * 4, zone.height * 4), Image.LANCZOS)
    zone = zone.filter(ImageFilter.SHARPEN)
    zone = zone.filter(ImageFilter.SHARPEN)
    zone = zone.convert('L')
    return zone


def extract_text_from_image(image_bytes: bytes) -> str:
    image = Image.open(BytesIO(image_bytes))
    w, h  = image.size
    zones = {
        'atas':        image.crop((0, 0, w, int(h * 0.40))),
        'kiri':        image.crop((0, 0, int(w * 0.50), h)),
        'tengah_kiri': image.crop((0, int(h*0.10), int(w*0.55), int(h*0.60))),
    }
    all_text = ''
    for nama, zone in zones.items():
        zone = preprocess_zone(zone)
        text = pytesseract.image_to_string(zone, config='--psm 6', lang='eng')
        logger.info(f'OCR zona {nama}:\n{text}')
        all_text += ' ' + text
    return all_text


def fuzzy_match(kw, text_lower, words):
    if kw in text_lower:
        return True
    if any(fuzz.ratio(kw, word) >= FUZZY_THRESHOLD for word in words):
        return True
    similar_len = [w for w in words if abs(len(w) - len(kw)) <= 2]
    if any(fuzz.partial_ratio(kw, word) >= PARTIAL_THRESHOLD for word in similar_len):
        return True
    return False


def is_valid_worklog(text: str):
    text_lower = text.lower()
    words      = [w for w in text_lower.split() if len(w) >= MIN_WORD_LENGTH]
    found, missing = [], []
    for kw in REQUIRED_KEYWORDS:
        (found if fuzzy_match(kw, text_lower, words) else missing).append(kw)
    if 'worklog' in missing:
        alt_found = [kw for kw in WORKLOG_ALTERNATIVE if fuzzy_match(kw, text_lower, words)]
        if alt_found:
            found.append(f'worklog~{alt_found[0]}')
            missing.remove('worklog')
    valid = len(found) >= MIN_KEYWORD_MATCH
    return valid, found, missing


# ── TELEGRAM HANDLER ─────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        '👋 Halo! Saya bot pengecekan *WorkLog*.\n\n'
        'Kirimkan foto screenshot WorkLog kamu.\n\n'
        'Gunakan /cek untuk memulai.',
        parse_mode='Markdown',
    )

async def cmd_cek(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        '📸 Silakan kirim foto screenshot WorkLog kamu sekarang.'
    )

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text('🔍 Sedang menganalisis foto WorkLog kamu...')
    photo = update.message.photo[-1]
    file  = await context.bot.get_file(photo.file_id)
    image_bytes = await file.download_as_bytearray()
    try:
        raw_text = extract_text_from_image(bytes(image_bytes))
    except Exception as e:
        logger.error(f'OCR error: {e}')
        await update.message.reply_text('❌ Gagal membaca gambar. Coba lagi.')
        return
    valid, found, missing = is_valid_worklog(raw_text)
    if valid:
        found_str = ', '.join([f'`{k}`' for k in found])
        await update.message.reply_text(
            f'✅ *WorkLog VALID!*\n\nElemen terdeteksi: {found_str}\n\nTerima kasih! 👍',
            parse_mode='Markdown',
        )
    else:
        missing_str = ', '.join([f'`{k}`' for k in missing])
        found_str   = ', '.join([f'`{k}`' for k in found]) if found else 'tidak ada'
        await update.message.reply_text(
            f'❌ *WorkLog TIDAK VALID.*\n\n'
            f'Terdeteksi: {found_str}\n'
            f'Tidak ditemukan: {missing_str}\n\n'
            f'⚠️ Kirim foto WorkLog yang jelas & lengkap.\n'
            f'Gunakan /cek untuk coba lagi.',
            parse_mode='Markdown',
        )

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        '📸 Kirim *foto* WorkLog kamu ya.\nGunakan /cek untuk memulai.',
        parse_mode='Markdown',
    )

async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        '📎 Kirim sebagai *foto* ya, bukan file.\nGunakan /cek untuk memulai.',
        parse_mode='Markdown',
    )


# ── BOT THREAD ───────────────────────────
def run_bot():
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler('start', start))
    app.add_handler(CommandHandler('cek', cmd_cek))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    logger.info('Bot polling dimulai...')
    app.run_polling()


# ── MAIN ─────────────────────────────────
if __name__ == '__main__':
    threading.Thread(target=self_ping, daemon=True).start()
    threading.Thread(target=run_bot, daemon=True).start()
    port = int(os.environ.get('PORT', 8080))
    flask_app.run(host='0.0.0.0', port=port)