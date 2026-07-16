import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.join(__dirname, '..');

// 1. Copy SELURUH node_modules/tesseract.js-core ke api/tesseract.js-core
const coreSrc  = path.join(root, 'node_modules', 'tesseract.js-core');
const coreDest = path.join(root, 'api', 'tesseract.js-core');
if (fs.existsSync(coreDest)) fs.rmSync(coreDest, { recursive: true });
fs.mkdirSync(coreDest, { recursive: true });
for (const file of fs.readdirSync(coreSrc)) {
  fs.copyFileSync(path.join(coreSrc, file), path.join(coreDest, file));
  console.log(`Copied core: ${file}`);
}

// 2. Copy worker script tesseract.js ke api/worker/
const workerSrcDir = path.join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node');
const workerDest   = path.join(root, 'api', 'worker');
if (fs.existsSync(workerDest)) fs.rmSync(workerDest, { recursive: true });
fs.cpSync(path.join(root, 'node_modules', 'tesseract.js', 'src'), path.join(root, 'api', 'tesseract-src'), { recursive: true });
console.log('Copied tesseract.js src');

// 3. Copy node_modules yang dibutuhkan worker ke api/node_modules
const apiNodeModules = path.join(root, 'api', 'node_modules');
if (!fs.existsSync(apiNodeModules)) fs.mkdirSync(apiNodeModules, { recursive: true });

// Copy tesseract.js-core ke api/node_modules juga (untuk require resolution)
const nmCoreDest = path.join(apiNodeModules, 'tesseract.js-core');
if (fs.existsSync(nmCoreDest)) fs.rmSync(nmCoreDest, { recursive: true });
fs.mkdirSync(nmCoreDest, { recursive: true });
for (const file of fs.readdirSync(coreSrc)) {
  fs.copyFileSync(path.join(coreSrc, file), path.join(nmCoreDest, file));
}
console.log('Copied tesseract.js-core to api/node_modules');

// 4. Download eng.traineddata.gz
const langDest = path.join(root, 'api', 'lang-data');
if (!fs.existsSync(langDest)) fs.mkdirSync(langDest, { recursive: true });
const langFile = path.join(langDest, 'eng.traineddata.gz');
if (fs.existsSync(langFile)) {
  console.log('eng.traineddata.gz already exists, skipping.');
} else {
  console.log('Downloading eng.traineddata.gz...');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(langFile);
    const download = (url) => https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlinkSync(langFile); reject(err); });
    download('https://github.com/naptha/tessdata/blob/gh-pages/4.0.0/eng.traineddata.gz?raw=true');
  });
  console.log('Downloaded eng.traineddata.gz');
}

console.log('✅ All files ready!');
