// scripts/system-check-test.js
// Verification for the read-only Session Diagnostics feature:
//   * GET  /api/system/check            -> CPU/RAM/disk/browser + thread limit
//   * POST /api/diagnostics/fingerprint -> fingerprint consistency audit
//
//   node scripts/system-check-test.js
//   xvfb-run -a node scripts/system-check-test.js   (headless Linux CI)
//
// The audit is intentionally read-only: it opens one short-lived headless
// browser, reads JS-visible values and closes it. No page is clicked, no
// campaign is started and no settings file is written.

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const Diagnostics = require(path.join(ROOT, 'Diagnostics.js'));
const pkg = require(path.join(ROOT, 'package.json'));

let passes = 0;
let failures = 0;
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log(`  [PASS] ${name}${detail ? ' -> ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function findCheck(result, id) {
  return (result.checks || []).find((c) => c.id === id) || null;
}

// Build a fully consistent desktop environment for unit-level check tests.
function goodDesktopEnv() {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webdriver: false,
    plugins: 5,
    mimeTypes: 2,
    timezone: 'Asia/Kolkata',
    screen: { width: 1366, height: 768, colorDepth: 24, pixelDepth: 24 },
    innerWidth: 1366,
    innerHeight: 768,
    outerWidth: 1366,
    outerHeight: 768,
    dpr: 1,
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce GTX 1650 Direct3D11)' },
    canvasHash: 'abc123',
    canvasHash2: 'abc123',
    uaData: { mobile: false, platform: 'Windows', brands: ['Chromium 131'] },
    chrome: true,
    maxTouchPoints: 0,
  };
}

const DESKTOP_EXPECTED = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  device: 'desktop',
  platform: 'Win32',
  chPlatform: 'Windows',
  chMobile: '?0',
  timezone: '',
  viewport: { width: 1366, height: 768 },
  features: new Set(),
};

async function testSystemInfo() {
  console.log('\n[system] local preflight');
  const info = Diagnostics.collectSystemInfo();
  check('cpu cores positive', info.cores > 0, String(info.cores));
  check('total memory reported', info.totalMemGB > 0, info.totalMemGB + ' GB');
  check(
    'recommended threads within 1..20',
    info.recommendedThreads >= 1 && info.recommendedThreads <= 20,
    String(info.recommendedThreads)
  );
  check('recommended threads formula', Diagnostics.recommendedThreads() === info.recommendedThreads);
  check('data dir writable', info.dataDirWritable === true, info.dataDir);
  check('app version matches package.json', info.appVersion === pkg.version, info.appVersion);
  check('browser path detected', info.browserPath.length > 0 || info.browserOk, info.browserPath || 'none');
  check('running campaigns is a number', Number.isInteger(info.runningCampaigns), String(info.runningCampaigns));
  if (info.freeDiskGB == null) notes.push('free disk space not available on this platform');
}

async function testBuildChecks() {
  console.log('\n[system] fingerprint check rules');

  const good = Diagnostics.buildChecks(goodDesktopEnv(), DESKTOP_EXPECTED);
  const fails = good.filter((c) => c.status === 'fail');
  check('consistent desktop env has no failures', fails.length === 0, fails.map((c) => c.id).join(', ') || 'clean');
  check('consistent desktop env scores 100', Diagnostics.scoreChecks(good) === 100, String(Diagnostics.scoreChecks(good)));
  check('canvas stability verified', findCheck({ checks: good }, 'canvas').status === 'pass');
  check('webdriver hidden verified', findCheck({ checks: good }, 'webdriver').status === 'pass');

  const badPlatform = Object.assign({}, goodDesktopEnv(), { platform: 'Linux x86_64' });
  const badPlatformChecks = Diagnostics.buildChecks(badPlatform, DESKTOP_EXPECTED);
  check(
    'UA/platform mismatch fails',
    findCheck({ checks: badPlatformChecks }, 'ua_platform').status === 'fail'
  );

  const mobileEnv = Object.assign({}, goodDesktopEnv(), {
    platform: 'Linux armv8l',
    uaData: { mobile: true, platform: 'Android', brands: ['Chromium 131'] },
    maxTouchPoints: 5,
    dpr: 3,
    screen: { width: 390, height: 844, colorDepth: 24, pixelDepth: 24 },
    innerWidth: 390,
    innerHeight: 844,
  });
  const mobileExpected = {
    ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    device: 'mobile',
    platform: 'Linux armv8l',
    chPlatform: 'Android',
    chMobile: '?1',
    timezone: '',
    viewport: { width: 390, height: 844 },
    features: new Set(),
  };
  const mobileChecks = Diagnostics.buildChecks(mobileEnv, mobileExpected);
  const mobileFails = mobileChecks.filter((c) => c.status === 'fail');
  check('consistent mobile env has no failures', mobileFails.length === 0, mobileFails.map((c) => c.id).join(', ') || 'clean');
  check('mobile touch support detected', findCheck({ checks: mobileChecks }, 'touch').status === 'pass');

  const desktopWithTouch = Object.assign({}, goodDesktopEnv(), { maxTouchPoints: 5 });
  check(
    'desktop with touch points fails',
    findCheck({ checks: Diagnostics.buildChecks(desktopWithTouch, DESKTOP_EXPECTED) }, 'touch').status === 'fail'
  );

  const noisyCanvas = Object.assign({}, goodDesktopEnv(), { canvasHash2: 'deadbeef' });
  check(
    'unstable canvas noise fails',
    findCheck({ checks: Diagnostics.buildChecks(noisyCanvas, DESKTOP_EXPECTED) }, 'canvas').status === 'fail'
  );

  const smallScreen = Object.assign({}, goodDesktopEnv(), { screen: { width: 320, height: 200 } });
  check(
    'screen smaller than viewport fails',
    findCheck({ checks: Diagnostics.buildChecks(smallScreen, DESKTOP_EXPECTED) }, 'screen').status === 'fail'
  );

  const softwareGl = Object.assign({}, goodDesktopEnv(), {
    webgl: { vendor: 'Google Inc.', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' },
  });
  check(
    'software WebGL is a warning, not a failure',
    findCheck({ checks: Diagnostics.buildChecks(softwareGl, DESKTOP_EXPECTED) }, 'webgl').status === 'warn'
  );

  const emptyExpected = Object.assign({}, DESKTOP_EXPECTED, { platform: '', chPlatform: '' });
  check(
    'missing platform is a warning',
    findCheck({ checks: Diagnostics.buildChecks(goodDesktopEnv(), emptyExpected) }, 'ua_platform').status === 'warn'
  );

  const tzExpected = Object.assign({}, DESKTOP_EXPECTED, { timezone: 'Asia/Calcutta' });
  check(
    'timezone aliases are accepted',
    findCheck({ checks: Diagnostics.buildChecks(goodDesktopEnv(), tzExpected) }, 'timezone').status === 'pass'
  );
}

async function testViewportNormalization() {
  console.log('\n[system] viewport normalisation');
  const desktop = Diagnostics.normalizeViewport({}, 'desktop');
  check('desktop fallback', desktop.width === 1366 && desktop.height === 768 && !desktop.hasTouch);
  const mobile = Diagnostics.normalizeViewport({}, 'mobile');
  check('mobile fallback is touch + hi-dpi', mobile.hasTouch && mobile.isMobile && mobile.deviceScaleFactor >= 2);
  const tablet = Diagnostics.normalizeViewport({}, 'tablet');
  check('tablet fallback is touch, not mobile', tablet.hasTouch && !tablet.isMobile && tablet.deviceScaleFactor >= 2);
  const custom = Diagnostics.normalizeViewport({ viewportWidth: 1440, viewportHeight: 900, deviceScaleFactor: 1 }, 'desktop');
  check('custom viewport respected', custom.width === 1440 && custom.height === 900);
  const clamped = Diagnostics.normalizeViewport({ viewportWidth: 10, viewportHeight: 10 }, 'desktop');
  check('absurd viewport falls back', clamped.width === 1366 && clamped.height === 768);
}

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

async function testAudit(device, extras) {
  const label = device + (extras && extras.privacyFeatures && extras.privacyFeatures.length ? ' + privacy' : '');
  console.log(`\n[system] live audit: ${label}`);
  const started = Date.now();
  const opts = Object.assign({ device }, extras || {});
  // The UA is the primary signal (see SessionProfile.resolveSessionDevice), so a
  // mobile audit must use a mobile UA or it is really a desktop audit.
  if (device === 'mobile' && !opts.userAgent) opts.userAgent = MOBILE_UA;
  const result = await Diagnostics.runFingerprintAudit(opts);
  const elapsed = Date.now() - started;
  check('audit returned checks', (result.checks || []).length >= 10, String((result.checks || []).length));
  check('audit score in range', result.score >= 0 && result.score <= 100, result.score + '%');
  check('audit finished under 120s', elapsed < 120000, elapsed + ' ms');
  check('audit ran in headless browser', !!result.environment.userAgent, result.environment.userAgent.slice(0, 40) + '...');

  const webdriver = findCheck(result, 'webdriver');
  check('live navigator.webdriver hidden', !!webdriver && webdriver.status === 'pass', webdriver && webdriver.detail);

  const canvas = findCheck(result, 'canvas');
  check('live canvas deterministic', !!canvas && canvas.status === 'pass', canvas && canvas.detail);

  const viewport = findCheck(result, 'viewport');
  check('live viewport usable', !!viewport && viewport.status !== 'fail', viewport && viewport.detail);

  const screen = findCheck(result, 'screen');
  check('live screen covers viewport', !!screen && screen.status === 'pass', screen && screen.detail);

  const platform = findCheck(result, 'ua_platform');
  const expectPlatform = extras && extras.expectPlatform;
  if (expectPlatform) {
    check('live platform matches the UA (' + expectPlatform + ')', !!platform && platform.status === expectPlatform, platform && platform.detail);
  } else if (device === 'mobile') {
    // On a desktop host a mobile UA must be flagged unless Platform Spoofing
    // (or another consistent profile) is enabled. The audit must never call
    // this "healthy" silently.
    check('live mobile platform mismatch is reported', !!platform && platform.status === 'fail', platform && platform.detail);
  } else {
    // A Windows UA on a Linux/macOS host is also a real mismatch. Without
    // Platform Spoofing the audit must return a definite verdict, never skip.
    check('live platform check returns a verdict', !!platform && (platform.status === 'pass' || platform.status === 'fail'), platform && platform.detail);
  }

  const hints = findCheck(result, 'client_hints');
  check('live Client Hints readable', !!hints && hints.status !== 'warn', hints && hints.detail);

  if (device === 'mobile') {
    const touch = findCheck(result, 'touch');
    check('live mobile touch enabled', !!touch && touch.status === 'pass', touch && touch.detail);
    check('live mobile DPR >= 1.5', result.environment.viewport.dpr >= 1.5, String(result.environment.viewport.dpr));
  }

  // Privacy features must actually be active inside the audited context.
  if (extras && extras.privacyFeatures && extras.privacyFeatures.length) {
    check('privacy guard reported applied features', (result.expected.privacyApplied || 0) > 0, String(result.expected.privacyApplied));
    check('privacy guard had no error', !result.expected.privacyError, result.expected.privacyError || 'none');
  }

  if (result.failed > 0 && !(extras && extras.expectPlatform)) {
    notes.push(`${label} audit failures: ` + result.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(', '));
  }
  return result;
}

async function testEndpoints() {
  console.log('\n[system] HTTP endpoints');
  const port = 3994;
  process.env.TRAFFICDRIVE_PORT = String(port);
  const server = require(path.join(ROOT, 'server.js'));
  const handle = await server.startServer();
  const base = `http://127.0.0.1:${port}`;
  const getJson = async (url, opts) => {
    const res = await fetch(url, opts);
    return { status: res.status, body: await res.json() };
  };
  try {
    const health = await getJson(base + '/api/health');
    check('health endpoint', health.status === 200 && health.body.success === true, String(health.status));

    const sys = await getJson(base + '/api/system/check');
    check('system check endpoint', sys.status === 200 && sys.body.success === true, String(sys.status));
    check('system check includes threads', Number.isInteger(sys.body.recommendedThreads), String(sys.body.recommendedThreads));
    check('system check includes platform', typeof sys.body.platform === 'string', sys.body.platform);

    const audit = await getJson(base + '/api/diagnostics/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'desktop' }),
    });
    check('fingerprint endpoint', audit.status === 200 && audit.body.success === true, String(audit.status));
    check('fingerprint endpoint returns score', typeof audit.body.score === 'number', String(audit.body.score));
    check('fingerprint endpoint returns checks', Array.isArray(audit.body.checks) && audit.body.checks.length > 0, String((audit.body.checks || []).length));

    const bad = await getJson(base + '/api/diagnostics/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    check('invalid JSON is rejected', bad.status === 400 && bad.body.success === false, String(bad.status));
  } finally {
    try { await new Promise((resolve) => handle.close(resolve)); } catch (_) {}
  }
}

async function main() {
  console.log('[system] Diagnostics verification');

  await testSystemInfo();
  await testBuildChecks();
  await testViewportNormalization();

  await testAudit('desktop');
  await testAudit('mobile');
  await testAudit('mobile', { privacyFeatures: ['platform-spoof'], expectPlatform: 'pass' });
  await testAudit('desktop', {
    privacyFeatures: ['webgl-spoof', 'canvas-noise', 'platform-spoof', 'timezone-spoof', 'language-spoof'],
    privacyLevel: 'balanced',
    expectPlatform: 'pass',
  });

  await testEndpoints();

  console.log(`\n[system] Result: ${passes} passed, ${failures} failed`);
  if (notes.length) notes.forEach((n) => console.log('[system] note:', n));
  if (failures) {
    console.log('[system] FAILED');
    process.exit(1);
  }
  console.log('[system] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[system] fatal:', err);
  process.exit(1);
});
