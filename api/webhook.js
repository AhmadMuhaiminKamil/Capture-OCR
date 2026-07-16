import { createWorker } from 'tesseract.js';

// ── KONFIGURASI ──────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const REQUIRED_KEYWORDS = ['worklog', 'summary', 'record'];
const WORKLOG_ALT       = ['agentnote', 'agentno', 'attachment'];
const MIN_KEYWORD_MATCH = 2;
const FUZZY_THRESHOLD   = 0.65;
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

// ── FUZZY MATCH (tanpa library, pure JS) ─
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

function similarityRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function fuzzyMatch(kw, textLower, words) {
  if (textLower.includes(kw)) return true;
  return words.some(word => similarityRatio(kw, word) >= FUZZY_THRESHOLD);
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

// ── OCR ──────────────────────────────────
async function extractTextFromImageUrl(imageUrl) {
  const worker = await createWorker('eng', 1, {
    logger: () => {}, // silence logs
  });

  try {
    const { data: { text } } = await worker.recognize(imageUrl);
    return text;
  } finally {
    await worker.terminate();
  }
}

// ── HANDLER UTAMA ────────────────────────
async function handleUpdate(update) {
  const msg     = update.message;
  if (!msg) return;

  const chat_id = msg.chat.id;

  // /start
  if (msg.text === '/start') {
    await sendMessage(chat_id,
      '👋 Halo\\! Saya bot pengecekan *WorkLog*\\.\n\n' +
      'Kirimkan foto screenshot WorkLog kamu\\.\n\n' +
      'Gunakan /cek untuk memulai\\.',
      'MarkdownV2'
    );
    return;
  }

  // /cek
  if (msg.text === '/cek') {
    await sendMessage(chat_id, '📸 Silakan kirim foto screenshot WorkLog kamu sekarang.');
    return;
  }

  // foto
  if (msg.photo) {
    await sendMessage(chat_id, '🔍 Sedang menganalisis foto WorkLog kamu\\.\\.\\.');

    try {
      const photo   = msg.photo[msg.photo.length - 1];
      const fileRes = await getFile(photo.file_id);
      const filePath = fileRes.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      const rawText = await extractTextFromImageUrl(imageUrl);
      console.log('OCR result:', rawText);

      const { valid, found, missing } = isValidWorklog(rawText);

      if (valid) {
        const foundStr = found.map(k => `\`${k}\``).join(', ');
        await sendMessage(chat_id,
          `✅ *WorkLog VALID\\!*\n\nElemen terdeteksi: ${foundStr}\n\nTerima kasih\\! 👍`,
          'MarkdownV2'
        );
      } else {
        const missingStr = missing.map(k => `\`${k}\``).join(', ');
        const foundStr   = found.length ? found.map(k => `\`${k}\``).join(', ') : 'tidak ada';
        await sendMessage(chat_id,
          `❌ *WorkLog TIDAK VALID\\.*\n\n` +
          `Terdeteksi: ${foundStr}\n` +
          `Tidak ditemukan: ${missingStr}\n\n` +
          `⚠️ Kirim foto WorkLog yang jelas & lengkap\\.\n` +
          `Gunakan /cek untuk coba lagi\\.`,
          'MarkdownV2'
        );
      }
    } catch (err) {
      console.error('OCR error:', err);
      await sendMessage(chat_id, '❌ Gagal membaca gambar\\. Coba lagi\\.', 'MarkdownV2');
    }
    return;
  }

  // dokumen
  if (msg.document) {
    await sendMessage(chat_id,
      '📎 Kirim sebagai *foto* ya, bukan file\\.\nGunakan /cek untuk memulai\\.',
      'MarkdownV2'
    );
    return;
  }

  // teks biasa
  if (msg.text) {
    await sendMessage(chat_id,
      '📸 Kirim *foto* WorkLog kamu ya\\.\nGunakan /cek untuk memulai\\.',
      'MarkdownV2'
    );
  }
}

// ── VERCEL HANDLER ───────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'WorkLog Bot is running! 🤖' });
  }

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error('Handler error:', err);
  }

  // Selalu return 200 ke Telegram supaya tidak retry
  res.status(200).json({ ok: true });
}