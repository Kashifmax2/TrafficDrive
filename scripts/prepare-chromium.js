// scripts/prepare-chromium.js
// Copies a Playwright Chromium build into vendor/chromium so electron-builder
// can ship it as an offline browser (resources/chromium).
//
// Order:
//   1. CHROMIUM_SOURCE=<folder>       explicit source folder (contains
//                                     chrome-win64/ or chrome-linux/)
//   2. Playwright cache              npx playwright install chromium
//
// The folder layout is platform-specific but always comes from
// platform.browserLayouts(), so the same script works on Windows/Linux/macOS.

'use strict';

const fs = require('fs');
const path = require('path');
const platform = require('../platform.js');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'vendor', 'chromium');

function hasValidBrowser(root) {
  if (!root || !fs.existsSync(root)) return false;
  for (const rel of platform.browserLayouts()) {
    const exe = path.join(root, ...rel);
    if (platform.isValidBrowserBinary(exe)) return true;
  }
  return false;
}

// Turn ".../chromium-1248/chrome-win64/chrome.exe" into ".../chromium-1248".
function layoutRoot(exe) {
  if (!exe) return '';
  for (const rel of platform.browserLayouts()) {
    const suffix = path.join(...rel);
    if (exe.endsWith(suffix)) {
      const cut = exe.slice(0, exe.length - suffix.length);
      return cut.replace(/[\\/]$/, '');
    }
  }
  return path.dirname(exe);
}

function main() {
  if (hasValidBrowser(DEST)) {
    console.log('[chromium] vendor/chromium already prepared:', DEST);
    return;
  }

  let source = process.env.CHROMIUM_SOURCE || '';
  if (source) {
    source = path.resolve(source);
    console.log('[chromium] Using CHROMIUM_SOURCE:', source);
    if (!hasValidBrowser(source)) {
      console.error('[chromium] CHROMIUM_SOURCE does not contain a valid browser for this OS.');
      process.exit(1);
    }
  } else {
    const cached = platform.findCachedBrowser();
    if (!cached) {
      console.error('[chromium] No cached Playwright Chromium found.');
      console.error('[chromium] Run:  npx playwright install chromium');
      console.error('[chromium] Or set CHROMIUM_SOURCE to a folder that contains');
      for (const rel of platform.browserLayouts()) {
        console.error('[chromium]   ' + path.join(...rel));
      }
      process.exit(1);
    }
    source = layoutRoot(cached);
    console.log('[chromium] Using Playwright cache:', source);
  }

  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.cpSync(source, DEST, { recursive: true });
  console.log('[chromium] Copied to:', DEST);

  if (!hasValidBrowser(DEST)) {
    console.error('[chromium] Copy finished but no valid browser was found in vendor/chromium.');
    process.exit(1);
  }
  console.log('[chromium] OK');
}

main();
