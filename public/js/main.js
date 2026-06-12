const auth = {
  token: localStorage.getItem('jwt_token'),
  userType: localStorage.getItem('user_type'),

  getToken() {
    return this.token;
  },

  getAuthHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  },

  async login(token) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка подключения к серверу');
    }

    const data = await response.json();
    this.token = data.token;
    this.userType = data.type;
    localStorage.setItem('jwt_token', data.token);
    localStorage.setItem('user_type', data.type);
    return data;
  },

  logout() {
    this.token = null;
    this.userType = null;
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('user_type');
    window.location.href = '/login';
  },

  isAdmin() {
    return this.userType === 'admin';
  },

  isAuthenticated() {
    return !!this.token;
  },
};

const api = {
  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
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
      const error = await response.json();
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
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'success') {
    if (!this.container) this.init();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this.container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3000);
  },
};

const categories = {
  async loadAll() {
    return api.get('/api/categories');
  },

  async loadSubcategories(categoryId) {
    if (!categoryId) return api.get('/api/categories/subcategories');
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
};

export { auth, api, toast, categories, favorites };

if (!window.location.pathname.includes('/login')) {
  if (!auth.isAuthenticated()) {
    window.location.href = '/login';
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => auth.logout());
  }

  const adminLink = document.getElementById('adminLink');
  if (adminLink && auth.isAdmin()) {
    adminLink.style.display = 'inline-block';
  }

  const navbarToggle = document.getElementById('navbarToggle');
  const navbarMenu = document.getElementById('navbarMenu');
  if (navbarToggle && navbarMenu) {
    navbarToggle.addEventListener('click', () => {
      navbarMenu.classList.toggle('active');
    });
  }
}
