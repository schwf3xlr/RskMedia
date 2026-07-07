// Initialize lucide icons after DOM is ready (lucide.min.js is loaded
// non-deferred in head, so the library is already available).
lucide.createIcons();

// Theme toggle: cycles light → dark → auto and persists the *preference*
// (not just the resolved theme). "auto" follows prefers-color-scheme live.
// The resolved theme (dark/light) is applied to <html data-theme>; the
// user's raw preference (light/dark/auto) lives on <html data-theme-pref>
// so the toggle button can show the correct icon.
(function setupThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  const PREF_KEY = 'rskmedia-theme';
  const MQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function readPref() {
    try {
      const stored = localStorage.getItem(PREF_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
    } catch {}
    return 'auto';
  }

  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return MQ && MQ.matches ? 'light' : 'dark';
  }

  function apply(pref) {
    document.documentElement.setAttribute('data-theme', resolve(pref));
    document.documentElement.setAttribute('data-theme-pref', pref);
    // Sync aria-label for accessibility so screen-reader users know
    // which state they're in.
    const nextIn = pref === 'light' ? 'тёмную' : pref === 'dark' ? 'авто' : 'светлую';
    btn.setAttribute('aria-label', `Сменить тему (сейчас: ${pref === 'auto' ? 'авто' : pref === 'light' ? 'светлая' : 'тёмная'}, переключить на ${nextIn})`);
  }

  apply(readPref());

  btn.addEventListener('click', () => {
    const cur = readPref();
    // Cycle order: light → dark → auto → light. Feels intuitive because
    // dark is the visual "opposite" of light and auto lets the OS decide.
    const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'auto' : 'light';
    try { localStorage.setItem(PREF_KEY, next); } catch {}
    apply(next);
    if (window.lucide) window.lucide.createIcons();
  });

  // Follow OS changes ONLY when the user preference is auto (or unset).
  if (MQ) {
    const onChange = () => {
      if (readPref() === 'auto') apply('auto');
    };
    if (MQ.addEventListener) MQ.addEventListener('change', onChange);
    else if (MQ.addListener) MQ.addListener(onChange);
  }
})();

// Mobile menu toggle.
(function setupMobileMenu() {
  const toggle = document.getElementById('navbarToggle');
  const menu = document.getElementById('navbarMenu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('active');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
})();
