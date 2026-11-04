// ============================================================
// CSS Selector Hider - shared UI helpers
// ============================================================
// Icons are hand-written inline SVG: no icon library, and no text glyphs
// ("×", "＋") standing in for icons — their size, weight and baseline change
// with whatever font happens to be loaded.
// ============================================================

const CSHUI = (function () {

    const svg = (path) => `<svg viewBox="0 0 11 11" width="11" height="11" aria-hidden="true">`
        + `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

    return {
        icon: {
            x: svg('M1.4 1.4l8.2 8.2M9.6 1.4L1.4 9.6')
        }
    };
})();
