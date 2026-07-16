import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.join(__dirname, '..');

// 1. Copy tesseract.js-core ke api/tesseract.js-core
const coreSrc  = path.join(root, 'node_modules', 'tesseract.js-core');
const coreDest = path.join(root, 'api', 'tesseract.js-core');
if (!fs.existsSync(coreDest)) fs.mkdirSync(coreDest, { recursive: true });
for (const file of fs.readdirSync(coreSrc)) {
  fs.copyFileSync(path.join(coreSrc, file), path.join(coreDest, file));
  console.log(`Copied core: ${file}`);
}

// 2. KUNCI: Replace node_modules/tesseract.js-core dengan symlink ke api/tesseract.js-core
// Ini paksa tesseract.js baca WASM dari folder yang ikut bundle
fs.rmSync(coreSrc, { recursive: true, force: true });
fs.symlinkSync(coreDest, coreSrc);
console.log(`Symlinked: node_modules/tesseract.js-core -> api/tesseract.js-core`);

// 3. Download eng.traineddata.gz ke api/lang-data/
const langDest = path.join(root, 'api', 'lang-data');
if (!fs.existsSync(langDest)) fs.mkdirSync(langDest, { recursive: true });

const langFile = path.join(langDest, 'eng.traineddata.gz');
if (fs.existsSync(langFile)) {
  console.log('eng.traineddata.gz already exists, skipping.');
} else {
  console.log('Downloading eng.traineddata.gz...');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(langFile);
    https.get(
      'https://github.com/naptha/tessdata/blob/gh-pages/4.0.0/eng.traineddata.gz?raw=true',
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          https.get(res.headers.location, (res2) => {
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
        } else {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }
      }
    ).on('error', (err) => { fs.unlinkSync(langFile); reject(err); });
  });
  console.log('Downloaded eng.traineddata.gz');
}

// 4. Symlink node_modules/tesseract.js/lang-data -> api/lang-data
const nmLangPath = path.join(root, 'node_modules', 'tesseract.js', 'lang-data');
if (fs.existsSync(nmLangPath)) fs.rmSync(nmLangPath, { recursive: true, force: true });
fs.symlinkSync(langDest, nmLangPath);
console.log(`Symlinked: node_modules/tesseract.js/lang-data -> api/lang-data`);

console.log('✅ All files ready!');
