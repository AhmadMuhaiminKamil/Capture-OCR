// Script ini dijalankan saat build Vercel
// Meng-copy file WASM tesseract ke folder api/ agar ikut ter-bundle
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.join(__dirname, '..');

const src  = path.join(root, 'node_modules', 'tesseract.js-core');
const dest = path.join(root, 'api', 'tesseract.js-core');

if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

// Copy semua file dari tesseract.js-core
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  console.log(`Copied: ${file}`);
}

// Copy lang-data (eng.traineddata)
const langSrc  = path.join(root, 'node_modules', 'tesseract.js', 'lang-data');
const langDest = path.join(root, 'api', 'lang-data');
if (fs.existsSync(langSrc)) {
  if (!fs.existsSync(langDest)) fs.mkdirSync(langDest, { recursive: true });
  for (const file of fs.readdirSync(langSrc)) {
    fs.copyFileSync(path.join(langSrc, file), path.join(langDest, file));
    console.log(`Copied lang: ${file}`);
  }
}

console.log('✅ WASM files copied to api/');
