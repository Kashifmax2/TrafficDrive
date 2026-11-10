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

    // ── dashboard served by the backend (Codespaces / remote Linux) ────
    const dash = await get('/');
    if (dash.status !== 200 || !/KG TRF Tool/.test(dash.raw || '')) {
      throw new Error('Dashboard / did not serve index.html: ' + dash.status);
    }
    const asset = await get('/i18n.js');
    if (asset.status !== 200 || !/function/.test(asset.raw || '')) {
      throw new Error('Dashboard asset /i18n.js failed: ' + asset.status);
    }
    const blocked = await get('/server.js');
    if (blocked.status !== 404) {
      throw new Error('Backend source must not be served: /server.js -> ' + blocked.status);
    }
    console.log('[smoke] dashboard (/, i18n.js, server.js blocked): OK');

    // ── dashboard helpers + settings persistence in a real page ────────
    const dashBrowser = await launchBrowser({ headless: true, sessionId: 'smoke-dashboard' });
    try {
      const page = await dashBrowser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const helpers = await page.evaluate(() => ({
        url: typeof normalizeUrlInput === 'function' ? normalizeUrlInput('example.com') : '',
        ref: typeof normalizeReferrerUrl === 'function' ? normalizeReferrerUrl('facebook.com') : '',
        toast: typeof showToast === 'function',
      }));
      if (helpers.url !== 'https://example.com/' || helpers.ref !== 'https://facebook.com/' || !helpers.toast) {
        throw new Error('Dashboard helpers missing: ' + JSON.stringify(helpers));
      }
      // A brand-new install must not ship demo campaigns or fake totals.
      const freshCampaigns = await page.evaluate(() => ({
        total: document.getElementById('campStatTotal').textContent,
        sessions: document.getElementById('campStatSessions').textContent,
        visits: document.getElementById('campStatVisits').textContent,
        cards: document.querySelectorAll('#campList .camp-card').length,
        empty: document.getElementById('campEmpty').style.display,
        badge: document.getElementById('campBadge').textContent,
      }));
      if (freshCampaigns.total !== '0' || freshCampaigns.sessions !== '0' || freshCampaigns.visits !== '0'
          || freshCampaigns.cards !== 0 || freshCampaigns.empty === 'none' || freshCampaigns.badge !== '0') {
        throw new Error('Fresh install is not empty: ' + JSON.stringify(freshCampaigns));
      }
      // Older builds saved demo cards; they must be dropped on load while real
      // campaigns survive untouched.
      const demoCleanup = await page.evaluate(() => {
        localStorage.setItem('trafficdrive_campaigns', JSON.stringify([
          {name:'Ecommerce Store Boost',url:'https://mystore.com — Organic Search',mode:'organic',stats:['8,240','41,200']},
          {name:'My Real Campaign',url:'https://real.example.com — Direct Traffic',mode:'direct',stats:['10','25']},
        ]));
        loadCampaigns();
        return {
          cards: document.querySelectorAll('#campList .camp-card').length,
          names: [...document.querySelectorAll('#campList .camp-name')].map(e=>e.textContent),
          total: document.getElementById('campStatTotal').textContent,
          sessions: document.getElementById('campStatSessions').textContent,
          visits: document.getElementById('campStatVisits').textContent,
          empty: document.getElementById('campEmpty').style.display,
          saved: JSON.parse(localStorage.getItem('trafficdrive_campaigns')||'[]').length,
        };
      });
      if (demoCleanup.cards !== 1 || demoCleanup.names[0] !== 'My Real Campaign'
          || demoCleanup.total !== '1' || demoCleanup.sessions !== '10' || demoCleanup.visits !== '25'
          || demoCleanup.empty !== 'none' || demoCleanup.saved !== 1) {
        throw new Error('Demo campaign cleanup failed: ' + JSON.stringify(demoCleanup));
      }
      const emptied = await page.evaluate(() => {
        localStorage.removeItem('trafficdrive_campaigns');
        loadCampaigns();
        return {
          cards: document.querySelectorAll('#campList .camp-card').length,
          total: document.getElementById('campStatTotal').textContent,
          empty: document.getElementById('campEmpty').style.display,
          badge: document.getElementById('campBadge').textContent,
        };
      });
      if (emptied.cards !== 0 || emptied.total !== '0' || emptied.empty === 'none' || emptied.badge !== '0') {
        throw new Error('Empty campaign state failed: ' + JSON.stringify(emptied));
      }
      console.log('[smoke] campaigns start empty + demo cleanup: OK');
      const persisted = await page.evaluate(() => {
        currentResCategory = 'mobile';
        currentResolution = { width: 1366, height: 768 };
        autoRotateEnabled = true;
        document.getElementById('customResW').value = '1366';
        document.getElementById('customResH').value = '768';
        saveFormData();
        // Simulate a fresh launch: defaults first, then loadFormData().
        currentResolution = { width: 1400, height: 900 };
        autoRotateEnabled = false;
        currentResCategory = 'desktop';
        loadFormData();
        return {
          w: currentResolution.width,
          h: currentResolution.height,
          rotate: autoRotateEnabled,
          category: currentResCategory,
          uiW: document.getElementById('res-current-w').textContent,
          toggleOn: document.getElementById('autoRotateToggle').classList.contains('on'),
        };
      });
      if (persisted.w !== 1366 || persisted.h !== 768 || persisted.rotate !== true
          || persisted.category !== 'mobile' || persisted.uiW !== '1366' || persisted.toggleOn !== true) {
        throw new Error('Settings were not restored: ' + JSON.stringify(persisted));
      }
      console.log('[smoke] dashboard helpers + settings persistence: OK');
    } finally {
      await dashBrowser.close().catch(() => {});
    }
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }

  console.log('[smoke] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
