// scripts/proxy-rotation-test.js
// Verifies the 5.9.8 anti-ban IP rotation policy without opening a browser:
//   * duplicate host:port entries behind one exit IP are merged
//   * every session/round gets a different exit IP while one is available
//   * one IP is never used more than the hard cap (5) inside the 12 h window
//   * failed exits get a cooldown instead of being reused immediately
//   * countries are mixed when there is a choice
//   * the campaign modules and the RPA replay actually use this allocator
//
//   node scripts/proxy-rotation-test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rotation = require(path.join(ROOT, 'ProxyRotation.js'));

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

function proxy(host, port, extra = {}) {
  return { type: 'http', host, port, ...extra };
}

function reset() {
  rotation.resetRotationState();
}

function fresh() {
  rotation.configureProxyUsage({
    file: '',
    windowMs: 12 * 60 * 60 * 1000,
    softLimit: 3,
    hardLimit: 5,
    minGapMs: 20 * 60 * 1000,
  });
  rotation.resetRotationState();
}

// ── 1. dedupe by real exit IP ───────────────────────────────────────────────
fresh();
{
  const list = [
    proxy('102.244.78.61', 8081, { egressIp: '102.244.78.57', countryCode: 'PK' }),
    proxy('102.244.78.61', 8082, { egressIp: '102.244.78.57', countryCode: 'PK' }),
    proxy('102.244.78.61', 8086, { egressIp: '102.244.78.57', countryCode: 'PK' }),
    proxy('195.158.8.123', 3128, { egressIp: '195.158.8.123', countryCode: 'UZ' }),
    proxy('45.189.57.114', 3129, { egressIp: '45.189.57.114', countryCode: 'US' }),
  ];
  const pool = rotation.dedupeProxyPool(list);
  check('duplicate ports behind one exit IP merge into one', pool.length === 3, `got ${pool.length}`);
  const exits = new Set(pool.map(p => rotation.proxyExitIdentity(p)));
  check('merged pool has 3 distinct exit identities', exits.size === 3, `got ${exits.size}`);
}

{
  const list = [
    proxy('10.0.0.1', 1000),
    proxy('10.0.0.1', 1000),
    proxy('10.0.0.2', 1000),
  ];
  const pool = rotation.dedupeProxyPool(list);
  check('unknown egress: identical host:port merges, other host stays', pool.length === 2, `got ${pool.length}`);
}

{
  // Rotating endpoints are a new IP per session by design and must be kept.
  const list = [
    proxy('rot.example.com', 8000, { rotating: true, username: 'u' }),
    proxy('rot.example.com', 8000, { rotating: true, username: 'u' }),
    proxy('static.example.com', 8000, { egressIp: '1.2.3.4' }),
    proxy('static2.example.com', 8000, { egressIp: '1.2.3.4' }),
  ];
  const pool = rotation.dedupeProxyPool(list);
  check('rotating exits are kept, static duplicate exits merge', pool.length === 2, `got ${pool.length}`);
}

// ── 2. buildRotationPool never shrinks to the target-verified subset ───────
{
  const targetOk = proxy('1.1.1.1', 80, { egressIp: '1.1.1.1', targetOk: true, targetUrl: 'https://t.example/' });
  const working = [
    targetOk,
    proxy('2.2.2.2', 80, { egressIp: '2.2.2.2' }),
    proxy('3.3.3.3', 80, { egressIp: '3.3.3.3' }),
    proxy('4.4.4.4', 80, { egressIp: '4.4.4.4' }),
  ];
  const pool = rotation.buildRotationPool({
    workingProxies: working.slice(0, 1), // old payload: target-verified only
    proxies: working,
    checkUrl: 'https://t.example/',
  });
  check('buildRotationPool keeps every distinct working exit', pool.length === 4, `got ${pool.length}`);
  check('target-verified exit is first', rotation.proxyExitIdentity(pool[0]) === 'ip:1.1.1.1');
}

// ── 3. consecutive picks are distinct (sessions and rounds) ────────────────
fresh();
{
  const pool = Array.from({ length: 8 }, (_, i) => proxy(`5.5.5.${i + 1}`, 8080, { egressIp: `5.5.5.${i + 1}` }));
  const picks = [];
  for (let i = 0; i < 8; i++) picks.push(rotation.proxyExitIdentity(rotation.acquireRotationProxy(pool)));
  check('8 consecutive picks use 8 distinct exit IPs', new Set(picks).size === 8, picks.join(','));

  // Cycle boundary: the 9th pick must not equal the 8th.
  const ninth = rotation.proxyExitIdentity(rotation.acquireRotationProxy(pool));
  check('first pick of the next cycle differs from the previous pick', ninth !== picks[picks.length - 1]);

  // Parallel sessions: four immediate picks must be four different IPs.
  fresh();
  const parallel = [];
  for (let i = 0; i < 4; i++) parallel.push(rotation.proxyExitIdentity(rotation.acquireRotationProxy(pool)));
  check('4 parallel sessions get 4 different exit IPs', new Set(parallel).size === 4, parallel.join(','));
}

// ── 4. hard cap: an IP is never reused forever ─────────────────────────────
fresh();
{
  const pool = [proxy('9.9.9.9', 8080, { egressIp: '9.9.9.9' })];
  let ok = 0;
  for (let i = 0; i < 5; i++) if (rotation.acquireRotationProxy(pool)) ok++;
  const meta = {};
  const sixth = rotation.acquireRotationProxy(pool, meta);
  check('single IP allows exactly 5 uses per 12 h', ok === 5, `allowed ${ok}`);
  check('6th use is blocked (no silent IP reuse)', sixth === null);
  check('blocked pick reports when an IP frees up', meta.tier === 99 && meta.waitMs > 0, JSON.stringify(meta));
}

fresh();
{
  const pool = [
    proxy('9.9.9.10', 8080, { egressIp: '9.9.9.10' }),
    proxy('9.9.9.11', 8080, { egressIp: '9.9.9.11' }),
  ];
  let ok = 0;
  for (let i = 0; i < 10; i++) if (rotation.acquireRotationProxy(pool)) ok++;
  const eleventh = rotation.acquireRotationProxy(pool);
  check('2 IPs allow exactly 10 safe uses', ok === 10, `allowed ${ok}`);
  check('11th use is blocked', eleventh === null);
}

// ── 5. failure cooldown ────────────────────────────────────────────────────
fresh();
{
  const a = proxy('7.7.7.1', 8080, { egressIp: '7.7.7.1' });
  const b = proxy('7.7.7.2', 8080, { egressIp: '7.7.7.2' });
  const pool = [a, b];
  const first = rotation.acquireRotationProxy(pool);
  rotation.markProxyFailure(first, 'timeout');
  const afterFail = rotation.acquireRotationProxy(pool);
  check('failed exit is skipped for the next pick', rotation.proxyExitIdentity(afterFail) !== rotation.proxyExitIdentity(first),
    `${rotation.proxyExitIdentity(first)} -> ${rotation.proxyExitIdentity(afterFail)}`);
  const snap = rotation.getProxyUsageSnapshot(pool);
  check('snapshot reports the cooling exit', snap.cooling === 1, JSON.stringify(snap));
}

// ── 6. country mixing ──────────────────────────────────────────────────────
fresh();
{
  const us = proxy('8.8.8.1', 8080, { egressIp: '8.8.8.1', countryCode: 'US' });
  const de = proxy('8.8.8.2', 8080, { egressIp: '8.8.8.2', countryCode: 'DE' });
  const pool = [us, de];
  const first = rotation.acquireRotationProxy(pool);
  const second = rotation.acquireRotationProxy(pool);
  const c1 = rotation.proxyCountry(first);
  const c2 = rotation.proxyCountry(second);
  check('second pick switches country when possible', c1 !== c2, `${c1} -> ${c2}`);
}

// ── 7. ledger persistence ──────────────────────────────────────────────────
{
  const dir = path.join(os.tmpdir(), 'kg-trf-rotation-test-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'proxy-usage.json');
  try { fs.unlinkSync(file); } catch (_) {}
  rotation.configureProxyUsage({ file, windowMs: 12 * 60 * 60 * 1000, softLimit: 3, hardLimit: 5, minGapMs: 0 });
  rotation.resetRotationState();
  const p = proxy('6.6.6.6', 8080, { egressIp: '6.6.6.6' });
  rotation.acquireRotationProxy([p]);
  rotation.flushUsage();
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const entry = saved && saved.entries && saved.entries['ip:6.6.6.6'];
  check('usage is persisted to disk', !!entry && Array.isArray(entry.uses) && entry.uses.length === 1,
    JSON.stringify(saved && saved.entries));
  try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch (_) {}
}

// ── 7b. usage identity migration (unknown host -> proven exit IP) ─────────
fresh();
{
  rotation.configureProxyUsage({ file: '', windowMs: 12 * 60 * 60 * 1000, softLimit: 1, hardLimit: 1, minGapMs: 0 });
  rotation.resetRotationState();
  const unknown = proxy('3.3.3.3', 8080); // no egress known yet
  const known = proxy('3.3.3.3', 9999, { egressIp: '3.3.3.3' }); // same IP, other port
  const first = rotation.acquireRotationProxy([unknown]);
  check('unknown-egress proxy is reserved', !!first);
  rotation.markProxySuccess(unknown, { egressIp: '3.3.3.3', country: 'US' });
  const second = rotation.acquireRotationProxy([known]);
  check('usage follows the proven exit IP (no fresh budget for same IP)', second === null, second && rotation.proxyExitIdentity(second));
}

// ── 8. source wiring (campaigns + RPA) ─────────────────────────────────────
{
  const files = ['Directtraffic.js', 'Organic Search.js', 'SocialTraffic.js', 'Google map traffic.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`${f}: builds a distinct-exit rotation pool`, /buildRotationPool\(proxiesData\)/.test(src) && /acquireRotationProxy\(proxyPool/.test(src));
    check(`${f}: no host:port round-robin left`, !/proxyPool\[\(sessionNum \+ proxyOffset\)/.test(src));
  }
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('server: RPA pool deduped by exit IP', /dedupeProxyPool\(rawPool\)/.test(server));
  check('server: RPA picks through the shared allocator', /acquireRotationProxy\(opts\.proxyPool/.test(server));
  check('server: RPA reports safe-rotation stats', /getProxyUsageSnapshot/.test(server));
  check('server: usage ledger is persisted', /configureProxyUsage\(\{ file: PROXY_USAGE_FILE \}\)/.test(server));
}

// ── 9. runWithProxyRetry uses the deduped pool size ────────────────────────
(async () => {
  fresh();
  let calls = 0;
  const config = {
    proxies: {
      useProxies: true,
      checkUrl: '',
      // 4 host:port entries, only 2 real exit IPs.
      workingProxies: [
        proxy('4.4.4.1', 1, { egressIp: '4.4.4.1' }),
        proxy('4.4.4.1', 2, { egressIp: '4.4.4.1' }),
        proxy('4.4.4.2', 1, { egressIp: '4.4.4.2' }),
        proxy('4.4.4.2', 2, { egressIp: '4.4.4.2' }),
      ],
      proxies: [],
    },
  };
  await rotation.runWithProxyRetry({
    config,
    runOnce: async () => { calls++; return 'proxy_blocked'; },
  });
  check('retry count is based on distinct exits, not duplicate ports', calls === 2, `calls=${calls}`);

  console.log('');
  console.log(`Proxy rotation: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
