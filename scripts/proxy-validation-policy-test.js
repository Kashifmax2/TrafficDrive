// scripts/proxy-validation-policy-test.js
// Verifies the 5.9.11 proxy-validation policy without touching the network:
//   * unknown proxy + timeout is dead
//   * a verified proxy survives one slow check (kept verified + flaky)
//   * it becomes dead only after two consecutive soft failures
//   * auth errors / tunnel failures still kill a proxy immediately
//   * target-site blocks (403/429/"proxy detected") keep the tunnel verified
//   * failures of our own browser/job leave the status untouched
//   * a recovered proxy becomes verified again
//
//   node scripts/proxy-validation-policy-test.js

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  classifyProxyOutcome,
  isTargetBlockReason,
  isSoftFailReason,
} = require(path.join(ROOT, 'server.js'));

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

function fail(reason, extra = {}) {
  return { ok: false, reason, ms: 0, ...extra };
}

function pass(ms = 1200) {
  return { ok: true, reason: 'ok', ms };
}

console.log('Proxy validation policy (v5.9.11)');

// ── 1. never-validated proxy that times out ─────────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'unknown' }, fail('timeout'));
  check('unknown + timeout -> dead', o.status === 'dead' && !o.skipped, JSON.stringify(o));
}

// ── 2. verified proxy survives one slow check ───────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('timeout'));
  check('ok + timeout -> still ok + flaky', o.status === 'ok' && o.flaky === true, JSON.stringify(o));
}

// ── 3. second consecutive soft failure kills it ─────────────────────────────
{
  const first = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('timeout'));
  const second = classifyProxyOutcome({ status: first.status, softFails: first.softFails }, fail('timeout'));
  check('ok + 2x timeout -> dead', second.status === 'dead' && second.flaky === false, JSON.stringify(second));
}

// ── 4. auth failure is a real dead proxy ────────────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('auth'));
  check('ok + auth -> dead', o.status === 'dead' && o.skipped === false, JSON.stringify(o));
}

// ── 5. target blocked the IP, tunnel is fine ────────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'unknown' }, fail('site_blocked'));
  check('site_blocked -> ok + targetBlocked', o.status === 'ok' && o.targetBlocked === true, JSON.stringify(o));
}

// ── 6. HTTP 403/429 count as target blocks, not tunnel failures ─────────────
{
  const a = classifyProxyOutcome({ status: 'unknown' }, fail('http_403'));
  const b = classifyProxyOutcome({ status: 'dead' }, fail('http_429'));
  check('http_403 -> ok + targetBlocked', a.status === 'ok' && a.targetBlocked === true, JSON.stringify(a));
  check('dead + http_429 -> revived ok + targetBlocked', b.status === 'ok' && b.targetBlocked === true, JSON.stringify(b));
}

// ── 7. proxy_detected is also a target result ───────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('proxy_detected'));
  check('proxy_detected -> ok + targetBlocked', o.status === 'ok' && o.targetBlocked === true, JSON.stringify(o));
}

// ── 8. our own browser/job failed: status must not change ───────────────────
{
  const o = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('browser_error'));
  check('ok + browser_error -> skipped, stays ok', o.skipped === true && o.status === 'ok', JSON.stringify(o));
}
{
  const o = classifyProxyOutcome({ status: 'unknown' }, fail('aborted'));
  check('unknown + aborted -> skipped, stays unknown', o.skipped === true && o.status === 'unknown', JSON.stringify(o));
}
{
  const o = classifyProxyOutcome({ status: 'dead' }, fail('browser_closed'));
  check('dead + browser_closed -> skipped, stays dead', o.skipped === true && o.status === 'dead', JSON.stringify(o));
}

// ── 9. recovery: dead proxy that works again ────────────────────────────────
{
  const o = classifyProxyOutcome({ status: 'dead', softFails: 2 }, pass(5400));
  check('dead + ok -> ok (softFails reset)', o.status === 'ok' && o.flaky === false && o.softFails === 0, JSON.stringify(o));
}

// ── 10. a dead proxy that soft-fails again stays dead, no strike carry-over ─
{
  const o = classifyProxyOutcome({ status: 'dead', softFails: 0 }, fail('http_503'));
  check('dead + http_503 -> dead, softFails 0', o.status === 'dead' && o.softFails === 0, JSON.stringify(o));
}

// ── 11. connection_reset is transient for a verified proxy ──────────────────
{
  const o = classifyProxyOutcome({ status: 'ok', softFails: 0 }, fail('connection_reset'));
  check('ok + connection_reset -> ok + flaky', o.status === 'ok' && o.flaky === true, JSON.stringify(o));
}

// ── 12. unknown proxy that never answered is dead ───────────────────────────
{
  const o = classifyProxyOutcome({ status: 'unknown' }, fail('no_response'));
  check('unknown + no_response -> dead', o.status === 'dead', JSON.stringify(o));
}

// ── helpers used by the API/UI ──────────────────────────────────────────────
check('isTargetBlockReason(site_blocked)', isTargetBlockReason('site_blocked') === true);
check('isTargetBlockReason(http_403)', isTargetBlockReason('http_403') === true);
check('isTargetBlockReason(timeout) is false', isTargetBlockReason('timeout') === false);
check('isSoftFailReason(timeout)', isSoftFailReason('timeout') === true);
check('isSoftFailReason(http_502)', isSoftFailReason('http_502') === true);
check('isSoftFailReason(auth) is false', isSoftFailReason('auth') === false);

console.log('');
console.log(`Proxy validation policy: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
