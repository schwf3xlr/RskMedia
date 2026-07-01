import { auth, api, toast, categories, favorites } from './main.js';

function showConfirm(message, options = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const iconName = options.icon || 'alert-triangle';
    const okText = options.okText || 'Подтвердить';
    const cancelText = options.cancelText || 'Отмена';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-icon"><i data-lucide="${iconName}" class="icon-lg icon-danger"></i></div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-actions">
          <button class="btn btn-sm" id="confirmCancel">${cancelText}</button>
          <button class="btn btn-danger btn-sm" id="confirmOk">${okText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    if (window.lucide) window.lucide.createIcons();

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('#confirmCancel').addEventListener('click', () => close(false));
    overlay.querySelector('#confirmOk').addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    const okBtn = overlay.querySelector('#confirmOk');
    if (okBtn) okBtn.focus();
  });
}

const gallery = {
  media: [],
  page: 1,
  loading: false,
  hasMore: true,
  filters: {},
  isFavorites: window.location.pathname === '/favorites',
  zoom: null,
  favoriteCache: new Map(),
  focusTrap: null,
  abortController: null,

  async init() {
    // Categories + subcategories are independent — fetch in parallel
    await Promise.all([this.loadCategories(), this.loadSubcategories()]);
    this.restoreFiltersFromURL();
    this.setupFilters();
    this.setupInfiniteScroll();
    this.setupModal();
    await this.loadMore();
  },

  setupFilters() {
    const categoryFilter = document.getElementById('categoryFilter');
    const subcategoryFilter = document.getElementById('subcategoryFilter');
    const ageFilter = document.getElementById('ageFilter');
    const sortFilter = document.getElementById('sortFilter');
    const applyBtn = document.getElementById('applyFilters');
    const clearBtn = document.getElementById('clearFilters');

    if (categoryFilter) {
      categoryFilter.addEventListener('change', async () => {
        if (subcategoryFilter) {
          const subs = await categories.loadSubcategories(categoryFilter.value || null);
          categories.populateSelect(subcategoryFilter, subs, 'Все подкатегории');
        }
      });
    }

    const apply = () => {
      this.filters = {
        category_id: categoryFilter?.value || '',
        subcategory_id: subcategoryFilter?.value || '',
        age: ageFilter?.value || '',
        sort: sortFilter?.value || 'newest',
      };
      this.updateURL();
      this.resetGrid();
      this.loadMore();
    };

    if (applyBtn) applyBtn.addEventListener('click', apply);

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (categoryFilter) categoryFilter.value = '';
        if (subcategoryFilter) subcategoryFilter.value = '';
        if (ageFilter) ageFilter.value = '';
        if (sortFilter) sortFilter.value = 'newest';
        this.filters = {};
        this.updateURL();
        this.resetGrid();
        this.loadMore();
      });
    }

    // Set initial values from URL
    if (categoryFilter) categoryFilter.value = this.filters.category_id || '';
    if (subcategoryFilter) subcategoryFilter.value = this.filters.subcategory_id || '';
    if (ageFilter) ageFilter.value = this.filters.age || '';
    if (sortFilter) sortFilter.value = this.filters.sort || 'newest';
  },

  restoreFiltersFromURL() {
    const params = new URLSearchParams(window.location.search);
    this.filters = {
      category_id: params.get('category_id') || '',
      subcategory_id: params.get('subcategory_id') || '',
      age: params.get('age') || '',
      sort: params.get('sort') || 'newest',
    };
  },

  updateURL() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.filters)) {
      if (value) params.set(key, value);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  },

  resetGrid() {
    this.page = 1;
    this.media = [];
    this.hasMore = true;
    this.favoriteCache.clear();
    // Abort any in-flight loadMore so stale responses don't overwrite the new grid
    if (this.abortController) this.abortController.abort();
    const grid = document.getElementById('mediaGrid');
    if (grid) grid.innerHTML = '';
  },

  async loadCategories() {
    const cats = await categories.loadAll();
    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
      categories.populateSelect(categoryFilter, cats, 'Все категории');
    }
  },

  async loadSubcategories() {
    const subs = await categories.loadSubcategories();
    const subcategoryFilter = document.getElementById('subcategoryFilter');
    if (subcategoryFilter) {
      categories.populateSelect(subcategoryFilter, subs, 'Все подкатегории');
    }
  },

  setupInfiniteScroll() {
    const sentinel = document.getElementById('sentinel');
    if (!sentinel) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !this.loading && this.hasMore) {
          this.loadMore();
        }
      });
    }, { rootMargin: '300px' });

    observer.observe(sentinel);
  },

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const spinner = document.getElementById('loadingSpinner');
    const emptyState = document.getElementById('emptyState');
    if (spinner) spinner.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    try {
      const endpoint = this.isFavorites ? '/api/favorites' : '/api/media';
      const params = new URLSearchParams({
        page: this.page,
        limit: 20,
        ...this.filters,
      });
      const response = await api.get(`${endpoint}?${params}`, { signal });

      const items = response.media || response;

      if (items.length === 0) {
        this.hasMore = false;
        if (this.page === 1 && this.media.length === 0) {
          if (emptyState) {
            emptyState.classList.remove('hidden');
            const title = document.getElementById('emptyTitle');
            const text = document.getElementById('emptyText');
            if (this.isFavorites) {
              if (title) title.textContent = 'Нет избранного';
              if (text) text.textContent = 'Добавьте медиа в избранное, нажав на сердечко';
            } else {
              if (title) title.textContent = 'Галерея пуста';
              if (text) text.textContent = 'Загрузите медиа через админ-панель';
            }
          }
        }
      } else {
        this.media.push(...items);
        await this.fetchFavoriteStates(items);
        this.renderItems(items);
        this.page++;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Load error:', err);
        toast.show('Ошибка загрузки', 'error');
      }
    } finally {
      this.loading = false;
      if (spinner) spinner.classList.add('hidden');
    }
  },

  async fetchFavoriteStates(items) {
    if (this.isFavorites) {
      items.forEach(item => this.favoriteCache.set(item.id, true));
      return;
    }
    const ids = items.map(i => i.id);
    if (ids.length === 0) return;
    try {
      const result = await favorites.batchCheck(ids);
      for (const [id, isFav] of Object.entries(result)) {
        this.favoriteCache.set(parseInt(id, 10), isFav);
      }
    } catch (err) {
      console.error('Batch favorite check failed:', err);
    }
  },

  renderItems(items) {
    const grid = document.getElementById('mediaGrid');
    if (!grid) return;
    items.forEach((item, i) => {
      const card = this.createCard(item, this.media.length - items.length + i);
      grid.appendChild(card);
    });
  },

  createCard(item, index = 0) {
    const card = document.createElement('div');
    card.className = 'media-card skeleton';
    card.dataset.id = item.id;
    card.style.animationDelay = `${(index % 20) * 0.04}s`;
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${item.type} ${item.age_rating !== null ? item.age_rating + ' лет' : ''}`);

    const isVideo = item.type === 'video';
    const mediaEl = document.createElement('img');
    if (isVideo || !item.display_url) {
      // Videos always show the thumbnail (no full-res frame available);
      // items missing a display_url fall back to the thumbnail too.
      mediaEl.src = item.thumbnail_url || item.url;
    } else {
      // Photos: let the browser pick between thumb and display based on
      // viewport + DPR via srcset/sizes. One image load, no upgrade swap,
      // no flicker. Bandwidth-friendly on low-DPR (picks 400w thumb),
      // high-quality on high-DPR (picks 1920w display).
      const thumbUrl = item.thumbnail_url || item.display_url;
      mediaEl.src = item.display_url;
      mediaEl.srcset = `${thumbUrl} 400w, ${item.display_url} 1920w`;
      mediaEl.sizes = '(max-width: 600px) 50vw, (max-width: 1024px) 33vw, 20vw';
    }
    mediaEl.loading = 'lazy';
    mediaEl.decoding = 'async';
    mediaEl.alt = `${item.type} ${item.age_rating !== null ? item.age_rating + ' лет' : ''}`;
    mediaEl.addEventListener('load', () => card.classList.remove('skeleton'), { once: true });
    mediaEl.addEventListener('error', () => card.classList.remove('skeleton'), { once: true });
    card.appendChild(mediaEl);

    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    card.appendChild(overlay);

    if (item.age_rating !== null && item.age_rating !== undefined) {
      const age = document.createElement('span');
      age.className = 'card-age';
      age.textContent = item.age_rating >= 19 ? `${item.age_rating}+` : `${item.age_rating}`;
      card.appendChild(age);
    }

    const favBtn = document.createElement('button');
    favBtn.className = 'card-favorite';
    favBtn.setAttribute('aria-label', 'Добавить в избранное');
    favBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
      </svg>
    `;
    if (this.favoriteCache.get(item.id)) favBtn.classList.add('active');

    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (favBtn.classList.contains('active')) {
        await favorites.remove(item.id);
        favBtn.classList.remove('active');
        this.favoriteCache.set(item.id, false);
        if (this.isFavorites) {
          card.style.opacity = '0';
          card.style.transform = 'scale(0.9)';
          setTimeout(() => card.remove(), 300);
        }
      } else {
        await favorites.add(item.id);
        favBtn.classList.add('active');
        this.favoriteCache.set(item.id, true);
      }
    });
    card.appendChild(favBtn);

    if (isVideo) {
      const playBtn = document.createElement('button');
      playBtn.className = 'card-play';
      playBtn.setAttribute('aria-label', 'Воспроизвести видео');
      playBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `;
      card.appendChild(playBtn);
    }

    card.addEventListener('click', () => this.openModal(item.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openModal(item.id);
      }
    });

    return card;
  },

  setupModal() {
    const modal = document.getElementById('mediaModal');
    const closeBtn = document.getElementById('modalClose');
    const overlay = document.getElementById('modalOverlay');
    const prevBtn = document.getElementById('modalPrev');
    const nextBtn = document.getElementById('modalNext');
    const favoriteBtn = document.getElementById('modalFavorite');
    const editBtn = document.getElementById('modalEdit');
    const editPanel = document.getElementById('modalEditPanel');

    const close = () => this.closeModal();
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', close);

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.navigateModal(-1));
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.navigateModal(1));
    }

    this.setupIdleTimer(modal);
    if (editBtn && editPanel) {
      this.setupEditPanel(editBtn, editPanel);
    }

    if (favoriteBtn) {
      favoriteBtn.addEventListener('click', async () => {
        const currentId = this.currentModalId;
        if (!currentId) return;
        const isFav = favoriteBtn.classList.contains('active');
        if (isFav) {
          await favorites.remove(currentId);
          favoriteBtn.classList.remove('active');
          this.favoriteCache.set(currentId, false);
        } else {
          await favorites.add(currentId);
          favoriteBtn.classList.add('active');
          this.favoriteCache.set(currentId, true);
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!modal.classList.contains('active')) return;
      if (e.key === 'Escape') {
        const editPanel = document.getElementById('modalEditPanel');
        if (editPanel && !editPanel.hidden) {
          editPanel.hidden = true;
          return;
        }
        this.closeModal();
        return;
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') this.navigateModal(-1);
      if (e.key === 'ArrowRight') this.navigateModal(1);
    });

    let touchStartX = 0;
    let touchStartY = 0;
    let swipeArmed = false;
    modal.addEventListener('touchstart', (e) => {
      // When zoomed in, don't capture swipe for navigation - let image handle it
      if (this.zoom && this.zoom.scale > 1) return;
      // Multi-touch (pinch) must not be interpreted as swipe
      if (e.touches.length !== 1) { swipeArmed = false; return; }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      swipeArmed = true;
    }, { passive: true });
    modal.addEventListener('touchmove', (e) => {
      // If a second finger lands mid-swipe, disarm navigation
      if (e.touches.length !== 1) swipeArmed = false;
    }, { passive: true });
    modal.addEventListener('touchend', (e) => {
      // Skip navigation when zoomed in
      if (this.zoom && this.zoom.scale > 1) return;
      if (!swipeArmed) return;
      swipeArmed = false;
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const diffX = touchStartX - touchEndX;
      const diffY = touchStartY - touchEndY;
      // Only horizontal swipe (X movement greater than Y)
      if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
        if (diffX > 0) this.navigateModal(1);
        else this.navigateModal(-1);
      }
    }, { passive: true });

    document.addEventListener('mousemove', (e) => {
      const z = this.zoom;
      if (!z || !z.isDragging) return;
      const dx = e.clientX - z.dragStart.x;
      const dy = e.clientY - z.dragStart.y;
      if (!z.hasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        z.hasDragged = true;
      }
      z.x = z.dragImageStart.x + dx;
      z.y = z.dragImageStart.y + dy;
      z.el.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
    });

    document.addEventListener('mouseup', () => {
      const z = this.zoom;
      if (!z || !z.isDragging) return;
      z.isDragging = false;
      z.el.style.cursor = 'grab';
      z.el.style.transition = '';
    });

    document.addEventListener('touchmove', (e) => {
      const z = this.zoom;
      if (!z || !z.isDragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - z.dragStart.x;
      const dy = e.touches[0].clientY - z.dragStart.y;
      if (!z.hasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        z.hasDragged = true;
      }
      z.x = z.dragImageStart.x + dx;
      z.y = z.dragImageStart.y + dy;
      z.el.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
    }, { passive: true });

    document.addEventListener('touchend', () => {
      const z = this.zoom;
      if (!z || !z.isDragging) return;
      z.isDragging = false;
      z.el.style.transition = '';
    }, { passive: true });
  },

  setupIdleTimer(modal) {
    const wake = () => {
      if (!modal.classList.contains('active')) return;
      this.resetIdleTimer(modal);
    };
    modal.addEventListener('mousemove', wake);
    modal.addEventListener('mousedown', wake);
    modal.addEventListener('touchstart', wake, { passive: true });
    document.addEventListener('keydown', wake);
  },

  resetIdleTimer(modal) {
    modal.classList.remove('idle');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const editPanel = document.getElementById('modalEditPanel');
      if (editPanel && !editPanel.hidden) {
        this.resetIdleTimer(modal);
        return;
      }
      modal.classList.add('idle');
    }, 3000);
  },

  async setupEditPanel(editBtn, editPanel) {
    const closeBtn = document.getElementById('editPanelClose');
    const cancelBtn = document.getElementById('editCancel');
    const saveBtn = document.getElementById('editSave');
    const deleteBtn = document.getElementById('editDelete');
    const catSelect = document.getElementById('editCategory');
    const subSelect = document.getElementById('editSubcategory');
    const ageSelect = document.getElementById('editAge');

    editBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = this.media.find(m => m.id == this.currentModalId);
      if (!item) return;
      editPanel.hidden = false;
      this.resetIdleTimer(editPanel.closest('.modal'));

      try {
        const allCats = await categories.loadAll();
        catSelect.innerHTML = '<option value="">Без категории</option>' +
          allCats.map(c => `<option value="${c.id}" ${c.id === item.category_id ? 'selected' : ''}>${c.name}</option>`).join('');

        if (item.category_id) {
          const subs = await categories.loadSubcategories(item.category_id);
          subSelect.innerHTML = '<option value="">Без подкатегории</option>' +
            subs.map(s => `<option value="${s.id}" ${s.id === item.subcategory_id ? 'selected' : ''}>${s.name}</option>`).join('');
        } else {
          subSelect.innerHTML = '<option value="">Без подкатегории</option>';
        }

        ageSelect.value = item.age_rating !== null && item.age_rating !== undefined ? String(item.age_rating) : '';
        setTimeout(() => catSelect.focus(), 50);
      } catch (err) {
        console.error('Edit panel load error:', err);
        toast.show('Ошибка загрузки', 'error');
        editPanel.hidden = true;
      }
    });

    catSelect.addEventListener('change', async () => {
      subSelect.innerHTML = '<option value="">Без подкатегории</option>';
      if (catSelect.value) {
        try {
          const subs = await categories.loadSubcategories(catSelect.value);
          subSelect.innerHTML = '<option value="">Без подкатегории</option>' +
            subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        } catch (err) {
          console.error('Subcategory load error:', err);
        }
      }
    });

    const closePanel = () => { editPanel.hidden = true; };
    closeBtn.addEventListener('click', closePanel);
    cancelBtn.addEventListener('click', closePanel);

    editPanel.addEventListener('click', (e) => {
      if (e.target === editPanel) closePanel();
    });

    saveBtn.addEventListener('click', async () => {
      const id = this.currentModalId;
      if (!id) return;
      const updates = {
        category_id: catSelect.value || null,
        subcategory_id: subSelect.value || null,
        age_rating: ageSelect.value ? parseInt(ageSelect.value, 10) : null,
      };
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение...';
      try {
        await api.put('/api/media/batch-update', { ids: [id], ...updates });
        const item = this.media.find(m => m.id == id);
        if (item) {
          item.category_id = updates.category_id;
          item.subcategory_id = updates.subcategory_id;
          item.age_rating = updates.age_rating;
        }
        const modal = document.getElementById('mediaModal');
        const ageEl = document.getElementById('modalAge');
        if (ageEl) {
          ageEl.textContent = updates.age_rating !== null ? (updates.age_rating >= 19 ? `${updates.age_rating}+` : `${updates.age_rating}`) : '';
          ageEl.style.display = updates.age_rating !== null ? 'inline-block' : 'none';
        }
        toast.show('Сохранено', 'success');
        editPanel.hidden = true;
        this.resetIdleTimer(modal);
      } catch (err) {
        toast.show(err.message || 'Ошибка сохранения', 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить';
      }
    });

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = this.currentModalId;
        if (!id) return;
        const item = this.media.find(m => m.id == id);
        if (!item) return;

        const ok = await showConfirm(
          'Удалить это медиа? Файл будет удалён из S3 без возможности восстановления.',
          { okText: 'Удалить', icon: 'trash-2' }
        );
        if (!ok) return;

        deleteBtn.disabled = true;
        const originalHtml = deleteBtn.innerHTML;
        deleteBtn.innerHTML = 'Удаление...';
        try {
          await api.delete(`/api/media/${id}`);
          this.media = this.media.filter(m => m.id != id);
          const card = document.querySelector(`.media-card[data-id="${id}"]`);
          if (card) {
            card.style.transition = 'opacity 0.3s, transform 0.3s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.9)';
            setTimeout(() => card.remove(), 300);
          }
          editPanel.hidden = true;
          this.closeModal();
          toast.show('Медиа удалено', 'success');
        } catch (err) {
          toast.show(err.message || 'Ошибка удаления', 'error');
        } finally {
          deleteBtn.disabled = false;
          deleteBtn.innerHTML = originalHtml;
        }
      });
    }
  },

  currentModalId: null,

  openModal(id) {
    const modal = document.getElementById('mediaModal');
    const container = document.getElementById('modalMediaContainer');
    const ageEl = document.getElementById('modalAge');
    const favoriteBtn = document.getElementById('modalFavorite');

    this.scrollPosition = window.scrollY;

    const item = this.media.find(m => m.id == id);
    if (!item) return;

    this.currentModalId = id;
    container.innerHTML = '';

    const isVideo = item.type === 'video';
    const mediaEl = document.createElement(isVideo ? 'video' : 'img');
    const displaySrc = isVideo ? item.url : (item.display_url || item.url);
    mediaEl.src = displaySrc;
    mediaEl.controls = isVideo;
    mediaEl.className = 'modal-media';
    mediaEl.setAttribute('aria-label', isVideo ? 'Видео' : 'Изображение');
    mediaEl.alt = isVideo ? 'Видео' : `Изображение, возраст ${item.age_rating !== null ? item.age_rating + ' лет' : 'не указан'}`;

    if (isVideo) {
      mediaEl.autoplay = true;
    } else {
      const zoom = {
        el: mediaEl,
        scale: 1, x: 0, y: 0,
        isDragging: false,
        isPinching: false,
        hasDragged: false,
        dragStart: { x: 0, y: 0 },
        dragImageStart: { x: 0, y: 0 },
        pinchStartDist: 0,
        pinchStartScale: 1,
        pinchCenter: { x: 0, y: 0 },
        MAX_SCALE: 5,
      };

      const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const center2 = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
      const applyTransform = () => {
        zoom.el.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
      };
      const clampPan = () => {
        // Don't allow panning the image completely out of view
        const rect = zoom.el.getBoundingClientRect();
        const scaledW = rect.width * zoom.scale;
        const scaledH = rect.height * zoom.scale;
        const maxX = Math.max(0, (scaledW - rect.width) / 2);
        const maxY = Math.max(0, (scaledH - rect.height) / 2);
        zoom.x = Math.max(-maxX, Math.min(maxX, zoom.x));
        zoom.y = Math.max(-maxY, Math.min(maxY, zoom.y));
      };

      mediaEl.style.cursor = 'zoom-in';
      mediaEl.style.transition = 'transform 0.3s ease';

      mediaEl.addEventListener('mousedown', (e) => {
        zoom.hasDragged = false;
        if (zoom.scale === 1) return;
        zoom.isDragging = true;
        zoom.dragStart = { x: e.clientX, y: e.clientY };
        zoom.dragImageStart = { x: zoom.x, y: zoom.y };
        zoom.el.style.cursor = 'grabbing';
        zoom.el.style.transition = 'none';
        e.preventDefault();
      });

      mediaEl.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          // Start pinch
          zoom.isPinching = true;
          zoom.isDragging = false;
          zoom.pinchStartDist = dist2(e.touches[0], e.touches[1]);
          zoom.pinchStartScale = zoom.scale;
          zoom.pinchCenter = center2(e.touches[0], e.touches[1]);
          zoom.el.style.transition = 'none';
        } else if (e.touches.length === 1) {
          zoom.hasDragged = false;
          if (zoom.scale === 1) return;
          zoom.isDragging = true;
          zoom.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          zoom.dragImageStart = { x: zoom.x, y: zoom.y };
          zoom.el.style.transition = 'none';
        }
      }, { passive: true });

      mediaEl.addEventListener('touchmove', (e) => {
        if (!zoom.isPinching || e.touches.length !== 2) return;
        e.preventDefault();
        const newDist = dist2(e.touches[0], e.touches[1]);
        const newCenter = center2(e.touches[0], e.touches[1]);
        const ratio = newDist / zoom.pinchStartDist;
        const newScale = Math.max(1, Math.min(zoom.MAX_SCALE, zoom.pinchStartScale * ratio));

        // Keep pinch center stable: shift pan so the midpoint of the image stays under the fingers
        const scaleChange = newScale / zoom.scale;
        const cx = zoom.pinchCenter.x;
        const cy = zoom.pinchCenter.y;
        const rect = zoom.el.getBoundingClientRect();
        const cxRel = cx - (rect.left + rect.width / 2);
        const cyRel = cy - (rect.top + rect.height / 2);
        zoom.x = cxRel - (cxRel - zoom.x) * scaleChange + (newCenter.x - cx);
        zoom.y = cyRel - (cyRel - zoom.y) * scaleChange + (newCenter.y - cy);
        zoom.scale = newScale;
        zoom.pinchCenter = newCenter;

        if (zoom.scale <= 1.01) {
          zoom.scale = 1;
          zoom.x = 0;
          zoom.y = 0;
          zoom.el.style.cursor = 'zoom-in';
        } else {
          zoom.el.style.cursor = 'grab';
          clampPan();
        }
        applyTransform();
      }, { passive: false });

      const endTouches = (e) => {
        if (zoom.isPinching && e.touches.length < 2) {
          zoom.isPinching = false;
          zoom.el.style.transition = 'transform 0.3s ease';
          // If scale is ~1, snap back to identity for clean state
          if (zoom.scale < 1.05) {
            zoom.scale = 1;
            zoom.x = 0;
            zoom.y = 0;
            applyTransform();
          }
        }
        if (zoom.isDragging && e.touches.length === 0) {
          zoom.isDragging = false;
          zoom.el.style.transition = '';
        }
      };
      mediaEl.addEventListener('touchend', endTouches);
      mediaEl.addEventListener('touchcancel', endTouches);

      mediaEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (zoom.hasDragged || zoom.isPinching) return;
        if (zoom.scale === 1) {
          const rect = mediaEl.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          zoom.scale = 2;
          zoom.x = -(cx - rect.width / 2);
          zoom.y = -(cy - rect.height / 2);
          zoom.el.style.cursor = 'grab';
          zoom.el.style.transition = 'transform 0.3s ease';
          clampPan();
        } else {
          zoom.scale = 1;
          zoom.x = 0;
          zoom.y = 0;
          zoom.el.style.cursor = 'zoom-in';
          zoom.el.style.transition = 'transform 0.3s ease';
        }
        applyTransform();
      });

      this.zoom = zoom;
    }

    container.appendChild(mediaEl);

    ageEl.textContent = item.age_rating !== null ? (item.age_rating >= 19 ? `${item.age_rating}+` : `${item.age_rating}`) : '';
    ageEl.style.display = item.age_rating !== null ? 'inline-block' : 'none';

    if (this.favoriteCache.has(id)) {
      favoriteBtn.classList.toggle('active', this.favoriteCache.get(id));
    } else {
      favorites.check(id).then(isFav => {
        this.favoriteCache.set(id, isFav);
        favoriteBtn.classList.toggle('active', isFav);
      });
    }

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    this.resetIdleTimer(modal);
    this.setupFocusTrap(modal);
    const closeBtn = document.getElementById('modalClose');
    if (closeBtn) closeBtn.focus();
  },

  closeModal() {
    const modal = document.getElementById('mediaModal');
    const container = document.getElementById('modalMediaContainer');
    modal.classList.remove('active', 'idle');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    const editPanel = document.getElementById('modalEditPanel');
    if (editPanel) editPanel.hidden = true;

    if (container) {
      container.querySelectorAll('video').forEach(v => {
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
      container.innerHTML = '';
    }

    if (this.scrollPosition !== undefined) {
      window.scrollTo(0, this.scrollPosition);
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.currentModalId = null;
    this.zoom = null;
    this.removeFocusTrap();
  },

  setupFocusTrap(element) {
    const focusable = element.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    this.focusTrap = (e) => {
      if (e.key !== 'Tab') return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    element.addEventListener('keydown', this.focusTrap);
  },

  removeFocusTrap() {
    const modal = document.getElementById('mediaModal');
    if (this.focusTrap && modal) {
      modal.removeEventListener('keydown', this.focusTrap);
      this.focusTrap = null;
    }
  },

  async navigateModal(direction) {
    if (!this.currentModalId) return;
    const currentIndex = this.media.findIndex(m => m.id == this.currentModalId);
    const newIndex = currentIndex + direction;

    if (newIndex < 0) return;

    if (newIndex >= this.media.length) {
      if (this.hasMore && !this.loading) {
        await this.loadMore();
      }
      if (newIndex < this.media.length) {
        this.openModal(this.media[newIndex].id);
      }
    } else {
      this.openModal(this.media[newIndex].id);
    }
  },
};

gallery.init();
