// scripts/make-ico.js
// Builds build-res/icon.ico from build-res/icons/*.png (PNG-compressed ICO).
// Run once on Windows after regenerating the PNG icon set.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'build-res', 'icons');
const OUT = path.join(ROOT, 'build-res', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => {
  const file = path.join(ICON_DIR, `${size}x${size}.png`);
  return { size, data: fs.readFileSync(file) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
  entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(img.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += img.data.length;
}

fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map(i => i.data)]));
console.log('[ico] wrote', OUT, fs.statSync(OUT).size, 'bytes');
