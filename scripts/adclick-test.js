// scripts/adclick-test.js
// Verifies the 5.9.3 "Only click ads" mode with a real Chromium:
//   * only rendered, working ad slots are discovered (blank / hidden / 1x1
//     tracker iframes and ordinary page blocks are ignored);
//   * a click lands inside the ad, never on empty page space;
//   * clicking an ad still opens its destination (through the click shield)
//     and only ad destinations are ever opened;
//   * the classic random clicker keeps working when the option is off.
//
//   node scripts/adclick-test.js
//   xvfb-run -a node scripts/adclick-test.js   (headless Linux CI)

'use strict';

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'browser-launcher.js'));
const {
  normalizeRandomClickConfig,
  collectAdCandidates,
  adClickOnce,
  randomClickOnce,
} = require(path.join(ROOT, 'RandomClicker.js'));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// ── fixture page ───────────────────────────────────────────────────────────
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ad fixture</title>
<style>
  body{margin:0;font-family:Arial,sans-serif;background:#f5f5f5}
  .wrap{padding:16px}
  .spacer{height:1200px}
  .sponsored-card{display:flex;gap:10px;align-items:center;padding:16px;margin:14px 0;
    background:#fff;border:1px solid #eee;border-radius:10px}
  .sponsored-card .lbl{font-size:11px;font-weight:700;letter-spacing:.08em;color:#b45309}
  .banner{height:120px;display:flex;align-items:center;justify-content:center;background:#e2e8f0}
</style></head>
<body>
<div class="wrap">
  <h1>Content page</h1>
  <p>Normal article text that a visitor would read.</p>

  <!-- 1. working display ad (visible, filled, same-origin creative) -->
  <iframe id="ad-live" src="/adframe?o=1" width="320" height="120" style="border:0;display:block"></iframe>

  <!-- 2. hidden ad slot -->
  <iframe id="ad-hidden" src="/adframe?o=2" width="320" height="120" style="border:0;display:none"></iframe>

  <!-- 3. 1x1 tracking iframe -->
  <iframe id="ad-tiny" src="/adframe?o=3" width="1" height="1" style="border:0"></iframe>

  <!-- 4. ad slot that never filled (blank) -->
  <iframe id="ad-blank" src="about:blank" width="320" height="120" style="border:0;display:block"></iframe>

  <!-- 5. native sponsored card -->
  <div class="sponsored-card">
    <span class="lbl">SPONSORED</span>
    <a id="spon5" href="/offer5">See today's offers</a>
  </div>

  <!-- 6. ordinary hero banner: not an ad -->
  <div class="banner"><a id="notad" href="/notad">Welcome to our website</a></div>

  <!-- 7. hidden sponsored card -->
  <div class="sponsored-card" style="display:none">
    <span class="lbl">SPONSORED</span><a id="spon6" href="/offer6">Hidden offer</a>
  </div>

  <!-- 8. transparent sponsored card -->
  <div class="sponsored-card" style="opacity:0">
    <span class="lbl">SPONSORED</span><a id="spon9" href="/offer9">Invisible offer</a>
  </div>

  <!-- 9. adsbygoogle unit with a real link -->
  <ins class="adsbygoogle" data-ad-slot="123" style="display:block;width:300px;height:80px;background:#fff">
    <a id="ins8" href="/offer8" style="display:block;width:100%;height:100%">Ad unit</a>
  </ins>

  <div class="spacer"></div>

  <!-- 10. ad far below the fold: must be scrolled to, then clicked -->
  <iframe id="below7" class="adunit" src="/adframe?o=7" width="320" height="120" style="border:0;display:block"></iframe>
</div>
</body></html>`;

function startFixtureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push({ path: url.pathname, query: url.search });
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
      return;
    }
    if (url.pathname === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>No ads here</h1><p>Just text.</p></body></html>');
      return;
    }
    if (url.pathname === '/adframe') {
      const offer = (url.searchParams.get('o') || '0').replace(/\D/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body style="margin:0">` +
          `<a id="f${offer}" href="/offer${offer}" style="display:block;width:100%;height:100%;` +
          `background:#fff;color:#111;font-size:14px;text-align:center;line-height:120px;text-decoration:none">` +
          `Sponsored offer ${offer}</a></body></html>`
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>offer</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port, hits });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[ads] Only-click-ads regression test');

  // ── static config checks (no browser needed) ───────────────────────────
  console.log('\n[ads] Config normalisation ...');
  {
    const on = normalizeRandomClickConfig({ enabled: true, adOnly: true });
    const off = normalizeRandomClickConfig({ enabled: true });
    check('adOnly defaults to false', off.adOnly === false);
    check('adOnly=true is preserved', on.adOnly === true);
    check(
      'minimum creative size is enforced',
      on.adMinWidth >= 20 && on.adMinHeight >= 10,
      `${on.adMinWidth}x${on.adMinHeight}`
    );
    const legacy = normalizeRandomClickConfig({ enabled: true, burstMin: 3, burstMax: 4 });
    check('legacy configs still normalise', legacy.clickGapMinMs >= 50 && legacy.burstMin === 3);
  }

  const { server, base, hits } = await startFixtureServer();
  const browser = await launchBrowser({
    headless: true,
    args: [],
    sessionId: 'adclick-test',
    onLog: () => {},
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 700 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // ── discovery ────────────────────────────────────────────────────────
    console.log('\n[ads] Ad slot discovery ...');
    await page.goto(base + '/', { waitUntil: 'load' });
    await sleep(400);

    const candidates = await collectAdCandidates(page, { config: { adOnly: true } });
    const ids = await page.evaluate(
      (sels) =>
        sels.map((s) => {
          try {
            const el = document.querySelector(s);
            return el ? el.id || el.tagName.toLowerCase() : null;
          } catch (_) {
            return null;
          }
        }),
      candidates.map((c) => c.sel)
    );
    const found = ids.filter(Boolean);
    const has = (id) => found.includes(id);

    check('working display ad is found', has('ad-live'), found.join(','));
    check('native sponsored card is found', has('spon5'), found.join(','));
    check('adsbygoogle unit is found', has('ins8'), found.join(','));
    check('below-the-fold ad is found', has('below7'), found.join(','));
    check('hidden ad is ignored', !has('ad-hidden'), found.join(','));
    check('1x1 tracker is ignored', !has('ad-tiny'), found.join(','));
    check('blank / unfilled slot is ignored', !has('ad-blank'), found.join(','));
    check('hero banner is ignored', !has('notad'), found.join(','));
    check('hidden sponsored card is ignored', !has('spon6'), found.join(','));
    check('transparent sponsored card is ignored', !has('spon9'), found.join(','));
    check(
      'only ad-looking slots are returned',
      candidates.length === 4,
      `got ${candidates.length}: ${found.join(',')}`
    );

    // ── clicking ─────────────────────────────────────────────────────────
    console.log('\n[ads] Ad clicks ...');
    const cfg = normalizeRandomClickConfig({ enabled: true, adOnly: true, maxClicks: 0 });
    const opened = [];
    const stats = { clicks: 0 };
    const wanted = /\/offer(1|5|7|8)$/;

    for (let i = 0; i < 14 && stats.clicks < 6; i++) {
      await adClickOnce(page, stats, {
        config: cfg,
        sessionId: 'test',
        onLog: () => {},
        openBackground: async (href) => {
          opened.push(href);
          return null;
        },
      });
      await sleep(120);
    }

    check('clicks were dispatched', stats.clicks >= 4, 'clicks=' + stats.clicks);
    check(
      'ad destinations were opened',
      opened.length >= 4,
      'opened=' + opened.length
    );
    check(
      'every opened destination belongs to an ad slot',
      opened.length > 0 && opened.every((u) => wanted.test(new URL(u).pathname)),
      opened.join(' ')
    );
    check(
      'blocked page blocks (banner / hidden cards) were never opened',
      !opened.some((u) => /\/(notad|offer6|offer9|offer2|offer3)$/.test(new URL(u).pathname)),
      opened.join(' ')
    );
    check('no click was wasted on whitespace', stats.clicks === (stats.adClicks || 0));

    // ── no ads on the page: nothing may be clicked ───────────────────────
    console.log('\n[ads] Page with no ads ...');
    const plain = await context.newPage();
    await plain.goto(base + '/plain', { waitUntil: 'load' });
    await sleep(300);

    const none = await collectAdCandidates(plain, { config: { adOnly: true } });
    check('no candidates on an ad-free page', none.length === 0, 'got ' + none.length);

    const plainStats = { clicks: 0 };
    const clicked = await randomClickOnce(plain, plainStats, {
      config: cfg,
      sessionId: 'test',
      onLog: () => {},
      openBackground: async () => null,
    });
    check('ad-only click refuses to click empty space', clicked === false && plainStats.clicks === 0);

    // ── classic random clicking still works ──────────────────────────────
    console.log('\n[ads] Classic random clicks (option off) ...');
    const normal = normalizeRandomClickConfig({ enabled: true, maxClicks: 0 });
    const normalStats = { clicks: 0 };
    const normalClicked = await randomClickOnce(plain, normalStats, {
      config: normal,
      sessionId: 'test',
      onLog: () => {},
      openBackground: async () => null,
    });
    check('random click still dispatches when adOnly is off', normalClicked === true && normalStats.clicks === 1);

    // ── startRandomClicker integration ───────────────────────────────────
    console.log('\n[ads] startRandomClicker integration ...');
    {
      const { startRandomClicker } = require(path.join(ROOT, 'RandomClicker.js'));
      const clicker = startRandomClicker(plain, {
        config: { enabled: true, adOnly: true, initialDelaySec: 0, burstMin: 2, burstMax: 2, maxClicks: 2 },
        sessionId: 'test',
        onLog: () => {},
      });
      await sleep(1200);
      const st = clicker.getStats();
      clicker.stop();
      check(
        'ad-only clicker reports zero clicks when the page has no ads',
        st.clicks === 0 && (st.adScans || 0) > 0,
        `clicks=${st.clicks} scans=${st.adScans}`
      );
    }

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(`\n[ads] Result: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[ads] fatal:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
