const auth = {
  token: null,
  userType: (document.querySelector('meta[name="user-type"]')?.content) || null,

  getToken() {
    return this.token;
  },

  getAuthHeaders() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': meta ? meta.content : '',
    };
  },

  async login(token) {
    const headers = this.getAuthHeaders();
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ token, _csrf: headers['X-CSRF-Token'] }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Ошибка подключения к серверу');
    }

    const data = await response.json();
    this.userType = data.type;
    return data;
  },

  async logout() {
    try {
      const headers = this.getAuthHeaders();
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ _csrf: headers['X-CSRF-Token'] }),
      });
    } catch (err) {
      console.error('Logout error:', err);
    }
    this.token = null;
    this.userType = null;
    window.location.href = '/login';
  },

  isAdmin() {
    return this.userType === 'admin';
  },
};

// Refresh the CSRF token in <meta> from the server. Called after a 403
// "Invalid or missing CSRF token" so a stale token in the DOM doesn't require
// a full page reload to recover.
async function refreshCsrfToken() {
  try {
    const res = await fetch('/api/csrf-token', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && data.csrfToken) meta.content = data.csrfToken;
    return data.csrfToken || null;
  } catch {
    return null;
  }
}

const api = {
  async request(url, options = {}, _retried = false) {
    const headers = auth.getAuthHeaders();
    const hasBody = options.body && typeof options.body === 'string';
    const body = hasBody ? JSON.parse(options.body) : {};
    if (hasBody && headers['X-CSRF-Token']) {
      body._csrf = headers['X-CSRF-Token'];
    }
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        ...headers,
        ...options.headers,
      },
      body: hasBody ? JSON.stringify(body) : options.body,
    });

    // 403 has two shapes: auth revoked (log out) and CSRF token stale (refresh
    // + retry once). Peek at the body without consuming it, since the retry
    // needs the original options intact.
    if (response.status === 403 && !_retried) {
      const cloned = response.clone();
      const err = await cloned.json().catch(() => ({}));
      if (err.error === 'Invalid or missing CSRF token') {
        const fresh = await refreshCsrfToken();
        if (fresh) return this.request(url, options, true);
      }
    }

    if (response.status === 401 || response.status === 403) {
      auth.logout();
      return;
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Ошибка запроса к серверу');
    }

    return response.json();
  },

  get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  },

  post(url, body, options = {}) {
    return this.request(url, { ...options, method: 'POST', body: JSON.stringify(body) });
  },

  put(url, body, options = {}) {
    return this.request(url, { ...options, method: 'PUT', body: JSON.stringify(body) });
  },

  delete(url, options = {}) {
    return this.request(url, { ...options, method: 'DELETE' });
  },

  async requestForm(url, options = {}) {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta ? meta.content : '';
    let body = options.body;
    if (token && body instanceof FormData && !body.has('_csrf')) {
      body.append('_csrf', token);
    }
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      body,
      headers: {
        'X-CSRF-Token': token,
        ...options.headers,
      },
    });

    if (response.status === 401 || response.status === 403) {
      auth.logout();
      return;
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Ошибка запроса к серверу');
    }

    return response.json();
  },

  upload(url, formData, { onProgress, onAbort, signal } = {}) {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta ? meta.content : '';
    if (token && !formData.has('_csrf')) {
      formData.append('_csrf', token);
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader('X-CSRF-Token', token);

      if (signal) {
        signal.addEventListener('abort', () => xhr.abort());
      }

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          let message = 'Ошибка загрузки';
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed.error) message = parsed.error;
          } catch {}
          reject(new Error(message));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Ошибка сети')));
      xhr.addEventListener('abort', () => {
        if (onAbort) onAbort();
        reject(new Error('Загрузка отменена'));
      });

      xhr.send(formData);
    });
  },
};

const toast = {
  container: null,
  // Cap the number of visible toasts so a flaky backend spraying errors
  // can't wall off the whole viewport. Oldest is removed when we exceed
  // MAX_STACK.
  MAX_STACK: 4,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  // type: 'success' | 'error' | 'info' | 'warning'
  show(message, type = 'success') {
    this.init();
    // Prune oldest before appending so we never exceed MAX_STACK.
    const existing = this.container.querySelectorAll('.toast');
    if (existing.length >= this.MAX_STACK) {
      existing[0].remove();
    }

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    // Text-node message so any HTML in error strings is rendered as text.
    // Icon comes from a CSS ::before selector so we don't need to inject
    // SVG per toast type.
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.textContent = '×';
    el.appendChild(closeBtn);

    const dismiss = () => {
      if (!el.isConnected) return;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    };

    // Click anywhere (except drag/select) dismisses; also explicit ×.
    el.addEventListener('click', dismiss);

    this.container.appendChild(el);
    const timer = setTimeout(dismiss, type === 'error' ? 5000 : 3000);
    el.addEventListener('mouseenter', () => clearTimeout(timer), { once: true });
  },
};

// Realtime events over SSE. Server publishes:
//   auth.revoked       — this token was replaced by a login elsewhere
//   media.created      — new media landed (payload: { id } or { ids: [] })
//   media.updated      — metadata changed
//   media.deleted      — payload: { ids: [] }
//   zip.progress       — { phase, total, done }
// Handlers register via events.on(name, fn). auth.revoked has a built-in
// handler that toasts and redirects to /login after a short delay.
const events = {
  _es: null,
  _handlers: new Map(),

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this._handlers.get(name)?.delete(fn);
  },

  _emit(name, data) {
    const set = this._handlers.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (e) { console.error('SSE handler error', e); }
    }
  },

  connect() {
    if (this._es) return;
    // EventSource sends the auth cookie automatically because the endpoint
    // is same-origin. Reconnect is built-in with the `retry:` we sent from
    // the server, so no manual backoff loop is needed here.
    try {
      this._es = new EventSource('/api/events');
    } catch { return; }

    const names = ['auth.revoked', 'media.created', 'media.updated', 'media.deleted', 'zip.progress'];
    for (const name of names) {
      this._es.addEventListener(name, (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch {}
        this._emit(name, data);
      });
    }
    this._es.onerror = () => { /* browser auto-reconnects using retry: */ };
  },

  disconnect() {
    if (!this._es) return;
    try { this._es.close(); } catch {}
    this._es = null;
  },
};

// Close the EventSource BEFORE navigating away. Chrome (and other browsers)
// cap HTTP/1.1 connections per origin at 6 — every SSE stream takes one
// slot. Without an explicit close on pagehide, quickly navigating home →
// favorites → admin would leave a chain of half-dead sockets that the
// server hasn't cleaned up yet, and the next page's requests (images,
// /api/*) queue behind them until the browser closes them itself.
// `pagehide` is used instead of `beforeunload` so bfcache and mobile
// backgrounding also trigger it.
window.addEventListener('pagehide', () => events.disconnect());

// Concurrent-login handler — toast + hard redirect. Registered here so
// every page (main, favorites, admin) picks it up regardless of which
// script initialises last.
events.on('auth.revoked', (data) => {
  toast.show(data?.message || 'Выполнен вход с другого устройства', 'warning');
  setTimeout(() => { window.location.href = '/login'; }, 2500);
});

// Connect once DOM is ready — but only for pages where a user is logged in.
if (document.querySelector('meta[name="user-type"]')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => events.connect(), { once: true });
  } else {
    events.connect();
  }
}

const categories = {
  _subcategoriesCache: new Map(),
  _listCache: null,

  get list() {
    return this._listCache || [];
  },

  async loadAll() {
    if (this._listCache) return this._listCache;
    const promise = api.get('/api/categories');
    this._listCache = promise;
    promise.catch(() => { this._listCache = null; });
    const result = await promise;
    this._listCache = result;
    return result;
  },

  invalidateList() {
    this._listCache = null;
  },

  async loadSubcategories(categoryId) {
    if (!categoryId) {
      const subs = await api.get('/api/categories/subcategories');
      // Group by name across all categories; value becomes comma-separated IDs
      const grouped = new Map();
      subs.forEach(s => {
        if (!grouped.has(s.name)) {
          grouped.set(s.name, { id: String(s.id), name: s.name });
        } else {
          const existing = grouped.get(s.name);
          existing.id += ',' + s.id;
        }
      });
      return Array.from(grouped.values());
    }
    // Dedupe: return the same in-flight or resolved promise for repeated calls
    // (e.g. 50 admin cards each pre-populate the subcategory <select>)
    const cacheKey = String(categoryId);
    if (this._subcategoriesCache.has(cacheKey)) {
      return this._subcategoriesCache.get(cacheKey);
    }
    const promise = api.get(`/api/categories/subcategories/${categoryId}`);
    this._subcategoriesCache.set(cacheKey, promise);
    promise.catch(() => this._subcategoriesCache.delete(cacheKey));
    return promise;
  },

  invalidateSubcategories(categoryId) {
    if (categoryId != null) {
      this._subcategoriesCache.delete(String(categoryId));
    } else {
      this._subcategoriesCache.clear();
    }
  },

  populateSelect(select, items, emptyLabel = 'Все') {
    select.innerHTML = `<option value="">${emptyLabel}</option>`;
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    });
  },
};

const favorites = {
  async add(mediaId) {
    await api.post(`/api/favorites/${mediaId}`);
    toast.show('Добавлено в избранное');
  },

  async remove(mediaId) {
    await api.delete(`/api/favorites/${mediaId}`);
    toast.show('Удалено из избранного');
  },

  async check(mediaId) {
    const data = await api.get(`/api/favorites/check/${mediaId}`);
    return data.isFavorite;
  },

  async batchCheck(mediaIds) {
    const data = await api.post('/api/favorites/batch-check', { ids: mediaIds });
    return data;
  },
};

// Custom dropdown в стиль сайта. Заменяет нативный <select> (и особенно
// плох на мобильных, где системный picker закрывает пол-формы). Живёт в
// main.js, потому что и player.js (галерея), и admin.js (формы загрузки и
// редактирование карточек) им пользуются.
//
// Contract: attach к <div class="multi-select" id="…" data-empty="…"
// data-label="…" [data-mode="single"]></div>. Контейнер полностью
// перекраивается конструктором. setOptions([{ id, name }]),
// setValue(idsOrId), getValue() → string[], getSingle() → string.
// В multi-mode чекбоксы, панель остаётся открытой; в single-mode — радио,
// закрывается сразу после клика.
class MultiSelect {
  static _openInstance = null;
  static _globalListenerAttached = false;
  static _attachGlobalListener() {
    if (MultiSelect._globalListenerAttached) return;
    MultiSelect._globalListenerAttached = true;
    document.addEventListener('click', (e) => {
      const open = MultiSelect._openInstance;
      // Панель монтируется в <body>, а не внутрь container — поэтому
      // клик по опции проверяем ОТДЕЛЬНО через panel.contains(). Без
      // этого клик по чекбоксу в multi-mode считался бы "снаружи" и
      // закрывал панель после первого выбора.
      if (!open) return;
      if (open.container.contains(e.target)) return;
      if (open.panel.contains(e.target)) return;
      open.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && MultiSelect._openInstance) {
        MultiSelect._openInstance.close();
      }
    });
  }

  constructor(container) {
    this.container = container;
    this.emptyLabel = container.dataset.empty || 'Все';
    this.groupLabel = container.dataset.label || 'элементы';
    this.mode = container.dataset.mode === 'single' ? 'single' : 'multi';
    this.options = [];
    this.selected = new Set();
    this._build();
    MultiSelect._attachGlobalListener();
  }

  _build() {
    this.container.innerHTML = '';
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'multi-select-toggle';
    this.toggle.setAttribute('aria-haspopup', 'listbox');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.container.classList.contains('open') ? this.close() : this.open();
    });
    this.container.appendChild(this.toggle);

    this.panel = document.createElement('div');
    this.panel.className = 'multi-select-panel';
    this.panel.setAttribute('role', 'listbox');
    if (this.mode === 'multi') this.panel.setAttribute('aria-multiselectable', 'true');
    // Панель монтируется в <body>, а не в container, потому что
    // position: fixed НЕ спасает от stacking context'а предка с
    // transform/opacity/filter (а такие в проекте есть — модалки,
    // карточки с анимацией). Только полный вынос в body гарантирует, что
    // никакой ancestor не участвует в раскладке панели.
    document.body.appendChild(this.panel);
    // Внутрь панели — скролл-контейнер. Скроллбар живёт в нём, поэтому
    // не касается округлых углов внешнего блока.
    this.scroll = document.createElement('div');
    this.scroll.className = 'multi-select-scroll';
    this.panel.appendChild(this.scroll);
    this._updateLabel();
  }

  setOptions(options) {
    this.options = options.map(o => ({ id: String(o.id), name: String(o.name) }));
    this.scroll.innerHTML = '';
    if (this.options.length === 0) {
      // Пустая узкая панель — плохой UX. Показываем empty state.
      const empty = document.createElement('div');
      empty.className = 'multi-select-empty';
      empty.textContent = 'Нет доступных вариантов';
      this.scroll.appendChild(empty);
    } else {
      for (const opt of this.options) {
        if (this.mode === 'multi') this.scroll.appendChild(this._buildMultiOption(opt));
        else this.scroll.appendChild(this._buildSingleOption(opt));
      }
    }
    for (const id of Array.from(this.selected)) {
      if (!this.options.find(o => o.id === id)) this.selected.delete(id);
    }
    this._updateLabel();
  }

  _buildMultiOption(opt) {
    const label = document.createElement('label');
    label.className = 'multi-select-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = opt.id;
    cb.checked = this.selected.has(opt.id);
    if (cb.checked) label.classList.add('checked');
    cb.addEventListener('change', () => {
      if (cb.checked) this.selected.add(opt.id);
      else this.selected.delete(opt.id);
      label.classList.toggle('checked', cb.checked);
      this._updateLabel();
      this.container.dispatchEvent(new CustomEvent('change', { detail: this.getValue() }));
    });
    const text = document.createElement('span');
    text.textContent = opt.name;
    label.append(cb, text);
    return label;
  }

  _buildSingleOption(opt) {
    const row = document.createElement('div');
    row.className = 'multi-select-option single';
    row.setAttribute('role', 'option');
    row.tabIndex = 0;
    if (this.selected.has(opt.id)) {
      row.classList.add('checked');
      row.setAttribute('aria-selected', 'true');
    }
    const check = document.createElement('span');
    check.className = 'multi-select-check';
    check.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 6 9 17 4 12"/></svg>';
    const text = document.createElement('span');
    text.textContent = opt.name;
    row.append(check, text);
    const pick = () => {
      this.selected = new Set([opt.id]);
      this.scroll.querySelectorAll('.multi-select-option').forEach(el => {
        const isThis = el === row;
        el.classList.toggle('checked', isThis);
        if (isThis) el.setAttribute('aria-selected', 'true');
        else el.removeAttribute('aria-selected');
      });
      this._updateLabel();
      this.container.dispatchEvent(new CustomEvent('change', { detail: this.getValue() }));
      this.close();
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    return row;
  }

  setValue(ids) {
    const list = Array.isArray(ids) ? ids : (ids !== undefined && ids !== null && ids !== '' ? [ids] : []);
    this.selected = new Set(list.map(String));
    if (this.mode === 'multi') {
      this.scroll.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = this.selected.has(cb.value);
        cb.parentElement.classList.toggle('checked', cb.checked);
      });
    } else {
      this.scroll.querySelectorAll('.multi-select-option').forEach((row, i) => {
        const opt = this.options[i];
        if (!opt) return;
        const isSel = this.selected.has(opt.id);
        row.classList.toggle('checked', isSel);
        if (isSel) row.setAttribute('aria-selected', 'true');
        else row.removeAttribute('aria-selected');
      });
    }
    this._updateLabel();
  }

  getValue() { return Array.from(this.selected); }
  getSingle() { return Array.from(this.selected)[0] || ''; }
  clear() { this.setValue([]); }

  _updateLabel() {
    const n = this.selected.size;
    if (n === 0) {
      this.toggle.textContent = this.emptyLabel;
      this.toggle.dataset.empty = 'true';
    } else if (n === 1) {
      const id = Array.from(this.selected)[0];
      const opt = this.options.find(o => o.id === id);
      this.toggle.textContent = opt ? opt.name : `1 ${this.groupLabel}`;
      this.toggle.dataset.empty = 'false';
    } else {
      this.toggle.textContent = `${this.groupLabel}: ${n}`;
      this.toggle.dataset.empty = 'false';
    }
  }

  // Рассчитать координаты панели относительно тогглера. Панель fixed →
  // top/left в viewport координатах. Если снизу мало места и сверху
  // больше — открываем вверх (позиционируем над тогглером).
  _positionPanel() {
    const rect = this.toggle.getBoundingClientRect();
    const GAP = 6;
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Сначала рендерим панель с дефолтной шириной, чтобы измерить её
    // реальный размер, потом уже двигаем куда надо.
    this.panel.style.minWidth = `${rect.width}px`;
    // Максимум по высоте — сколько влезет в viewport (с запасом MARGIN);
    // CSS max-height: 320px возьмёт минимум из двух.
    const availBelow = vh - rect.bottom - GAP - MARGIN;
    const availAbove = rect.top - GAP - MARGIN;
    const openUp = availBelow < 160 && availAbove > availBelow;
    const maxH = Math.max(120, openUp ? availAbove : availBelow);
    this.panel.style.maxHeight = `${Math.min(320, maxH)}px`;

    // Ширина: минимум = ширина тогглера, максимум задан в CSS.
    const panelW = this.panel.offsetWidth;
    // Прижимаем к левому краю тогглера. Если выступает за viewport —
    // сдвигаем влево ровно на выступ.
    let left = rect.left;
    if (left + panelW + MARGIN > vw) left = vw - panelW - MARGIN;
    if (left < MARGIN) left = MARGIN;

    this.panel.style.left = `${left}px`;
    if (openUp) {
      this.panel.style.top = `${rect.top - GAP - this.panel.offsetHeight}px`;
    } else {
      this.panel.style.top = `${rect.bottom + GAP}px`;
    }
  }

  open() {
    if (MultiSelect._openInstance && MultiSelect._openInstance !== this) {
      MultiSelect._openInstance.close();
    }
    this.container.classList.add('open');
    // Панель живёт в <body>, поэтому селектор .multi-select.open
    // .multi-select-panel не сработает — навешиваем класс на неё
    // напрямую. Иначе offsetHeight = 0 и позиционирование даёт NaN/0.
    this.panel.classList.add('open');
    this.toggle.setAttribute('aria-expanded', 'true');
    MultiSelect._openInstance = this;
    // Позиционируем только после того, как панель стала flex-визимой
    // (иначе offsetHeight = 0). Используем rAF, чтобы CSS применился.
    requestAnimationFrame(() => this._positionPanel());
    // Скролл СТРАНИЦЫ (не самой панели) / изменение размера окна →
    // закрываем панель. Это повторяет поведение native <select>.
    // capture: true нужен потому, что для scrollable div'ов scroll НЕ
    // всплывает — ловим на пути вниз. Но одновременно это ловит и скролл
    // ВНУТРИ .multi-select-scroll — проверяем e.target и игнорируем
    // события, чей target — сама панель или её потомок; иначе панель
    // закрывалась в момент касания скроллбара.
    this._onScroll = (e) => {
      if (this.panel.contains(e.target) || e.target === this.panel) return;
      this.close();
    };
    this._onResize = () => this.close();
    window.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  close() {
    this.container.classList.remove('open');
    this.panel.classList.remove('open');
    this.toggle.setAttribute('aria-expanded', 'false');
    if (this._onScroll) {
      window.removeEventListener('scroll', this._onScroll, { capture: true });
      this._onScroll = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    if (MultiSelect._openInstance === this) MultiSelect._openInstance = null;
  }
}

export { auth, api, toast, categories, favorites, events, MultiSelect };

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => auth.logout());
}

const navbarToggle = document.getElementById('navbarToggle');
const navbarMenu = document.getElementById('navbarMenu');
if (navbarToggle && navbarMenu) {
  navbarToggle.addEventListener('click', () => {
    const isOpen = navbarMenu.classList.toggle('active');
    navbarToggle.setAttribute('aria-expanded', String(isOpen));
  });
}

