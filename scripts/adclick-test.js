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

// Page shapes from the real sponsored sites that the first scanner missed:
// label cards without <a href>, cards with many filler nodes, fixed corner
// banners, a native image widget with an ADVERTISEMENT watermark, and an
// unmarked creative-sized iframe. The sticky header / cookie bar / article
// card must stay untouched.
const RICH = `<!doctype html>
<html><head><meta charset="utf-8"><title>sponsored shapes</title>
<style>
  body{margin:0;font-family:Arial,sans-serif;background:#f4f4f4}
  .site-header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:18px;
    padding:10px 16px;background:#fff;border-bottom:1px solid #e5e5e5}
  .site-header a{color:#111;text-decoration:none;font-size:13px}
  .float-ad{position:fixed;top:8px;right:8px;width:300px;height:110px;z-index:30;
    display:flex;gap:8px;padding:8px;background:#1f2937;color:#fff}
  .float-ad .txt{font-size:13px;font-weight:700}
  .float-ad a{color:#93c5fd;font-size:12px}
  .board{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px}
  .js-card,.plain-card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;
    min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
  .badge{font-size:11px;font-weight:700;letter-spacing:.1em;color:#c2410c;border:1px solid #fdba74;
    background:#fff7ed;border-radius:999px;padding:4px 9px}
  .offer{font-size:17px;font-weight:700;color:#111;text-decoration:none}
  .filler{height:2px}
  .native-widget{grid-column:1/-1;position:relative;background:#fff;padding:10px}
  .native-widget .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .native-widget a{color:#111;text-decoration:none;font-weight:700;font-size:13px}
  .native-widget img{width:100%;height:90px;object-fit:cover}
  .wm{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:10px;color:#bbb;letter-spacing:.2em}
  .article-card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:10px}
  .article-card a{color:#111;font-weight:700;text-decoration:none}
  .cookie{position:fixed;left:8px;bottom:8px;width:280px;padding:10px;background:#fff;border:1px solid #ddd;z-index:40;font-size:12px}
  .spacer{height:900px}
</style></head>
<body>
<header class="site-header"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%23333'/%3E%3C/svg%3E" width="24" height="24" alt="">
  <a id="nav1" href="/nav1">Home</a><a id="nav2" href="/nav2">News</a><a id="nav3" href="/nav3">About</a>
</header>

<div class="float-ad">
  <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='70' height='90'%3E%3Crect width='70' height='90' fill='%23b91c1c'/%3E%3C/svg%3E" width="70" height="90" alt="">
  <div><div class="txt">The Best Times to Quit Your Job</div><a id="offerFloat" href="/offer-float">Learn More</a></div>
</div>

<div class="board">
  <div class="js-card">
    <span class="badge">SPONSORED</span>
    <div id="offerJs" class="offer" onclick="location.href='/offer-js'" style="cursor:pointer">Claim this offer now</div>
  </div>

  <div class="js-card">
    <span class="badge">SPONSORED</span>
    <div id="offerBare" class="offer">Sponsored offer without handlers</div>
  </div>

  <div class="plain-card">
    <span class="badge">SPONSORED</span>
    <a id="offerPlain" class="offer" href="/offer-plain">Open the sponsored offer</a>
    <div class="filler"></div><div class="filler"></div><div class="filler"></div>
    <div class="filler"></div><div class="filler"></div><div class="filler"></div>
    <div class="filler"></div><div class="filler"></div><div class="filler"></div>
    <div class="filler"></div><div class="filler"></div>
  </div>

  <div class="native-widget">
    <div class="grid">
      <a id="offerW1" href="/offer-w1"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='90'%3E%3Crect width='200' height='90' fill='%233b82f6'/%3E%3C/svg%3E" alt=""><br>Tuner: Stream without signup</a>
      <a id="offerW2" href="/offer-w2"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='90'%3E%3Crect width='200' height='90' fill='%23ef4444'/%3E%3C/svg%3E" alt=""><br>Divorced women nearby want to talk</a>
      <a id="offerW3" href="/offer-w3"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='90'%3E%3Crect width='200' height='90' fill='%2310b981'/%3E%3C/svg%3E" alt=""><br>Withdrawn 3 times in one week</a>
      <a id="offerW4" href="/offer-w4"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='90'%3E%3Crect width='200' height='90' fill='%23f59e0b'/%3E%3C/svg%3E" alt=""><br>Get Free Spins Now!</a>
    </div>
    <span class="wm">ADVERTISEMENT</span>
  </div>

  <iframe id="adCommon" src="/adframe?o=12" width="300" height="250" style="border:0"></iframe>

  <div class="article-card">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='90'%3E%3Crect width='200' height='90' fill='%236b7280'/%3E%3C/svg%3E" width="200" height="90" alt="">
    <a id="articleLink" href="/article">Read the full story</a>
  </div>

  <div class="spacer"></div>
</div>

<div class="cookie"><p>We use cookies to improve your experience.</p><a id="cookieLink" href="/cookie">Accept all</a></div>
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
    if (url.pathname === '/rich') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RICH);
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

    // ── real-world shapes: label cards, fixed banner, native widget ──────
    console.log('\n[ads] Native / floating / unmarked shapes ...');
    const rich = await context.newPage();
    await rich.goto(base + '/rich', { waitUntil: 'load' });
    await sleep(400);

    const richCandidates = await collectAdCandidates(rich, { config: { adOnly: true } });
    const richIds = await rich.evaluate(
      (sels) =>
        sels.map((s) => {
          try {
            const el = document.querySelector(s);
            return el ? el.id || el.tagName.toLowerCase() : null;
          } catch (_) {
            return null;
          }
        }),
      richCandidates.map((c) => c.sel)
    );
    const richFound = richIds.filter(Boolean);
    const richHas = (id) => richFound.includes(id);

    check('JS-only sponsored card is found', richHas('offerJs'), richFound.join(','));
    check('handler-less label card is found', richHas('offerBare'), richFound.join(','));
    check('label card with filler nodes is found', richHas('offerPlain'), richFound.join(','));
    check(
      'native ADVERTISEMENT widget is found',
      ['offerW1', 'offerW2', 'offerW3', 'offerW4'].some(richHas),
      richFound.join(',')
    );
    check('fixed corner banner is found', richHas('offerFloat'), richFound.join(','));
    check('unmarked creative-size iframe is found', richHas('adCommon'), richFound.join(','));
    check('sticky header links are ignored', !['nav1', 'nav2', 'nav3'].some(richHas), richFound.join(','));
    check('article card link is ignored', !richHas('articleLink'), richFound.join(','));
    check('cookie bar link is ignored', !richHas('cookieLink'), richFound.join(','));

    const richOpened = [];
    const richStats = { clicks: 0 };
    for (let i = 0; i < 12 && richStats.clicks < 5; i++) {
      await adClickOnce(rich, richStats, {
        config: cfg,
        sessionId: 'rich',
        onLog: () => {},
        openBackground: async (href) => {
          richOpened.push(href);
          return null;
        },
      });
      await sleep(120);
    }
    const richAllowed = /^\/(offer-js|offer-plain|offer-w[1-4]|offer-float|offer12)$/;
    check('clicks land on the new ad shapes', richStats.clicks >= 3, 'clicks=' + richStats.clicks);
    check(
      'clicked destinations are all ads',
      richOpened.every((u) => richAllowed.test(new URL(u).pathname)),
      richOpened.join(' ')
    );
    check(
      'header / article / cookie were never clicked',
      !richOpened.some((u) => /^\/(nav|article|cookie)/.test(new URL(u).pathname)),
      richOpened.join(' ')
    );
    await rich.close();

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
