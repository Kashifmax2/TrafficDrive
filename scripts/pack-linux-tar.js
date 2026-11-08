// scripts/pack-linux-tar.js
// Packs dist/linux-unpacked into a portable Linux archive with correct Unix
// permissions. electron-builder on Windows stores every file as 0666 in the
// archive, which makes the Electron binary and Chromium non-executable after
// extraction. This post-step writes a proper ustar archive so the result can
// be extracted and run directly:
//
//   tar -xzf TrafficDrive-5.9.1-linux-x64-portable.tar.gz
//   ./TrafficDrive-5.9.1-linux-x64/TrafficDrive
//
// Linux AppImage / deb releases should still be built on Linux (GitHub
// Actions) where executable bits and symlinks are preserved natively.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'linux-unpacked');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const TOP = `TrafficDrive-${VERSION}-linux-x64`;
const OUT = path.join(ROOT, 'dist', `${TOP}-portable.tar.gz`);

const EXEC_FILES = new Set([
  'TrafficDrive',
  'chrome-sandbox',
  'chrome_crashpad_handler',
  'resources/chromium/chrome-linux64/chrome',
  'resources/chromium/chrome-linux64/chrome_crashpad_handler',
  'resources/chromium/chrome-linux64/chrome_sandbox',
  'resources/chromium/chrome-linux64/chrome-wrapper',
  'resources/chromium/chrome-linux-arm64/chrome',
  'resources/chromium/chrome-linux-arm64/chrome_crashpad_handler',
  'resources/chromium/chrome-linux/chrome',
]);

function modeFor(rel, isDir) {
  if (isDir) return 0o755;
  if (EXEC_FILES.has(rel)) return 0o755;
  if (/(^|\/)(chrome|chrome_crashpad_handler|chrome_sandbox|chrome-wrapper|xdg-open)$/.test(rel)) return 0o755;
  return 0o644;
}

function walk(dir, relBase, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ full, rel, dir: true });
      walk(full, rel, out);
    } else if (entry.isFile()) {
      out.push({ full, rel, dir: false, size: fs.statSync(full).size });
    }
  }
}

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

// Minimal ustar header with prefix support for paths longer than 100 bytes.
function tarHeader(name, mode, size, type, mtimeSec) {
  const buf = Buffer.alloc(512);
  let shortName = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    let split = -1;
    for (let i = 0; i < name.length; i++) {
      if (name[i] === '/' && i <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100) split = i;
    }
    if (split > 0) {
      prefix = name.slice(0, split);
      shortName = name.slice(split + 1);
    }
  }
  buf.write(shortName, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii'); // uid
  buf.write(octal(0, 8), 116, 8, 'ascii'); // gid
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(mtimeSec, 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('root', 265, 32, 'ascii');
  buf.write('root', 297, 32, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function pad512(size) {
  const rem = size % 512;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem);
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[linux-tar] Missing', SRC);
    console.error('[linux-tar] Run: npx electron-builder --linux dir --x64');
    process.exit(1);
  }

  const items = [{ full: SRC, rel: '', dir: true, mtime: fs.statSync(SRC).mtimeMs }];
  walk(SRC, '', items);

  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(OUT);
  gzip.pipe(out);

  const write = (buf) => new Promise((resolve, reject) => {
    gzip.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  (async () => {
    for (const item of items) {
      const name = item.rel ? `${TOP}/${item.rel}` : `${TOP}/`;
      const entryName = item.dir ? `${name.replace(/\/$/, '')}/` : name;
      let mtimeSec = Math.floor((item.mtime || Date.now()) / 1000);
      if (!Number.isFinite(mtimeSec) || mtimeSec < 0) mtimeSec = 0;

      if (item.dir) {
        await write(tarHeader(entryName, 0o755, 0, '5', mtimeSec));
      } else {
        const st = fs.statSync(item.full);
        const size = st.size;
        await write(tarHeader(entryName, modeFor(item.rel, false), size, '0', mtimeSec));
        if (size > 0) {
          const rs = fs.createReadStream(item.full, { highWaterMark: 1024 * 1024 });
          for await (const chunk of rs) await write(chunk);
        }
        await write(pad512(size));
      }
    }
    await write(Buffer.alloc(1024)); // end-of-archive marker
    gzip.end();
    await new Promise((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
      gzip.on('error', reject);
    });
    console.log('[linux-tar] Wrote', OUT, `${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
  })().catch((err) => {
    console.error('[linux-tar] Failed:', err);
    try { gzip.destroy(); } catch (_) {}
    process.exit(1);
  });
}

main();
