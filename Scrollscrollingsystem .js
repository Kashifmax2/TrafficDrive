// Scrollscrollingsystem .js — Provides the ScrollScrollingSystem class used
// by the Automation / Scroll System page in the dashboard.
//
// This is a lightweight in-page scrolling simulator. It exposes:
//   new ScrollScrollingSystem(opts)
//   instance.scrollTo({ target, mode })  -> Promise<void>
//
// `target` is a pixel offset (number) or 'bottom'/'top'.
// `mode` is 'natural' (animated) or 'instant'.

(function () {
  'use strict';

  class ScrollScrollingSystem {
    constructor(opts) {
      this.opts = opts || {};
      this.debug = !!this.opts.debug;
      this._stopped = false;
    }

    stop() {
      this._stopped = true;
    }

    log(msg) {
      if (this.debug) console.log('[ScrollSystem]', msg);
    }

    async scrollTo({ target, mode }) {
      if (this._stopped) return;
      let dest = 0;
      if (typeof target === 'number') {
        dest = target;
      } else if (target === 'bottom') {
        dest = document.documentElement.scrollHeight;
      } else if (target === 'top') {
        dest = 0;
      } else {
        dest = parseInt(target, 10) || 0;
      }

      // Clamp to valid range
      const max = document.documentElement.scrollHeight - window.innerHeight;
      dest = Math.max(0, Math.min(dest, max));

      if (mode === 'instant') {
        window.scrollTo(0, dest);
        this.log('instant scroll to ' + dest);
        return;
      }

      // Natural (animated) scroll — step over ~400ms
      const start = window.scrollY || document.documentElement.scrollTop;
      const distance = dest - start;
      const steps = 20;
      const stepTime = 20;
      for (let i = 1; i <= steps; i++) {
        const eased = start + (distance * (1 - Math.pow(1 - i / steps, 3)));
        window.scrollTo(0, eased);
        await new Promise((r) => setTimeout(r, stepTime));
      }
      window.scrollTo(0, dest);
      this.log('natural scroll to ' + dest);
    }
  }

  window.ScrollScrollingSystem = ScrollScrollingSystem;
})();
