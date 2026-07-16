'use strict';
const path = require('path');
const fs   = require('fs');

// ── PATCH: copy WASM ke node_modules sebelum tesseract.js diload ──
// Vercel tidak bundle node_modules/tesseract.js-core tapi bundle api/tesseract.js-core
const wasmSrc  = path.join(process.cwd(), 'api', 'tesseract.js-core');
const wasmDest = path.join(process.cwd(), 'node_modules', 'tesseract.js-core');
try {
  if (fs.existsSync(wasmSrc) && !fs.existsSync(path.join(wasmDest, 'tesseract-core-simd.wasm'))) {
    if (!fs.existsSync(wasmDest)) fs.mkdirSync(wasmDest, { recursive: true });
    for (const file of fs.readdirSync(wasmSrc)) {
      fs.copyFileSync(path.join(wasmSrc, file), path.join(wasmDest, file));
    }
    console.log('Patched: WASM copied to node_modules/tesseract.js-core');
  }
} catch (e) {
  console.warn('WASM patch failed:', e.message);
}

// ── PATCH: copy lang-data ke node_modules/tesseract.js/lang-data ──
const langSrc  = path.join(process.cwd(), 'api', 'lang-data');
const langDest = '/tmp/tessdata';
try {
  if (fs.existsSync(langSrc) && !fs.existsSync(path.join(langDest, 'eng.traineddata.gz'))) {
    if (!fs.existsSync(langDest)) fs.mkdirSync(langDest, { recursive: true });
    for (const file of fs.readdirSync(langSrc)) {
      fs.copyFileSync(path.join(langSrc, file), path.join(langDest, file));
    }
    console.log('Patched: lang-data copied to node_modules/tesseract.js/lang-data');
  }
} catch (e) {
  console.warn('Lang patch failed:', e.message);
}

// Baru load tesseract.js setelah patch
const { createWorker } = require('tesseract.js');

// ── KONFIGURASI ──────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const REQUIRED_KEYWORDS = ['worklog', 'summary', 'record'];
const WORKLOG_ALT       = ['agentnote', 'agentno', 'attachment'];
const MIN_KEYWORD_MATCH = 2;
const FUZZY_THRESHOLD   = 65;
const PARTIAL_THRESHOLD = 92;
const MIN_WORD_LENGTH   = 4;

// ── TELEGRAM API HELPER ──────────────────
async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chat_id, text, parse_mode = 'Markdown') {
  return telegramRequest('sendMessage', { chat_id, text, parse_mode });
}

async function getFile(file_id) {
  return telegramRequest('getFile', { file_id });
}

// ── FUZZY MATCH ───────────────────────────
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function ratio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return (1 - levenshtein(a, b) / maxLen) * 100;
}

function partialRatio(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let best = 0;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    const score = ratio(shorter, longer.slice(i, i + shorter.length));
    if (score > best) best = score;
  }
  return best;
}

function fuzzyMatch(kw, textLower, words) {
  if (textLower.includes(kw)) return true;
  if (words.some(w => ratio(kw, w) >= FUZZY_THRESHOLD)) return true;
  const similarLen = words.filter(w => Math.abs(w.length - kw.length) <= 2);
  if (similarLen.some(w => partialRatio(kw, w) >= PARTIAL_THRESHOLD)) return true;
  return false;
}

function isValidWorklog(text) {
  const textLower = text.toLowerCase();
  const words     = textLower.split(/\s+/).filter(w => w.length >= MIN_WORD_LENGTH);
  const found     = [];
  const missing   = [];

  for (const kw of REQUIRED_KEYWORDS) {
    (fuzzyMatch(kw, textLower, words) ? found : missing).push(kw);
  }

  if (missing.includes('worklog')) {
    const altFound = WORKLOG_ALT.find(kw => fuzzyMatch(kw, textLower, words));
    if (altFound) {
      found.push(`worklog~${altFound}`);
      missing.splice(missing.indexOf('worklog'), 1);
    }
  }

  return { valid: found.length >= MIN_KEYWORD_MATCH, found, missing };
}

// ── IMAGE PREPROCESSING ───────────────────
async function preprocessImage(imageBytes) {
  const sharp = require('sharp');
  const meta  = await sharp(imageBytes).metadata();
  const w     = meta.width;
  const h     = meta.height;
  const scale = 4;

  const zones = [
    { left: 0, top: 0,                  width: w,                    height: Math.floor(h * 0.40) },
    { left: 0, top: 0,                  width: Math.floor(w * 0.50), height: h },
    { left: 0, top: Math.floor(h*0.10), width: Math.floor(w * 0.55), height: Math.floor(h * 0.50) },
  ];

  const buffers = [];
  for (const zone of zones) {
    const buf = await sharp(imageBytes)
      .extract(zone)
      .resize(zone.width * scale, zone.height * scale)
      .sharpen()
      .sharpen()
      .grayscale()
      .png()
      .toBuffer();
    buffers.push(buf);
  }
  return buffers;
}

// ── OCR ──────────────────────────────────
async function extractTextFromImageUrl(imageUrl) {
  const res        = await fetch(imageUrl);
  const arrayBuf   = await res.arrayBuffer();
  const imageBytes = Buffer.from(arrayBuf);

  let allText = '';

  try {
    const zoneBuffers = await preprocessImage(imageBytes);
    const worker      = await createWorker('eng', 1, { logger: () => {}, langPath: langDest });
    try {
      for (const buf of zoneBuffers) {
        const { data: { text } } = await worker.recognize(buf);
        allText += ' ' + text;
      }
    } finally {
      await worker.terminate();
    }
  } catch (err) {
    console.warn('Preprocess failed, fallback direct OCR:', err.message);
    const worker = await createWorker('eng', 1, { logger: () => {}, langPath: langDest });
    try {
      const { data: { text } } = await worker.recognize(imageBytes);
      allText = text;
    } finally {
      await worker.terminate();
    }
  }

  console.log('OCR result:', allText);
  return allText;
}

// ── TELEGRAM HANDLER ─────────────────────
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chat_id = msg.chat.id;

  if (msg.text === '/start') {
    await sendMessage(chat_id,
      '👋 Halo! Saya bot pengecekan *WorkLog*.\n\nKirimkan foto screenshot WorkLog kamu.\n\nGunakan /cek untuk memulai.'
    );
    return;
  }

  if (msg.text === '/cek') {
    await sendMessage(chat_id, '📸 Silakan kirim foto screenshot WorkLog kamu sekarang.');
    return;
  }

  if (msg.photo) {
    await sendMessage(chat_id, '🔍 Sedang menganalisis foto WorkLog kamu...');
    try {
      const photo    = msg.photo[msg.photo.length - 1];
      const fileRes  = await getFile(photo.file_id);
      const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.result.file_path}`;
      const rawText  = await extractTextFromImageUrl(imageUrl);
      const { valid, found, missing } = isValidWorklog(rawText);
      console.log('Validation:', { valid, found, missing });

      if (valid) {
        const foundStr = found.map(k => `\`${k}\``).join(', ');
        await sendMessage(chat_id,
          `✅ *WorkLog VALID!*\n\nElemen terdeteksi: ${foundStr}\n\nTerima kasih! 👍`
        );
      } else {
        const missingStr = missing.map(k => `\`${k}\``).join(', ');
        const foundStr   = found.length ? found.map(k => `\`${k}\``).join(', ') : 'tidak ada';
        await sendMessage(chat_id,
          `❌ *WorkLog TIDAK VALID.*\n\nTerdeteksi: ${foundStr}\nTidak ditemukan: ${missingStr}\n\n⚠️ Kirim foto WorkLog yang jelas & lengkap.\nGunakan /cek untuk coba lagi.`
        );
      }
    } catch (err) {
      console.error('OCR error:', err);
      await sendMessage(chat_id, '❌ Gagal membaca gambar. Coba lagi.');
    }
    return;
  }

  if (msg.document) {
    await sendMessage(chat_id, '📎 Kirim sebagai *foto* ya, bukan file.\nGunakan /cek untuk memulai.');
    return;
  }

  if (msg.text) {
    await sendMessage(chat_id, '📸 Kirim *foto* WorkLog kamu ya.\nGunakan /cek untuk memulai.');
  }
}

// ── VERCEL HANDLER ───────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'WorkLog Bot is running! 🤖' });
  }

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error('Handler error:', err);
  }

  res.status(200).json({ ok: true });
};