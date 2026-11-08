// scripts/smoke-test.js
// Verifies the pieces that differ between operating systems:
//   1. the REST backend starts and /api/health answers
//   2. the bundled Chromium launches and renders a page (headless)
//   3. browser detection returns a usable browser list
//
// Run on Linux CI:  xvfb-run -a node scripts/smoke-test.js
// Run locally:      node scripts/smoke-test.js   (port 3000 must be free)

'use strict';

const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.TRAFFICDRIVE_PORT || process.env.PORT || '3000', 10);

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  console.log('[smoke] platform:', process.platform, process.arch);
  console.log('[smoke] node:', process.version);

  const { launchBrowser } = require(path.join(__dirname, '..', 'browser-launcher.js'));
  const platform = require(path.join(__dirname, '..', 'platform.js'));

  const bundled = platform.findBundledBrowser();
  console.log('[smoke] bundled browser:', bundled || '(none)');
  if (!bundled) throw new Error('Bundled Chromium not found');

  const browser = await launchBrowser({ headless: true, sessionId: 'smoke' });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><h1 id="x">TrafficDrive OK</h1></body></html>');
    const text = await page.textContent('#x');
    if (text !== 'TrafficDrive OK') throw new Error('Unexpected page text: ' + text);
    console.log('[smoke] browser render: OK');
  } finally {
    await browser.close().catch(() => {});
  }

  const server = require(path.join(__dirname, '..', 'server.js'));
  const instance = await server.startServer();
  try {
    const health = await get('/api/health');
    if (health.status !== 200 || !health.json || health.json.status !== 'ok') {
      throw new Error('Health check failed: ' + JSON.stringify(health));
    }
    console.log('[smoke] /api/health: OK');

    const detected = await get('/api/browsers/detect');
    if (detected.status !== 200 || !detected.json || !Array.isArray(detected.json.browsers)) {
      throw new Error('Browser detection failed: ' + JSON.stringify(detected));
    }
    const chromium = detected.json.browsers.find(b => b.id === 'chromium' && b.path);
    if (!chromium) throw new Error('Chromium was not detected by the API');
    console.log('[smoke] /api/browsers/detect: OK ->', chromium.path);
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }

  console.log('[smoke] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
