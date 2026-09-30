/* theme.js - shared light / dark / auto handling for every page.
 * Load this FIRST in <head> (blocking, no defer) so the right theme is on
 * <html> before anything paints - no dark flash on a light screen.
 *
 *   CrowdTheme.use(storageKey)    apply the mode last saved under that key
 *   CrowdTheme.set(mode, persist) 'auto' | 'light' | 'dark'
 *   CrowdTheme.follow(screen, slug)  DJ-controlled screens (kiosk / visuals):
 *                                 keep in step with the admin's Settings choice
 *
 * 'auto' follows the device's own light/dark setting live. */
(function () {
    var doc = document.documentElement;
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    var mode = 'auto';
    var key = null;
    var VALID = { auto: 1, light: 1, dark: 1 };

    function resolve(m) {
        if (m === 'light' || m === 'dark') return m;
        return mq && mq.matches ? 'light' : 'dark';
    }
    function apply() {
        var r = resolve(mode);
        doc.setAttribute('data-theme', r);
        doc.setAttribute('data-theme-mode', mode);
        doc.style.colorScheme = r;
        try { window.dispatchEvent(new CustomEvent('crowdtheme', { detail: { mode: mode, resolved: r } })); } catch (e) {}
    }
    function read(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function write(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

    window.CrowdTheme = {
        use: function (storageKey) {
            key = storageKey;
            var saved = key ? read(key) : null;
            mode = VALID[saved] ? saved : 'auto';
            apply();
        },
        set: function (m, persist) {
            if (!VALID[m]) return;
            var changed = m !== mode;
            mode = m;
            if (persist !== false && key) write(key, mode);
            if (changed || !doc.getAttribute('data-theme')) apply();
        },
        get: function () { return mode; },
        follow: function (screen, slug) {
            var poll = function () {
                fetch('/e/' + encodeURIComponent(slug) + '/api/site-config', { cache: 'no-store' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) { if (d && d.themes && d.themes[screen]) window.CrowdTheme.set(d.themes[screen]); })
                    .catch(function () {});
            };
            poll();
            setInterval(poll, 10000);
        }
    };

    var onSystemChange = function () { if (mode === 'auto') apply(); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onSystemChange); else if (mq.addListener) mq.addListener(onSystemChange); }
    apply(); // sensible default until a page calls use()
})();
