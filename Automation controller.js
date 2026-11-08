// Automation controller.js — RPA recording/replay + Schedule automation
// controllers for the TrafficDrive dashboard.
//
// Provides:
//   RPA:  rpaStart, rpaStopAndSave, rpaLoadFile, rpaRefreshSavedList,
//         rpaClearConsole, rpaPlay, rpaDelete
//   Schedule: scheduleTypeChanged, saveSchedule, toggleSchedule
//
// RPA recording opens a Playwright browser via the backend API and records
// user actions. Replay sends the recorded action list back to the backend
// which re-executes them. Saved recordings are stored in localStorage.

(function () {
  'use strict';

  // --- RPA state -----------------------------------------------------------
  let rpaActive = false;
  let rpaSessionName = '';
  let rpaStartTime = 0;
  let rpaDurationTimer = null;
  let rpaStats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0, tabs: 0 };
  let rpaReplayActive = false;
  let rpaStatusTimer = null;
  let rpaRecTimer = null;
  let rpaRecordingProxy = null; // proxy used by the open recording browser
  const scheduleState = { timer: null };

  // --- RPA: proxy dropdown helpers ----------------------------------------
  let rpaProxyCache = [];

  // Returns { mode: 'none'|'fixed'|'random', proxy } for the top selector.
  function rpaProxyModeFromSelect() {
    const sel = document.getElementById('rpaProxySelect');
    const value = sel ? sel.value : '';
    if (!value) return { mode: 'none', proxy: null };
    if (value === '__random__') return { mode: 'random', proxy: null };
    try {
      const p = JSON.parse(value);
      return (p && p.host && p.port) ? { mode: 'fixed', proxy: p } : { mode: 'none', proxy: null };
    } catch (_) {
      return { mode: 'none', proxy: null };
    }
  }

  function rpaSelectedProxy() {
    return rpaProxyModeFromSelect().proxy;
  }

  // Recording opens one browser, so a random selection is resolved to one
  // concrete working proxy here and saved with the recording.
  function rpaPickRecordingProxy() {
    const selected = rpaProxyModeFromSelect();
    if (selected.mode === 'fixed') return selected.proxy;
    if (selected.mode === 'random') {
      const pool = (rpaProxyCache || []).filter(p => p && p.host && p.port && p.status === 'ok');
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    return null;
  }

  function rpaProxyCore(p) {
    if (!p || !p.host || !p.port) return null;
    return {
      type: p.type || 'http',
      host: p.host,
      port: p.port,
      username: p.username || '',
      password: p.password || '',
      sessionSuffix: !!p.sessionSuffix,
      rotating: !!p.rotating,
    };
  }

  function rpaRefreshProxySelect() {
    const sel = document.getElementById('rpaProxySelect');
    if (!sel) return;
    fetch('http://localhost:3000/api/proxies')
      .then(r => r.json())
      .then(data => {
        const list = (data && data.success && Array.isArray(data.proxies)) ? data.proxies : [];
        rpaProxyCache = list.filter(p => p && p.host && p.port);
        const current = sel.value;
        // Target-verified proxies first, then working, then unknown, then dead.
        const rank = p => {
          if (p && p.targetOk === true) return 0;
          if (p && p.status === 'ok') return 1;
          if (p && p.status === 'dead') return 3;
          return 2;
        };
        const sorted = rpaProxyCache.slice().sort((a, b) => rank(a) - rank(b));
        const shown = sorted.slice(0, 300);
        const okCount = sorted.filter(p => p && p.status === 'ok').length;
        const targetCount = sorted.filter(p => p && p.targetOk === true).length;
        let html = '<option value="">No proxy (direct IP)</option>' +
          (okCount ? '<option value="__random__">🎲 Random working proxy (' + okCount + ')' + (targetCount ? ' · ' + targetCount + ' target-verified' : '') + '</option>' : '');
        let group = '';
        shown.forEach((p) => {
          const isTarget = p && p.targetOk === true;
          const isOk = p && p.status === 'ok';
          const nextGroup = isTarget ? 'Target-verified' : (isOk ? 'Working' : (p && p.status === 'dead' ? 'Dead (not used)' : 'Not validated'));
          if (nextGroup !== group) {
            if (group) html += '</optgroup>';
            html += '<optgroup label="' + nextGroup + '">';
            group = nextGroup;
          }
          const type = p.type || 'http';
          const mark = isTarget ? '✔ ' : (isOk ? 'OK ' : (p.status === 'dead' ? 'DEAD ' : ''));
          const exit = p.egressIp ? ' → ' + p.egressIp + (p.countryCode ? ' (' + p.countryCode + ')' : '') : '';
          const label = mark + type + '://' + p.host + ':' + p.port + (p.username ? ' (' + p.username + ')' : '') + exit;
          const value = JSON.stringify(rpaProxyCore(p)).replace(/'/g, '&#39;');
          html += '<option value="' + value + '">' + label + '</option>';
        });
        if (group) html += '</optgroup>';
        if (sorted.length > shown.length) html += '<option value="" disabled>... ' + (sorted.length - shown.length) + ' more (validate on Proxies page)</option>';
        sel.innerHTML = html;
        if (current) {
          sel.value = current;
          if (!sel.value) sel.selectedIndex = 0;
        }
      })
      .catch(() => {});
  }

  function rpaLog(msg, type) {
    const consoleEl = document.getElementById('rpaConsole');
    if (!consoleEl) return;
    const tagMap = { info: 'INFO', success: 'SUCCESS', error: 'ERROR', warn: 'WARNING' };
    const tag = tagMap[type] || 'INFO';
    const cls = type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info';
    const now = new Date();
    const ts = '[' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0') + ']';
    const row = '<div class="lr"><span class="lts">' + ts + '</span><span class="ltag ' + cls + '">' + tag + '</span><span class="lmsg">' + msg + '</span></div>';
    consoleEl.insertAdjacentHTML('beforeend', row);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function rpaUpdateStatus(status) {
    const badge = document.getElementById('rpa-status-badge');
    const icon = document.getElementById('rpa-status-icon');
    const label = document.getElementById('rpa-status-label');
    const startBtn = document.getElementById('rpaStartBtn');
    const stopBtn = document.getElementById('rpaStopBtn');
    const map = {
      idle: { text: 'Idle', icon: '⏹', color: 'var(--t3)' },
      recording: { text: 'Recording', icon: '🔴', color: 'var(--red)' },
      replaying: { text: 'Replaying', icon: '▶', color: 'var(--grn)' },
    };
    const s = map[status] || map.idle;
    if (badge) { badge.textContent = s.text; badge.style.background = s.color; }
    if (icon) icon.textContent = s.icon;
    if (label) label.textContent = s.text;
    if (startBtn) startBtn.disabled = (status === 'recording' || status === 'replaying');
    if (stopBtn) stopBtn.disabled = (status !== 'recording' && status !== 'replaying');
  }

  function rpaUpdateStats() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('rpa-stat-clicks', rpaStats.clicks);
    set('rpa-stat-inputs', rpaStats.inputs);
    set('rpa-stat-scrolls', rpaStats.scrolls);
    set('rpa-stat-keys', rpaStats.keys);
    set('rpa-stat-nav', rpaStats.nav);
    set('rpa-stat-other', rpaStats.other);
    set('rpa-stat-tabs', rpaStats.tabs || 0);
    const total = rpaStats.clicks + rpaStats.inputs + rpaStats.scrolls + rpaStats.keys + rpaStats.nav + rpaStats.other + (rpaStats.tabs || 0);
    set('rpa-action-count', total);
  }

  function rpaResetStats() {
    rpaStats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0, tabs: 0 };
    rpaUpdateStats();
  }

  function rpaCountActions(actions) {
    const s = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, nav: 0, other: 0, tabs: 0 };
    (actions || []).forEach(a => {
      if (!a) return;
      if (a.type === 'click') s.clicks++;
      else if (a.type === 'input' || a.type === 'select') s.inputs++;
      else if (a.type === 'scroll') s.scrolls++;
      else if (a.type === 'key') s.keys++;
      else if (a.type === 'navigate' || a.type === 'reload') s.nav++;
      else if (a.type === 'switch') s.tabs++;
      else s.other++;
    });
    return s;
  }

  // Live "Actions" + per-type counters while a recording is open.
  function rpaStopRecordingPolling() {
    if (rpaRecTimer) {
      clearInterval(rpaRecTimer);
      rpaRecTimer = null;
    }
  }

  function rpaStartRecordingPolling() {
    rpaStopRecordingPolling();
    const tick = () => {
      fetch('http://localhost:3000/api/rpa/status')
        .then(r => r.json())
        .then(data => {
          const rec = data && data.recording;
          if (!rec) return;
          if (rec.stats) {
            rpaStats = {
              clicks: rec.stats.clicks || 0,
              inputs: rec.stats.inputs || 0,
              scrolls: rec.stats.scrolls || 0,
              keys: rec.stats.keys || 0,
              nav: rec.stats.navs || 0,
              other: rec.stats.other || 0,
              tabs: rec.stats.tabs || 0,
            };
            rpaUpdateStats();
          }
          if (!rec.active) rpaStopRecordingPolling();
        })
        .catch(() => {});
    };
    tick();
    rpaRecTimer = setInterval(tick, 1000);
  }

  // --- RPA: Start recording ------------------------------------------------
  function rpaStart() {
    if (rpaActive) return;
    const url = (document.getElementById('rpaUrl') || {}).value || '';
    const speed = (document.getElementById('rpaReplaySpeed') || {}).value || '1';
    const selected = rpaProxyModeFromSelect();
    const recordingProxy = rpaPickRecordingProxy();
    const proxyMode = selected.mode;
    rpaRecordingProxy = recordingProxy;
    rpaActive = true;
    rpaSessionName = 'session_' + Date.now();
    rpaStartTime = Date.now();
    rpaResetStats();
    rpaUpdateStatus('recording');
    rpaLog('Starting RPA recording' + (url ? ' → ' + url : ' (blank page)') +
      (recordingProxy ? ' via ' + recordingProxy.host + ':' + recordingProxy.port : ' (no proxy — direct IP)'), 'info');
    if (!recordingProxy) {
      rpaLog('WARNING: koi proxy select nahi hai. Recording browser PC ke direct IP par khulega. Chahiye to Stop karein, proxy select karein phir Start karein.', 'warn');
    }
    const sessionEl = document.getElementById('rpa-session-name');
    if (sessionEl) sessionEl.textContent = rpaSessionName;
    // Duration timer
    if (rpaDurationTimer) clearInterval(rpaDurationTimer);
    rpaDurationTimer = setInterval(() => {
      const dur = ((Date.now() - rpaStartTime) / 1000).toFixed(1);
      const el = document.getElementById('rpa-duration');
      if (el) el.textContent = dur + 's';
    }, 100);
    // Tell backend to open a recording browser
    fetch('http://localhost:3000/api/rpa/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, speed, proxy: recordingProxy, proxyMode }),
    }).then(r => r.json()).then(data => {
      if (data && data.success) {
        // Keep the exact verified identity returned by the backend.
        if (data.proxy && data.proxy !== 'direct IP' && recordingProxy) {
          rpaRecordingProxy = Object.assign({}, recordingProxy, {
            label: data.proxy,
            egressIp: data.proxyEgress || '',
            verified: !!data.proxyVerified,
          });
        }
        rpaLog('Recording browser opened' + (data.proxy ? ' — network: ' + data.proxy + (data.proxyEgress ? ' (exit ' + data.proxyEgress + ')' : '') : ' — network: direct IP'), data.proxy ? 'success' : 'warn');
        rpaStartRecordingPolling();
      } else {
        rpaActive = false;
        rpaUpdateStatus('idle');
        rpaLog('Recording browser failed to open: ' + ((data && data.error) || 'no response'), 'error');
        rpaStopRecordingPolling();
      }
    }).catch(err => {
      rpaActive = false;
      rpaUpdateStatus('idle');
      rpaLog('Backend RPA start failed: ' + err.message, 'error');
      rpaStopRecordingPolling();
    });
  }

  // --- RPA: Stop a replay --------------------------------------------------
  function rpaStopPlay() {
    rpaReplayActive = false;
    rpaStopStatusPolling();
    rpaUpdateStatus('idle');
    rpaLog('Stopping replay…', 'warn');
    fetch('http://localhost:3000/api/rpa/stop-play', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        rpaLog(data && data.stopped ? 'Replay stopped.' : 'Replay was not running.', 'warn');
      })
      .catch(err => rpaLog('Stop replay failed: ' + err.message, 'error'));
  }

  // Poll the backend replay status (loop progress + random click totals).
  function rpaStopStatusPolling() {
    if (rpaStatusTimer) {
      clearInterval(rpaStatusTimer);
      rpaStatusTimer = null;
    }
  }

  function rpaSetText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // Live replay monitor: rounds, elapsed, actions done/total, active sessions,
  // clicks and the real proxy / egress identity of every running session.
  function rpaUpdateMonitor(p) {
    if (!p) return;
    const mode = p.proxyMode || 'none';
    const totalRounds = p.totalRounds || ((p.sessions || 1) * (p.loop || 1));
    const badge = document.getElementById('rpa-mon-badge');
    if (badge) {
      badge.textContent = p.running ? 'Live' : (p.startedAt ? 'Finished' : 'Idle');
      badge.style.background = p.running ? 'var(--grn)' : 'var(--t3)';
    }
    rpaSetText('rpa-mon-round', String(p.round || 0) + ' / ' + String(p.loop || 1));
    rpaSetText('rpa-mon-total', String(totalRounds));
    rpaSetText('rpa-mon-elapsed', String(p.elapsedSec || 0) + 's');
    rpaSetText('rpa-mon-actions', String(p.actionsCompleted || 0) + ' / ' + String(p.totalExpectedActions || ((totalRounds) * (p.totalActions || 0))));
    rpaSetText('rpa-mon-clicks', String(p.randomClicks || 0));
    rpaSetText('rpa-mon-active', String(p.activeSessions || 0) + ' / ' + String(p.sessions || 1));
    rpaSetText('rpa-mon-proxy', mode === 'none' ? 'DIRECT IP' : (p.proxyLabel || mode));
    const verified = mode === 'none'
      ? 'no proxy'
      : (p.proxyVerified ? 'verified ✓' : (p.proxyVerifiedPoolSize ? (p.proxyVerifiedPoolSize + ' verified') : 'pending'));
    rpaSetText('rpa-mon-verified', verified);
    rpaSetText('rpa-mon-egress', p.proxyEgress ? ('exit ' + p.proxyEgress) : (mode === 'none' ? 'PC IP' : '—'));
    rpaSetText('rpa-mon-switches', String(p.proxySwitches || 0));
    rpaSetText('rpa-mon-current', p.running
      ? ((p.currentAction ? p.currentAction : 'starting') + (p.currentTab ? ' · tab ' + p.currentTab : ''))
      : (p.running === false && p.startedAt ? 'finished' : 'idle'));
    const rowsEl = document.getElementById('rpa-session-rows');
    if (rowsEl) {
      const rows = (p.sessionStats || []);
      if (!rows.length) {
        rowsEl.innerHTML = '<div style="color:var(--t3);font-size:11px">No active sessions yet.</div>';
      } else {
        rowsEl.innerHTML = rows.map(r => {
          const proxy = r.proxyLabel ? rpaEscapeHtml(r.proxyLabel) : (mode === 'none' ? 'direct IP' : '—');
          const egress = r.proxyEgress ? ' → ' + rpaEscapeHtml(r.proxyEgress) : '';
          const verified = r.proxyVerified ? ' ✓' : '';
          return '<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 0;border-bottom:1px solid var(--bdr)">' +
            '<span style="color:var(--t2)">S' + r.id + ' · ' + (r.iteration || 0) + '/' + (p.loop || 1) + ' · ' + (r.actionsDone || 0) + '/' + (r.actionsTotal || p.totalActions || 0) + ' actions</span>' +
            '<span style="color:' + (r.proxyVerified ? 'var(--grn)' : 'var(--ylw)') + ';text-align:right">' + proxy + egress + verified +
            (r.failed ? ' · <span style="color:var(--red)">' + r.failed + '✕</span>' : '') +
            (r.lastError ? ' · ' + rpaEscapeHtml(r.lastError).slice(0, 90) : '') + '</span></div>';
        }).join('');
      }
    }
  }

  function rpaStartStatusPolling() {
    rpaStopStatusPolling();
    let lastLogged = 0;
    const tick = () => {
      fetch('http://localhost:3000/api/rpa/status')
        .then(r => r.json())
        .then(data => {
          const p = data && data.play;
          if (!p) return;
          rpaUpdateMonitor(p);
          const prog = document.getElementById('rpaReplayProgress');
          if (prog) {
            const rows = (p.sessionStats || []).slice(0, 12).map(r =>
              'S' + r.id + ' ' + (r.iteration || 0) + '/' + (p.loop || 1) + (r.failed ? ' (' + r.failed + '✕)' : '')
            ).join(' · ');
            prog.textContent = p.running
              ? ((p.sessions || 1) + ' session' + ((p.sessions || 1) > 1 ? 's' : '') + ' · ' + p.iteration + '/' + p.loop + ' · ' + p.elapsedSec + 's' + (rows ? ' — ' + rows : ''))
              : '';
          }
          const rc = document.getElementById('rpa-random-clicks');
          if (rc) rc.textContent = String(p.randomClicks || 0);
          const rs = document.getElementById('rpa-random-scrolls');
          if (rs) rs.textContent = String(p.randomScrolls || 0);
          const dur = document.getElementById('rpa-duration');
          if (dur && p.running) dur.textContent = p.elapsedSec + 's';
          (p.logs || []).forEach(entry => {
            if (!entry || !entry.t || entry.t <= lastLogged) return;
            lastLogged = entry.t;
            rpaLog(entry.message, entry.type || 'info');
          });
          if (!p.running && rpaReplayActive) {
            rpaReplayActive = false;
            rpaUpdateStatus('idle');
            if (prog) prog.textContent = '';
            rpaLog(
              p.lastError ? ('Replay finished with errors: ' + p.lastError)
                          : ('Replay complete. Random clicks: ' + (p.randomClicks || 0) + ', random scrolls: ' + (p.randomScrolls || 0)),
              p.lastError ? 'error' : 'success'
            );
            rpaStopStatusPolling();
          }
        })
        .catch(() => {});
    };
    tick();
    rpaStatusTimer = setInterval(tick, 1500);
  }

  // --- RPA: Stop & Save ----------------------------------------------------
  function rpaStopAndSave() {
    // The same button stops a running replay.
    if (rpaReplayActive) {
      rpaStopPlay();
      return;
    }
    if (!rpaActive) return;
    rpaActive = false;
    rpaStopRecordingPolling();
    if (rpaDurationTimer) { clearInterval(rpaDurationTimer); rpaDurationTimer = null; }
    const duration = ((Date.now() - rpaStartTime) / 1000).toFixed(1);
    rpaUpdateStatus('idle');
    rpaLog('Stopping recording. Duration: ' + duration + 's', 'info');
    fetch('http://localhost:3000/api/rpa/stop', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        const actions = (data && data.actions) || [];
        const stats = rpaCountActions(actions);
        // One more poll-free refresh so the saved card shows the real totals.
        rpaStats = stats;
        rpaUpdateStats();
        const recording = {
          name: rpaSessionName,
          date: new Date().toISOString(),
          duration: parseFloat(duration),
          actions,
          stats,
          // Per-recording replay defaults (editable on the saved card).
          loop: 1,
          sessions: 1,
          headless: false,
          // Remember the network identity so Play cannot silently lose it.
          proxyMode: (data && data.recordingProxy && data.recordingProxy.proxy) ? 'fixed' : 'none',
          proxy: (data && data.recordingProxy && data.recordingProxy.proxy) || rpaRecordingProxy || null,
          proxyLabel: (data && data.recordingProxy && data.recordingProxy.label) || (rpaRecordingProxy ? (rpaRecordingProxy.host + ':' + rpaRecordingProxy.port) : 'direct IP'),
          proxyEgress: (data && data.recordingProxy && data.recordingProxy.egressIp) || '',
          proxyVerified: !!(data && data.recordingProxy && data.recordingProxy.verified),
        };
        // Save to localStorage
        try {
          const list = JSON.parse(localStorage.getItem('rpa_recordings') || '[]');
          list.unshift(recording);
          localStorage.setItem('rpa_recordings', JSON.stringify(list));
        } catch (e) {}
        if (actions.length) {
          rpaLog('Recording saved: ' + actions.length + ' actions, ' + duration + 's', 'success');
        } else {
          rpaLog('Recording saved with 0 actions. Make sure you clicked/scrolled inside the opened browser window before stopping.', 'warn');
        }
        rpaRefreshSavedList();
      })
      .catch(err => {
        rpaLog('Backend stop failed: ' + err.message + ' (saved locally without actions)', 'warn');
        rpaRefreshSavedList();
      });
  }

  // --- RPA: per-recording replay settings ---------------------------------
  function rpaEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function rpaRecordings() {
    try { return JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (_) { return []; }
  }

  function rpaSaveRecordings(list) {
    try { localStorage.setItem('rpa_recordings', JSON.stringify(list)); } catch (_) {}
  }

  function rpaReadRecordingSettings(idx) {
    const rec = rpaRecordings()[idx] || {};
    const num = (id, fallback, min, max) => {
      const el = document.getElementById(id);
      const n = el ? parseInt(el.value, 10) : NaN;
      return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
    };
    const loop = num('rpa-rec-loop-' + idx, parseInt(rec.loop, 10) || 1, 1, 100000);
    const sessions = num('rpa-rec-sessions-' + idx, parseInt(rec.sessions, 10) || 1, 1, 10);
    const headlessEl = document.getElementById('rpa-rec-headless-' + idx);
    const headless = headlessEl ? headlessEl.value === '1' : !!rec.headless;
    const proxyModeEl = document.getElementById('rpa-rec-proxy-mode-' + idx);
    let proxyMode = proxyModeEl
      ? proxyModeEl.value
      : (rec.proxyMode || (rec.proxy ? 'saved' : 'global'));
    if (proxyMode !== 'saved' && proxyMode !== 'global' && proxyMode !== 'random' && proxyMode !== 'none') {
      proxyMode = rec.proxy ? 'saved' : 'global';
    }
    return { loop, sessions, headless, proxyMode };
  }

  function rpaUpdateRecordingTotal(idx) {
    const el = document.getElementById('rpa-rec-total-' + idx);
    if (!el) return;
    const s = rpaReadRecordingSettings(idx);
    el.textContent = (s.loop * s.sessions).toLocaleString() + ' replays (' + s.loop + ' × ' + s.sessions + ')';
  }

  // Apply only saves the settings on the recording card; it does not start.
  function rpaApplyRecordingSettings(idx) {
    const list = rpaRecordings();
    if (!list[idx]) return;
    const s = rpaReadRecordingSettings(idx);
    list[idx].loop = s.loop;
    list[idx].sessions = s.sessions;
    list[idx].headless = s.headless;
    list[idx].proxyMode = s.proxyMode;
    rpaSaveRecordings(list);
    rpaUpdateRecordingTotal(idx);
    rpaLog('Saved replay settings: loop ' + s.loop + ' × ' + s.sessions + ' session(s), ' + (s.headless ? 'headless' : 'visible') + ', proxy: ' + s.proxyMode + '.', 'success');
  }

  // --- RPA: Refresh saved recordings list ----------------------------------
  function rpaRefreshSavedList() {
    const listEl = document.getElementById('rpaSavedList');
    if (!listEl) return;
    const recordings = rpaRecordings();
    if (!recordings.length) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:20px">No recordings yet. Click Start RPA to begin.</div>';
      return;
    }
    let html = '';
    recordings.forEach((rec, idx) => {
      const actionCount = rec.actions ? rec.actions.length : 0;
      const stats = rec.stats || {};
      const loop = Math.max(1, parseInt(rec.loop, 10) || 1);
      const sessions = Math.min(10, Math.max(1, parseInt(rec.sessions, 10) || 1));
      const headless = rec.headless === true;
      const recProxyModeRaw = rec.proxyMode || (rec.proxy ? 'saved' : 'global');
      const recProxyMode = (recProxyModeRaw === 'none' || recProxyModeRaw === 'random' || recProxyModeRaw === 'global' || recProxyModeRaw === 'saved')
        ? recProxyModeRaw
        : (rec.proxy ? 'saved' : 'global');
      const proxyLabel = rec.proxyLabel || (rec.proxy && rec.proxy.host ? (rec.proxy.host + ':' + rec.proxy.port) : 'direct IP');
      const statLine = [
        actionCount + ' actions',
        (rec.duration || 0) + 's',
        (stats.clicks || 0) + ' clicks',
        (stats.scrolls || 0) + ' scrolls',
        (stats.nav || 0) + ' navs',
        (stats.tabs || 0) + ' tab switches',
        'proxy: ' + proxyLabel,
      ].join(' · ');
      html += '<div class="rpa-rec-item" style="padding:10px;background:var(--card2);border-radius:var(--r);margin-bottom:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:180px"><div style="font-weight:600;color:var(--t1)">' + rpaEscapeHtml(rec.name) + '</div>' +
          '<div style="font-size:11px;color:var(--t3)">' + rpaEscapeHtml(rec.date || '') + ' · ' + statLine + '</div></div>' +
          '<button class="btn btn-o" onclick="rpaApplyRecordingSettings(' + idx + ')" style="padding:5px 10px;font-size:11px" title="Save Loop / Sessions / Headless for this recording">Apply</button>' +
          '<button class="btn btn-g" onclick="rpaPlay(' + idx + ')" style="padding:5px 10px;font-size:11px" title="Start replay with these settings">▶ Play</button>' +
          '<button class="btn btn-danger" onclick="rpaDelete(' + idx + ')" style="padding:5px 10px;font-size:11px">Delete</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">' +
          '<div class="f" style="flex:0 0 120px"><label class="fl">Loop count</label>' +
            '<input type="number" id="rpa-rec-loop-' + idx + '" min="1" max="100000" value="' + loop + '" oninput="rpaUpdateRecordingTotal(' + idx + ')"></div>' +
          '<div class="f" style="flex:0 0 130px"><label class="fl">Parallel sessions</label>' +
            '<input type="number" id="rpa-rec-sessions-' + idx + '" min="1" max="10" value="' + sessions + '" oninput="rpaUpdateRecordingTotal(' + idx + ')"></div>' +
          '<div class="f" style="flex:0 0 140px"><label class="fl">Browser mode</label>' +
            '<select id="rpa-rec-headless-' + idx + '">' +
              '<option value="0"' + (headless ? '' : ' selected') + '>Visible (normal)</option>' +
              '<option value="1"' + (headless ? ' selected' : '') + '>Headless (hidden)</option>' +
            '</select></div>' +
          '<div class="f" style="flex:0 0 190px"><label class="fl">Proxy mode</label>' +
            '<select id="rpa-rec-proxy-mode-' + idx + '">' +
              '<option value="saved"' + (recProxyMode === 'saved' ? ' selected' : '') + '>Saved proxy (' + rpaEscapeHtml(proxyLabel) + ')</option>' +
              '<option value="global"' + (recProxyMode === 'global' ? ' selected' : '') + '>Use top selection</option>' +
              '<option value="random"' + (recProxyMode === 'random' ? ' selected' : '') + '>Random working (rotate)</option>' +
              '<option value="none"' + (recProxyMode === 'none' ? ' selected' : '') + '>No proxy (direct IP)</option>' +
            '</select></div>' +
          '<div id="rpa-rec-total-' + idx + '" style="font-size:11px;color:var(--t3);padding-bottom:8px">' + (loop * sessions).toLocaleString() + ' replays (' + loop + ' × ' + sessions + ')</div>' +
        '</div>' +
        '</div>';
    });
    listEl.innerHTML = html;
  }

  // --- RPA: Play a recording -----------------------------------------------
  function rpaPlay(idx) {
    let recordings = [];
    try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
    const rec = recordings[idx];
    if (!rec) return;
    if (!rec.actions || !rec.actions.length) {
      rpaLog('This recording has 0 actions — nothing to replay. Record again and interact with the opened browser before Stop & Save.', 'warn');
      return;
    }
    if (rpaReplayActive) {
      rpaLog('A replay is already running. Stop it first.', 'warn');
      return;
    }
    // Loop / sessions / headless are stored per recording (each card has its
    // own inputs) instead of one global loop value.
    const settings = rpaReadRecordingSettings(idx);
    const loop = settings.loop;
    const sessions = settings.sessions;
    const headless = settings.headless;
    const dwellEl = document.getElementById('rpaDwellSec');
    const dwellSec = Math.max(0, parseInt(dwellEl && dwellEl.value, 10) || 0);
    const speedEl = document.getElementById('rpaReplaySpeed');
    const speed = parseFloat(speedEl && speedEl.value) || 1;
    const verifyProxy = ((document.getElementById('rpaVerifyProxy') || {}).value || '1') !== '0';
    const cardProxyMode = settings.proxyMode || (rec.proxy ? 'saved' : 'global');
    const globalProxy = rpaProxyModeFromSelect();
    let proxyMode = 'none';
    let proxy = null;
    if (cardProxyMode === 'saved') {
      if (rec.proxy && rec.proxy.host && rec.proxy.port) {
        proxyMode = 'fixed';
        proxy = rec.proxy;
      } else {
        // Old recordings have no saved proxy. Fall back to the explicit top
        // selector instead of silently using the PC IP.
        proxyMode = globalProxy.mode;
        proxy = globalProxy.proxy;
        rpaLog('This recording has no saved proxy — using the top proxy selection (' + proxyMode + ').', 'warn');
      }
    } else if (cardProxyMode === 'random') {
      proxyMode = 'random';
    } else if (cardProxyMode === 'none') {
      proxyMode = 'none';
    } else {
      proxyMode = globalProxy.mode;
      proxy = globalProxy.proxy;
    }

    if (proxyMode === 'none') {
      rpaLog('WARNING: no proxy for this replay. The browser will use the PC direct IP and ad networks can see it. Select a proxy or Random working proxy.', 'warn');
    }

    // Persist the card's values so a reload keeps the same configuration.
    try {
      const list = rpaRecordings();
      if (list[idx]) {
        list[idx].loop = loop;
        list[idx].sessions = sessions;
        list[idx].headless = headless;
        list[idx].proxyMode = cardProxyMode;
        if (proxyMode === 'fixed' && proxy) {
          list[idx].proxy = proxy;
          list[idx].proxyLabel = proxy.host + ':' + proxy.port;
        }
        rpaSaveRecordings(list);
      }
    } catch (_) {}
    // Reuse the global Random Clicks configuration (sidebar → Random Clicks).
    let randomClicks = { enabled: false };
    try {
      if (typeof getRandomClickData === 'function') {
        const rc = getRandomClickData();
        if (rc && rc.randomClicks) randomClicks = rc.randomClicks;
      }
    } catch (_) {}
    // Reuse the global Traffic Source configuration as well.
    let trafficSource = { enabled: false };
    try {
      if (typeof getTrafficSourceData === 'function') {
        const td = getTrafficSourceData();
        if (td && td.trafficSource) trafficSource = td.trafficSource;
      }
    } catch (_) {}
    // RPA replay uses the same UA / resolution settings as campaigns.
    let uaData = {};
    let resData = {};
    try { if (typeof getUaCampaignData === 'function') uaData = getUaCampaignData() || {}; } catch (_) {}
    try { if (typeof getResolutionData === 'function') resData = getResolutionData() || {}; } catch (_) {}

    rpaReplayActive = true;
    rpaUpdateStatus('replaying');
    rpaLog('Replaying: ' + rec.name + ' (' + (rec.actions ? rec.actions.length : 0) + ' actions)' +
      ' × ' + loop + ' loop × ' + sessions + ' session(s)' +
      (headless ? ' [headless]' : ' [visible]') +
      ' · proxy mode: ' + proxyMode +
      (proxy ? ' · ' + proxy.host + ':' + proxy.port : '') +
      (randomClicks.enabled ? ' + random clicks' : '') +
      (trafficSource.enabled ? ' + traffic source' : ''), 'info');
    const rcEl = document.getElementById('rpa-random-clicks');
    if (rcEl) rcEl.textContent = '0';

    fetch('http://localhost:3000/api/rpa/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: rec.actions || [],
        speed,
        loop,
        sessions,
        headless,
        verifyProxy,
        dwellMs: dwellSec * 1000,
        proxy,
        proxyMode,
        proxyRotation: 'round',
        randomClicks,
        trafficSource,
        ...uaData,
        ...resData,
      }),
    }).then(r => r.json()).then(data => {
      if (!data || !data.success) {
        rpaReplayActive = false;
        rpaUpdateStatus('idle');
        rpaLog('Replay failed: ' + ((data && data.error) || 'unknown error'), 'error');
        return;
      }
      rpaLog('Replay started in background.', 'success');
      rpaStartStatusPolling();
    }).catch(err => {
      rpaReplayActive = false;
      rpaUpdateStatus('idle');
      rpaLog('Replay failed: ' + err.message, 'error');
    });
  }

  // --- RPA: Delete a recording ---------------------------------------------
  function rpaDelete(idx) {
    let recordings = [];
    try { recordings = JSON.parse(localStorage.getItem('rpa_recordings') || '[]'); } catch (e) {}
    if (idx < 0 || idx >= recordings.length) return;
    recordings.splice(idx, 1);
    try { localStorage.setItem('rpa_recordings', JSON.stringify(recordings)); } catch (e) {}
    rpaRefreshSavedList();
    rpaLog('Recording deleted.', 'warn');
  }

  // --- RPA: Import file ----------------------------------------------------
  function rpaLoadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const rec = JSON.parse(ev.target.result);
          rec.name = rec.name || 'imported_' + Date.now();
          rec.date = rec.date || new Date().toISOString();
          rec.loop = Math.max(1, parseInt(rec.loop, 10) || 1);
          rec.sessions = Math.min(10, Math.max(1, parseInt(rec.sessions, 10) || 1));
          rec.headless = rec.headless === true;
          const list = JSON.parse(localStorage.getItem('rpa_recordings') || '[]');
          list.unshift(rec);
          localStorage.setItem('rpa_recordings', JSON.stringify(list));
          rpaLog('Imported recording: ' + rec.name, 'success');
          rpaRefreshSavedList();
        } catch (err) {
          rpaLog('Import failed: invalid JSON file', 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // --- RPA: Clear console --------------------------------------------------
  function rpaClearConsole() {
    const el = document.getElementById('rpaConsole');
    if (el) el.innerHTML = '';
  }

  // Remove only app-owned Playwright / ngf-nomi temp folders. The user's
  // personal Chrome/Edge profile is never touched (the backend also refuses
  // any path outside the OS temp directory).
  function cleanRpaTempData() {
    if (!window.confirm('Clear app-owned temporary browser data?\n\nOnly Playwright/ngf-nomi temp folders are removed. Your personal Chrome/Edge profile and cookies are NOT touched.')) return;
    rpaLog('Cleaning app-owned temporary browser data…', 'info');
    fetch('http://localhost:3000/api/temp/clean', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (!data || !data.success) {
          rpaLog('Temp cleanup failed: ' + ((data && data.error) || 'unknown error'), 'error');
          return;
        }
        const mb = ((data.freedBytes || 0) / (1024 * 1024)).toFixed(1);
        rpaLog('Temp cleanup: removed ' + (data.removedCount || 0) + ' folder(s), freed ' + mb + ' MB' +
          (data.skippedCount ? ', skipped ' + data.skippedCount + ' in-use/recent folder(s)' : '') + '. Personal browser untouched.', 'success');
      })
      .catch(err => rpaLog('Temp cleanup failed: ' + err.message, 'error'));
  }

  // --- Schedule automation -------------------------------------------------
  function scheduleTypeChanged() {
    const sel = document.getElementById('scheduleType');
    if (!sel) return;
    const type = sel.value;
    const delayFields = document.getElementById('scheduleDelayFields');
    const dtFields = document.getElementById('scheduleDatetimeFields');
    const recurFields = document.getElementById('scheduleRecurringFields');
    if (delayFields) delayFields.style.display = (type === 'delay') ? 'block' : 'none';
    if (dtFields) dtFields.style.display = (type === 'datetime') ? 'block' : 'none';
    if (recurFields) recurFields.style.display = (type === 'recurring') ? 'block' : 'none';
  }

  function saveSchedule() {
    const type = (document.getElementById('scheduleType') || {}).value || 'delay';
    const sched = { type, enabled: true, createdAt: Date.now() };
    if (type === 'delay') {
      sched.delayHours = parseInt((document.getElementById('schedDelayHours') || {}).value, 10) || 0;
      sched.delayMinutes = parseInt((document.getElementById('schedDelayMinutes') || {}).value, 10) || 0;
      sched.delaySeconds = parseInt((document.getElementById('schedDelaySeconds') || {}).value, 10) || 0;
      sched.delayMinutes = sched.delayMinutes + (sched.delayHours * 60);
    } else if (type === 'datetime') {
      const date = (document.getElementById('schedDate') || {}).value || '';
      const time = (document.getElementById('schedTime') || {}).value || '09:00';
      sched.datetime = date ? (date + 'T' + time) : '';
    } else if (type === 'recurring') {
      sched.days = Array.from(document.querySelectorAll('input[name="schedDay"]:checked')).map(cb => parseInt(cb.value, 10));
      sched.recurTime = (document.getElementById('schedRecurTime') || {}).value || '09:00';
    }
    // Campaign settings
    sched.trafficMode = (document.getElementById('schedTrafficMode') || {}).value || 'direct';
    sched.url = (document.getElementById('schedUrl') || {}).value || '';
    sched.sessions = parseInt((document.getElementById('schedSessions') || {}).value, 10) || 1;
    sched.threads = parseInt((document.getElementById('schedThreads') || {}).value, 10) || 1;
    sched.keyword = (document.getElementById('schedKeyword') || {}).value || '';
    sched.refPlatform = (document.getElementById('schedRefPlatform') || {}).value || 'random';
    sched.headless = document.getElementById('schedHeadlessToggle') ? document.getElementById('schedHeadlessToggle').classList.contains('on') : false;
    try { localStorage.setItem('trafficdrive_schedule', JSON.stringify(sched)); } catch (e) {}
    // Save to server
    fetch('http://localhost:3000/api/schedule/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sched),
    }).then(r => r.json()).then(data => {
      if (data.success) {
        const badge = document.getElementById('schedule-status-badge');
        if (badge) { badge.textContent = 'Scheduled'; badge.style.background = 'var(--grn)'; }
        if (typeof addLog === 'function') addLog('success', 'Schedule saved to server.');
        refreshSavedSchedules();
      }
    }).catch(err => {
      if (typeof addLog === 'function') addLog('warn', 'Schedule saved locally (server unreachable).');
    });
    const badge = document.getElementById('schedule-status-badge');
    if (badge) { badge.textContent = 'Scheduled'; badge.style.background = 'var(--grn)'; }
    if (typeof addLog === 'function') addLog('success', 'Schedule saved.');
  }

  function toggleSchedule() {
    let sched = {};
    try { sched = JSON.parse(localStorage.getItem('trafficdrive_schedule') || '{}'); } catch (e) {}
    sched.enabled = !sched.enabled;
    try { localStorage.setItem('trafficdrive_schedule', JSON.stringify(sched)); } catch (e) {}
    fetch('http://localhost:3000/api/schedule/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: sched.enabled }),
    }).catch(() => {});
    const badge = document.getElementById('schedule-status-badge');
    if (badge) {
      badge.textContent = sched.enabled ? 'Scheduled' : 'No Schedule';
      badge.style.background = sched.enabled ? 'var(--grn)' : 'var(--t3)';
    }
  }

  // --- Schedule: Activate (save + enable + start timer) ---
  function scheduleActivate() {
    saveSchedule();
    const activateBtn = document.getElementById('schedActivateBtn');
    const cancelBtn = document.getElementById('schedCancelBtn');
    if (activateBtn) activateBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;
    // Show countdown
    const countdownEl = document.getElementById('schedCountdown');
    if (countdownEl) countdownEl.style.display = 'block';
    // Schedule the actual execution
    let sched = {};
    try { sched = JSON.parse(localStorage.getItem('trafficdrive_schedule') || '{}'); } catch (e) {}
    if (sched.enabled) {
      const delayMs = ((sched.delayHours || 0) * 3600 + (sched.delayMinutes || 0) * 60 + (sched.delaySeconds || 0)) * 1000;
      if (sched.type === 'delay' && delayMs > 0) {
        if (typeof addLog === 'function') addLog('info', 'Schedule will run in ' + (sched.delayHours || 0) + 'h ' + (sched.delayMinutes || 0) + 'm ' + (sched.delaySeconds || 0) + 's');
        startCountdown(delayMs);
        scheduleState.timer = setTimeout(() => {
          runScheduledCampaign(sched);
        }, delayMs);
      } else if (sched.type === 'datetime' && sched.datetime) {
        const targetTime = new Date(sched.datetime).getTime();
        const now = Date.now();
        const wait = targetTime - now;
        if (wait > 0) {
          if (typeof addLog === 'function') addLog('info', 'Schedule will run at ' + sched.datetime);
          startCountdown(wait);
          scheduleState.timer = setTimeout(() => {
            runScheduledCampaign(sched);
          }, wait);
        } else {
          if (typeof addLog === 'function') addLog('warn', 'Scheduled time has already passed.');
        }
      } else {
        // Run immediately
        if (typeof addLog === 'function') addLog('info', 'Running scheduled campaign now...');
        runScheduledCampaign(sched);
      }
    }
  }

  // Countdown timer
  let countdownInterval = null;
  function startCountdown(ms) {
    if (countdownInterval) clearInterval(countdownInterval);
    const end = Date.now() + ms;
    countdownInterval = setInterval(() => {
      const remaining = end - Date.now();
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        const el = document.getElementById('schedCountdown');
        if (el) el.style.display = 'none';
        return;
      }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      const hEl = document.getElementById('schedCdHours');
      const mEl = document.getElementById('schedCdMinutes');
      const sEl = document.getElementById('schedCdSeconds');
      if (hEl) hEl.textContent = String(h).padStart(2, '0');
      if (mEl) mEl.textContent = String(m).padStart(2, '0');
      if (sEl) sEl.textContent = String(s).padStart(2, '0');
    }, 1000);
  }

  // --- Schedule: Cancel ---
  function scheduleCancel() {
    if (scheduleState.timer) { clearTimeout(scheduleState.timer); scheduleState.timer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    fetch('http://localhost:3000/api/schedule/delete', { method: 'POST' }).catch(() => {});
    try { localStorage.removeItem('trafficdrive_schedule'); } catch (e) {}
    const badge = document.getElementById('schedule-status-badge');
    if (badge) { badge.textContent = 'No Schedule'; badge.style.background = 'var(--t3)'; }
    const activateBtn = document.getElementById('schedActivateBtn');
    const cancelBtn = document.getElementById('schedCancelBtn');
    if (activateBtn) activateBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    const countdownEl = document.getElementById('schedCountdown');
    if (countdownEl) countdownEl.style.display = 'none';
    if (typeof addLog === 'function') addLog('warn', 'Schedule cancelled.');
  }

  // --- Run scheduled campaign ---
  function runScheduledCampaign(sched) {
    if (typeof addLog === 'function') addLog('success', 'Running scheduled campaign: ' + (sched.trafficMode || 'direct'));
    // Set URL and mode from schedule
    const urlEl = document.getElementById('targetUrl');
    if (urlEl && sched.url) urlEl.value = sched.url;
    const sessionsEl = document.getElementById('numSessions');
    if (sessionsEl && sched.sessions) sessionsEl.value = sched.sessions;
    const threadsEl = document.getElementById('numThreads');
    if (threadsEl && sched.threads) threadsEl.value = sched.threads;
    // Set mode
    if (sched.trafficMode && typeof setMode === 'function') setMode(sched.trafficMode);
    // Set keyword for organic
    if (sched.keyword) {
      const kwEl = document.getElementById('keywords');
      if (kwEl) kwEl.value = sched.keyword;
    }
    // Start the campaign
    if (typeof startCampaign === 'function') {
      startCampaign();
    }
  }

  // --- Refresh saved schedules list ---
  function refreshSavedSchedules() {
    const listEl = document.getElementById('schedSavedList');
    if (!listEl) return;
    fetch('http://localhost:3000/api/schedule/list')
      .then(r => r.json())
      .then(data => {
        if (!data.success || !data.savedSchedules || data.savedSchedules.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:16px">No schedules saved yet. Configure and click Activate Schedule.</div>';
          return;
        }
        const modeNames = { direct: 'Direct Traffic', organic: 'Organic Traffic', referral: 'Referral Traffic', gmaps: 'Google Maps', rpa: 'RPA Replay' };
        let html = '';
        data.savedSchedules.forEach((sched) => {
          const date = new Date(sched.savedAt || sched.createdAt).toLocaleString();
          const modeLabel = modeNames[sched.trafficMode] || sched.trafficMode || 'Direct';
          const typeLabel = sched.type === 'delay' ? 'After Delay' : sched.type === 'datetime' ? 'Date & Time' : 'Recurring';
          const delayLabel = sched.type === 'delay' ? ((sched.delayHours || 0) + 'h ' + (sched.delayMinutes || 0) + 'm') : (sched.datetime || sched.recurTime || '');
          html += '<div class="rpa-rec-item" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--card2);border-radius:var(--r);margin-bottom:8px">' +
            '<div style="flex:1"><div style="font-weight:600;color:var(--t1)">' + modeLabel + ' → ' + (sched.url || 'No URL').substring(0, 40) + '</div>' +
            '<div style="font-size:11px;color:var(--t3)">' + date + ' · ' + typeLabel + ' · ' + delayLabel + ' · ' + (sched.sessions || 1) + ' sessions · ' + (sched.threads || 1) + ' threads' + (sched.enabled ? '' : ' · DISABLED') + '</div></div>' +
            '<button class="btn btn-g" onclick="activateSavedSchedule(\'' + sched.id + '\')" style="padding:5px 10px;font-size:11px">▶ Run</button>' +
            '<button class="btn btn-danger" onclick="deleteSavedSchedule(\'' + sched.id + '\')" style="padding:5px 10px;font-size:11px">Delete</button>' +
            '</div>';
        });
        listEl.innerHTML = html;
      })
      .catch(() => {
        listEl.innerHTML = '<div style="text-align:center;color:var(--t3);padding:16px">No schedules saved yet. Configure and click Activate Schedule.</div>';
      });
  }

  // --- Activate a saved schedule ---
  function activateSavedSchedule(id) {
    fetch('http://localhost:3000/api/schedule/list')
      .then(r => r.json())
      .then(data => {
        const sched = data.savedSchedules.find(s => s.id === id);
        if (!sched) return;
        if (typeof addLog === 'function') addLog('info', 'Activating saved schedule: ' + (sched.trafficMode || 'direct'));
        runScheduledCampaign(sched);
      })
      .catch(() => {});
  }

  // --- Delete a saved schedule ---
  function deleteSavedSchedule(id) {
    fetch('http://localhost:3000/api/schedule/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(r => r.json()).then(data => {
      if (data.success) {
        if (typeof addLog === 'function') addLog('warn', 'Schedule deleted.');
        refreshSavedSchedules();
      }
    }).catch(() => {});
  }

  // --- Schedule console clear ---
  function schedClearConsole() {
    const el = document.getElementById('schedConsole');
    if (el) el.innerHTML = '';
  }

  // --- Expose globally -----------------------------------------------------
  window.rpaStart = rpaStart;
  window.rpaStopAndSave = rpaStopAndSave;
  window.rpaLoadFile = rpaLoadFile;
  window.rpaRefreshSavedList = rpaRefreshSavedList;
  window.rpaClearConsole = rpaClearConsole;
  window.rpaPlay = rpaPlay;
  window.rpaDelete = rpaDelete;
  window.rpaApplyRecordingSettings = rpaApplyRecordingSettings;
  window.rpaUpdateRecordingTotal = rpaUpdateRecordingTotal;
  window.rpaRefreshProxySelect = rpaRefreshProxySelect;
  window.rpaStopPlay = rpaStopPlay;
  window.rpaUpdateMonitor = rpaUpdateMonitor;
  window.cleanRpaTempData = cleanRpaTempData;
  window.scheduleTypeChanged = scheduleTypeChanged;
  window.saveSchedule = saveSchedule;
  window.toggleSchedule = toggleSchedule;
  window.scheduleActivate = scheduleActivate;
  window.scheduleCancel = scheduleCancel;
  window.runScheduledCampaign = runScheduledCampaign;
  window.refreshSavedSchedules = refreshSavedSchedules;
  window.activateSavedSchedule = activateSavedSchedule;
  window.deleteSavedSchedule = deleteSavedSchedule;
  window.schedClearConsole = schedClearConsole;

  // Refresh saved list on load
  document.addEventListener('DOMContentLoaded', () => {
    rpaRefreshSavedList();
    rpaRefreshProxySelect();
    refreshSavedSchedules();
    // Re-attach to a replay that is already running (e.g. page reload).
    fetch('http://localhost:3000/api/rpa/status')
      .then(r => r.json())
      .then(data => {
        const p = data && data.play;
        if (p && p.running) {
          rpaReplayActive = true;
          rpaUpdateStatus('replaying');
          rpaUpdateMonitor(p);
          rpaLog('Replay already running (' + p.iteration + '/' + p.loop + ').', 'info');
          rpaStartStatusPolling();
        }
      })
      .catch(() => {});
  });
})();
