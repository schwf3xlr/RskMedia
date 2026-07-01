// Initialize lucide icons after DOM is ready (lucide.min.js is loaded
// non-deferred in head, so the library is already available).
lucide.createIcons();

// Theme toggle: persists to localStorage and respects prefers-color-scheme
// on first visit. The current value is already applied to <html> by the
// inline script in header.ejs before paint, so this just wires up the click.
(function setupThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('rskmedia-theme', next);
    } catch (e) {
      // localStorage might be unavailable in private mode - the toggle
      // still works for the current session, just won't survive reload.
    }
    // Re-render lucide icons so the visible icon swaps (CSS hides the other).
    lucide.createIcons();
  });

  // If the user hasn't set a preference yet, follow OS-level changes live.
  // (If they HAVE set one, we leave them alone.)
  if (!localStorage.getItem('rskmedia-theme') && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
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
