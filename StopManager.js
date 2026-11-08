// StopManager.js
// Centralised stop/pause bookkeeping for traffic campaigns.
//
// Each campaign gets a unique id. Sessions register their browsers with the
// manager so that `stopCampaign(id)` can force-close every browser instantly
// and abort any in-flight `sleep()` calls — this is what makes the Stop
// button feel responsive even when sessions are stuck inside long waits.

let nextCampaignId = 1;

// campaignId -> { stopped, browsers: Set<Browser>, sleepTimers: Set<timeout> }
const campaigns = new Map();

function startCampaign() {
  const id = `camp_${nextCampaignId++}`;
  campaigns.set(id, { stopped: false, browsers: new Set(), sleepTimers: new Set() });
  return id;
}

function ensure(id) {
  if (!campaigns.has(id)) {
    campaigns.set(id, { stopped: false, browsers: new Set(), sleepTimers: new Set() });
  }
  return campaigns.get(id);
}

function isStopped(id) {
  if (!id) return false;
  const c = campaigns.get(id);
  return !!(c && c.stopped);
}

function registerBrowser(id, browser) {
  if (!id || !browser) return;
  ensure(id).browsers.add(browser);
}

function unregisterBrowser(id, browser) {
  if (!id || !browser) return;
  const c = campaigns.get(id);
  if (c) c.browsers.delete(browser);
}

// Cancellable sleep — resolves immediately when the campaign is stopped.
function sleep(id, ms) {
  if (!id) return new Promise((r) => setTimeout(r, ms));
  const c = ensure(id);
  if (c.stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      c.sleepTimers.delete(t);
      resolve();
    }, ms);
    c.sleepTimers.add(t);
  });
}

async function stopCampaign(id) {
  const c = campaigns.get(id);
  if (!c) return;
  c.stopped = true;

  // Abort every pending cancellable sleep.
  c.sleepTimers.forEach((t) => {
    clearTimeout(t);
  });
  c.sleepTimers.clear();

  // Force-close every registered browser.
  const closers = [];
  c.browsers.forEach((b) => {
    closers.push(
      (async () => {
        try { await b.close(); } catch (_) {}
      })()
    );
  });
  await Promise.all(closers);
  c.browsers.clear();
}

function endCampaign(id) {
  if (!id) return;
  const c = campaigns.get(id);
  if (c) {
    c.sleepTimers.forEach((t) => clearTimeout(t));
    c.sleepTimers.clear();
  }
  campaigns.delete(id);
}

module.exports = {
  startCampaign,
  endCampaign,
  isStopped,
  registerBrowser,
  unregisterBrowser,
  stopCampaign,
  sleep,
};
