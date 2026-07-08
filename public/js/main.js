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
};

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

export { auth, api, toast, categories, favorites, events };

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

