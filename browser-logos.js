// browser-logos.js — Provides BROWSER_LOGOS, a map of browser id/name to
// inline SVG data-URI logos. Used by getBrowserLogo() / getBrowserLogoImg()
// in index.html. When a logo is missing the UI falls back to UA_ICONS.
//
// Logos are simple inline SVGs (no external assets) so the app works offline.

(function () {
  'use strict';

  function svg(content) {
    return 'data:image/svg+xml,' + encodeURIComponent(content);
  }

  const LOGOS = {};

  // --- Chromium-based browsers (shared blue globe icon) -------------------
  const chromiumIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#4285F4"/><circle cx="12" cy="12" r="4.5" fill="#fff"/><circle cx="12" cy="12" r="3" fill="#4285F4"/></svg>');
  ['chromium', 'ungoogled', 'thorium', 'superbird', 'iridium', 'epic', 'avast-secure', 'avg-secure', 'ccleaner', 'comodo-dragon', 'slepnir', 'slimjet', 'cent'].forEach((id) => { LOGOS[id] = chromiumIcon; });

  // --- Google Chrome family -----------------------------------------------
  const chromeIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#4285F4"/><circle cx="12" cy="12" r="4.5" fill="#fff"/><circle cx="12" cy="12" r="3" fill="#4285F4"/><circle cx="12" cy="5.5" r="2" fill="#DB4437"/><circle cx="6.2" cy="15.5" r="2" fill="#0F9D58"/><circle cx="17.8" cy="15.5" r="2" fill="#F4B400"/></svg>');
  ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'].forEach((id) => { LOGOS[id] = chromeIcon; });

  // --- Microsoft Edge family ----------------------------------------------
  const edgeIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#0078D7"/><path d="M7 16c1.5 2 4 3 6 2.5 2-.5 3.5-2 4-4-2 1.5-4.5 2-6.5 1S7.5 13 7 11c-.5 2 0 4 0 5z" fill="#50E6FF"/></svg>');
  ['edge', 'edge-beta', 'edge-dev', 'edge-canary'].forEach((id) => { LOGOS[id] = edgeIcon; });

  // --- Brave --------------------------------------------------------------
  LOGOS['brave'] = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FB542B"/><path d="M12 5l5 2 1 3-3 6-3 2-3-2-3-6 1-3z" fill="#fff" opacity="0.9"/></svg>');
  ['brave-beta', 'brave-nightly'].forEach((id) => { LOGOS[id] = LOGOS['brave']; });

  // --- Vivaldi ------------------------------------------------------------
  const vivaldiIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#EF3939"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold" font-family="sans-serif">V</text></svg>');
  ['vivaldi', 'vivaldi-snapshot'].forEach((id) => { LOGOS[id] = vivaldiIcon; });

  // --- Opera family -------------------------------------------------------
  const operaIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF1B2D"/><ellipse cx="12" cy="12" rx="5" ry="8" fill="#B80008"/></svg>');
  ['opera', 'opera-gx', 'opera-beta', 'opera-developer'].forEach((id) => { LOGOS[id] = operaIcon; });

  // --- Yandex -------------------------------------------------------------
  LOGOS['yandex'] = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FC3F1D"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold" font-family="sans-serif">Y</text></svg>');

  // --- Firefox family -----------------------------------------------------
  const firefoxIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF7139"/><path d="M12 6c-1 0-3.5.5-4.5 3.5 1-1 2.5-1.5 3.5-1-.5 1.5-.5 3 .5 4.5 0-1.5.5-3 2-4 .5 1 .5 2.5 0 4 1.5-1.5 2-3.5 1.5-5.5 1 .5 2 1.5 2 3 0-3-2-5-5-5z" fill="#FFC850"/></svg>');
  ['firefox', 'firefox-beta', 'firefox-dev', 'firefox-nightly', 'firefox-esr', 'waterfox', 'librewolf', 'pale-moon', 'basilisk', 'k-meleon', 'seamonkey', 'tor-browser', 'floorp', 'zen'].forEach((id) => { LOGOS[id] = firefoxIcon; });

  // --- Other engines ------------------------------------------------------
  const otherIcon = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#6B7280"/><circle cx="12" cy="12" r="5" fill="#fff" opacity="0.3"/></svg>');
  ['comodo-ice', 'falkon', 'maxthon', 'midori', 'puffin', 'colibri'].forEach((id) => { LOGOS[id] = otherIcon; });

  // --- Name-based lookups (lowercased, hyphenated) ------------------------
  // getBrowserLogo() looks up by browser name too, so add common names.
  LOGOS['google-chrome'] = chromeIcon;
  LOGOS['microsoft-edge'] = edgeIcon;
  LOGOS['mozilla-firefox'] = firefoxIcon;
  LOGOS['brave'] = LOGOS['brave'];
  LOGOS['yandex-browser'] = LOGOS['yandex'];

  window.BROWSER_LOGOS = LOGOS;
})();
