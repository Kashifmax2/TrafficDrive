// SessionProfile.js
// Shared User-Agent + viewport rules for every traffic module.
//
// Two bugs this fixes:
//   1. `autoRotateResolutions` was sent as a real per-thread array of
//      {width,height} by the UI, but modules treated it as a boolean and
//      picked from their own hard-coded pool. The selected resolutions were
//      therefore never applied.
//   2. Mobile resolutions from the UI are physical pixels (e.g. 1080x2340).
//      Using them directly as a CSS viewport renders the desktop layout on a
//      huge screen. They are converted with a device scale factor instead.

'use strict';

function pickRandom(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function toWidthHeight(item) {
  if (Array.isArray(item)) {
    return { width: parseInt(item[0], 10) || 0, height: parseInt(item[1], 10) || 0 };
  }
  if (item && typeof item === 'object') {
    return { width: parseInt(item.width, 10) || 0, height: parseInt(item.height, 10) || 0 };
  }
  return null;
}

// Convert a physical mobile/tablet resolution to a realistic CSS viewport.
function physicalToViewport(width, height, device) {
  const isTablet = device === 'tablet';
  let w = parseInt(width, 10) || (isTablet ? 768 : 390);
  let h = parseInt(height, 10) || (isTablet ? 1024 : 844);
  let scale = 1;
  const minW = isTablet ? 600 : 320;
  const maxW = isTablet ? 1280 : 500;
  if (w > maxW) {
    scale = w >= 1000 ? 3 : 2;
    let cssW = Math.round(w / scale);
    if (cssW < minW) {
      // Too small after scaling: keep the original CSS width instead of
      // producing an unrealistic 300px-wide viewport.
      scale = 1;
      cssW = w;
    }
    w = cssW;
    h = Math.round(h / scale);
  }
  return { width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: scale };
}

/**
 * @param {string} device desktop|mobile|tablet
 * @param {Array|boolean|null} autoRotateResolutions per-thread array from UI
 * @param {number} vpWidth selected/base width
 * @param {number} vpHeight selected/base height
 * @param {number} sessionNum 1-based session/thread number
 */
function chooseViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum) {
  const num = Math.max(1, parseInt(sessionNum, 10) || 1);
  let chosen = null;

  if (Array.isArray(autoRotateResolutions) && autoRotateResolutions.length) {
    // The array is generated per thread by the UI. Use the matching entry,
    // then wrap around when sessions > generated entries.
    chosen = toWidthHeight(autoRotateResolutions[(num - 1) % autoRotateResolutions.length]);
  } else if (autoRotateResolutions === true) {
    // Legacy boolean flag: pick a sensible random resolution for the device.
    const pool = device === 'mobile'
      ? [[360, 640], [360, 800], [375, 812], [390, 844], [412, 915], [414, 896]]
      : device === 'tablet'
        ? [[600, 960], [768, 1024], [800, 1280], [834, 1194], [1024, 1366]]
        : [[1280, 720], [1280, 800], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080]];
    chosen = toWidthHeight(pickRandom(pool));
  }

  if (device === 'mobile' || device === 'tablet') {
    if (chosen) return physicalToViewport(chosen.width, chosen.height, device);
    return physicalToViewport(vpWidth, vpHeight, device);
  }

  if (chosen) {
    return {
      width: chosen.width || 1280,
      height: chosen.height || 800,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    };
  }
  return {
    width: parseInt(vpWidth, 10) || 1280,
    height: parseInt(vpHeight, 10) || 800,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  };
}

/**
 * @param {Array<string>} userAgents selected UA list from the UI
 * @param {boolean} autoRotate rotate per session
 * @param {string} device desktop|mobile|tablet
 * @param {{desktop?:string[],mobile?:string[],tablet?:string[]}} pools fallback pools
 */
function chooseUserAgent(userAgents, autoRotate, device, pools) {
  const list = Array.isArray(userAgents) ? userAgents.filter(Boolean) : [];
  if (list.length) {
    return autoRotate ? (pickRandom(list) || list[0]) : list[0];
  }
  const fallback = pools || {};
  const pool = device === 'mobile' ? fallback.mobile
    : device === 'tablet' ? fallback.tablet
      : fallback.desktop;
  if (Array.isArray(pool) && pool.length) return pickRandom(pool);
  return '';
}

// One-line log so users can see what was actually applied.
function describeProfile(ua, vp, device) {
  const uaShort = ua ? (ua.length > 58 ? ua.slice(0, 58) + '…' : ua) : 'browser default';
  const physical = vp && vp.deviceScaleFactor > 1
    ? `${vp.width * vp.deviceScaleFactor}×${vp.height * vp.deviceScaleFactor} @${vp.deviceScaleFactor}x → `
    : '';
  return `Device ${device || 'desktop'} · Viewport ${physical}${vp.width}×${vp.height} · UA ${uaShort}`;
}

module.exports = {
  chooseViewport,
  chooseUserAgent,
  physicalToViewport,
  describeProfile,
  pickRandom,
};
