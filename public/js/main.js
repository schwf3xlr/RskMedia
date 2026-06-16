const auth = {
  token: null,
  userType: null,

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

const api = {
  async request(url, options = {}) {
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

  get(url) {
    return this.request(url);
  },

  post(url, body) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  put(url, body) {
    return this.request(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  delete(url) {
    return this.request(url, { method: 'DELETE' });
  },
};

const toast = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'success') {
    this.init();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this.container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  },
};

const categories = {
  async loadAll() {
    return api.get('/api/categories');
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
    return api.get(`/api/categories/subcategories/${categoryId}`);
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

export { auth, api, toast, categories, favorites };

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

