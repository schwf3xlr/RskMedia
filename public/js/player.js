import { auth, api, toast, categories, favorites } from './main.js';

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

  async init() {
    await this.loadCategories();
    await this.loadSubcategories();
    this.restoreFiltersFromURL();
    this.setupFilters();
    this.setupInfiniteScroll();
    this.setupModal();
    this.setupImageObserver();
    await this.loadMore();
  },

  setupImageObserver() {
    this.imageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const card = entry.target;
        const mediaEl = card.querySelector('img');
        const fullSrc = card.dataset.fullSrc;
        if (fullSrc && mediaEl && mediaEl.dataset.src !== fullSrc) {
          mediaEl.dataset.src = fullSrc;
          const upgrade = new Image();
          upgrade.onload = () => {
            mediaEl.src = fullSrc;
            card.classList.remove('skeleton');
          };
          upgrade.onerror = () => {
            card.classList.remove('skeleton');
          };
          upgrade.src = fullSrc;
          this.imageObserver.unobserve(card);
        }
      });
    }, { rootMargin: '200px' });
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
      const response = await api.get(`${endpoint}?${params}`);

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
      console.error('Load error:', err);
      toast.show('Ошибка загрузки', 'error');
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
    const thumbSrc = item.thumbnail_url || item.url;
    // For photos, upgrade to display_url when in viewport; for videos, keep thumbnail
    const fullSrc = isVideo ? null : (item.display_url || item.url);
    if (fullSrc) card.dataset.fullSrc = fullSrc;

    const mediaEl = document.createElement('img');
    mediaEl.src = thumbSrc;
    mediaEl.loading = 'lazy';
    mediaEl.decoding = 'async';
    mediaEl.alt = `${item.type} ${item.age_rating !== null ? item.age_rating + ' лет' : ''}`;
    mediaEl.addEventListener('load', () => card.classList.remove('skeleton'), { once: true });
    mediaEl.addEventListener('error', () => card.classList.remove('skeleton'), { once: true });
    card.appendChild(mediaEl);

    if (fullSrc && this.imageObserver) {
      this.imageObserver.observe(card);
    } else {
      card.classList.remove('skeleton');
    }

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

    const close = () => this.closeModal();
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', close);

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.navigateModal(-1));
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.navigateModal(1));
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
      if (e.key === 'Escape') this.closeModal();
      if (e.key === 'ArrowLeft') this.navigateModal(-1);
      if (e.key === 'ArrowRight') this.navigateModal(1);
    });

    let touchStartX = 0;
    let touchStartY = 0;
    modal.addEventListener('touchstart', (e) => {
      // When zoomed in, don't capture swipe for navigation - let image handle it
      if (this.zoom && this.zoom.scale > 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    modal.addEventListener('touchend', (e) => {
      // Skip navigation when zoomed in
      if (this.zoom && this.zoom.scale > 1) return;
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
    mediaEl.dataset.fullSrc = item.url;
    mediaEl.dataset.displaySrc = item.display_url || item.url;
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
        hasDragged: false,
        dragStart: { x: 0, y: 0 },
        dragImageStart: { x: 0, y: 0 },
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
        if (e.touches.length !== 1) return;
        zoom.hasDragged = false;
        if (zoom.scale === 1) return;
        zoom.isDragging = true;
        zoom.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        zoom.dragImageStart = { x: zoom.x, y: zoom.y };
        zoom.el.style.transition = 'none';
      }, { passive: true });

      mediaEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (zoom.hasDragged) return;
        if (zoom.scale === 1) {
          const rect = mediaEl.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          zoom.scale = 2;
          zoom.x = -(cx - rect.width / 2);
          zoom.y = -(cy - rect.height / 2);
          zoom.el.style.cursor = 'grab';
          zoom.el.style.transition = 'transform 0.3s ease';
        } else {
          zoom.scale = 1;
          zoom.x = 0;
          zoom.y = 0;
          zoom.el.style.cursor = 'zoom-in';
          zoom.el.style.transition = 'transform 0.3s ease';
        }
        zoom.el.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
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
    this.setupFocusTrap(modal);
    const closeBtn = document.getElementById('modalClose');
    if (closeBtn) closeBtn.focus();
  },

  closeModal() {
    const modal = document.getElementById('mediaModal');
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    if (this.scrollPosition !== undefined) {
      window.scrollTo(0, this.scrollPosition);
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
