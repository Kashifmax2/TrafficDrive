// ProxyRotation.js
// Retries one session with a different proxy when the current proxy cannot
// open the target ("This site can't be reached" / net::ERR_*).

function proxyPoolOf(config) {
  const data = config && config.proxies;
  if (!data || !data.useProxies) return [];
  const working = Array.isArray(data.workingProxies) ? data.workingProxies : [];
  const all = Array.isArray(data.proxies) ? data.proxies : [];
  const pool = working.length > 0 ? working : all;
  return Array.isArray(pool) ? pool : [];
}

function isProxyFailureResult(result) {
  return result === 'proxy_blocked' || result === 'proxy_failed';
}

// runOnce(configWithOffset) must resolve to true | false | 'proxy_blocked'.
async function runWithProxyRetry({ config, runOnce, onLog = () => {}, isStopped = () => false }) {
  const size = proxyPoolOf(config).length;

  let attempts = 1;
  if (size > 1) attempts = Math.min(size, 6);
  else if (size === 1) attempts = 2;

  let last = false;
  for (let i = 0; i < attempts; i++) {
    if (isStopped && isStopped()) return false;

    const result = await runOnce({ ...config, __proxyOffset: i });
    last = result;

    if (!isProxyFailureResult(result)) return !!result;
    if (i < attempts - 1) {
      onLog(`[Proxy] Switching to proxy #${i + 2} and reopening...`, 'WARN');
    }
  }

  return false;
}

module.exports = { proxyPoolOf, runWithProxyRetry };
