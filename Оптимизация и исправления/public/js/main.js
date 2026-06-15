const auth = {
  token: null,
  userType: null,

  getToken() {
    return this.token;
  },

  getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
    };
  },

  async login(token) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
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
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
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
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...auth.getAuthHeaders(),
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

  async requestForm(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
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

