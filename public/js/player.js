import { auth, api, toast, categories, favorites } from './main.js';

const gallery = {
  media: [],
  page: 1,
  loading: false,
  hasMore: true,
  filters: {},
  isFavorites: window.location.pathname === '/favorites',
  zoom: null,

  async init() {
    if (!auth.isAuthenticated()) return;

    this.setupFilters();
    this.setupInfiniteScroll();
    this.setupModal();
    await this.loadCategories();
    await this.loadMore();
  },

  setupFilters() {
    const categoryFilter = document.getElementById('categoryFilter');
    const subcategoryFilter = document.getElementById('subcategoryFilter');
    const ageFilter = document.getElementById('ageFilter');
    const sortFilter = document.getElementById('sortFilter');
    const applyBtn = document.getElementById('applyFilters');

    if (categoryFilter) {
      categoryFilter.addEventListener('change', async () => {
        const subs = await categories.loadSubcategories(categoryFilter.value);
        categories.populateSelect(subcategoryFilter, subs, 'Все подкатегории');
      });
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        this.filters = {
          category_id: categoryFilter?.value || '',
          subcategory_id: subcategoryFilter?.value || '',
          age: ageFilter?.value || '',
          sort: sortFilter?.value || 'newest',
        };
        this.page = 1;
        this.media = [];
        this.hasMore = true;
        document.getElementById('mediaGrid').innerHTML = '';
        this.loadMore();
      });
    }
  },

  async loadCategories() {
    const cats = await categories.loadAll();
    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
      categories.populateSelect(categoryFilter, cats, 'Все категории');
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
    }, { rootMargin: '200px' });

    observer.observe(sentinel);
  },

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    document.getElementById('loadingSpinner').style.display = 'flex';

    try {
      const endpoint = this.isFavorites ? '/api/favorites' : '/api/media';
      const params = new URLSearchParams({
        page: this.page,
        limit: 20,
        ...this.filters,
      });
      const response = await api.get(`${endpoint}?${params}`);

      const items = this.isFavorites ? response : response.media;

      if (items.length === 0) {
        this.hasMore = false;
        if (this.page === 1 && this.media.length === 0) {
          const grid = document.getElementById('mediaGrid');
          grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
              <div class="empty-state-icon">🖼️</div>
              <div class="empty-state-title">Галерея пуста</div>
              <div class="empty-state-text">Загрузите медиа через админ-панель</div>
            </div>
          `;
        }
      } else {
        this.media.push(...items);
        this.renderItems(items);
        this.page++;
      }
    } catch (err) {
      console.error('Load error:', err);
      toast.show('Ошибка загрузки', 'error');
    } finally {
      this.loading = false;
      document.getElementById('loadingSpinner').style.display = 'none';
    }
  },

  renderItems(items) {
    const grid = document.getElementById('mediaGrid');
    items.forEach((item, i) => {
      const card = this.createCard(item, this.media.length - items.length + i);
      grid.appendChild(card);
    });
  },

  createCard(item, index = 0) {
    const card = document.createElement('div');
    card.className = 'media-card';
    card.dataset.id = item.id;
    card.style.animationDelay = `${(index % 20) * 0.04}s`;

    const isVideo = item.type === 'video';
    const mediaEl = document.createElement('img');
    mediaEl.src = item.thumbnail_url || item.url;
    mediaEl.loading = 'lazy';
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
    favBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
      </svg>
    `;
    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (favBtn.classList.contains('active')) {
        await favorites.remove(item.id);
        favBtn.classList.remove('active');
        if (this.isFavorites) {
          card.style.opacity = '0';
          card.style.transform = 'scale(0.9)';
          setTimeout(() => card.remove(), 300);
        }
      } else {
        await favorites.add(item.id);
        favBtn.classList.add('active');
      }
    });
    card.appendChild(favBtn);

    favorites.check(item.id).then(isFav => {
      if (isFav) favBtn.classList.add('active');
    });

    if (isVideo) {
      const playBtn = document.createElement('button');
      playBtn.className = 'card-play';
      playBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `;
      card.appendChild(playBtn);
    }

    card.addEventListener('click', () => this.openModal(item.id));

    return card;
  },

  setupModal() {
    const modal = document.getElementById('mediaModal');
    const closeBtn = document.getElementById('modalClose');
    const prevBtn = document.getElementById('modalPrev');
    const nextBtn = document.getElementById('modalNext');
    const favoriteBtn = document.getElementById('modalFavorite');

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeModal());
    }

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
        } else {
          await favorites.add(currentId);
          favoriteBtn.classList.add('active');
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
    modal.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    });
    modal.addEventListener('touchend', (e) => {
      const touchEndX = e.changedTouches[0].clientX;
      const diff = touchStartX - touchEndX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) this.navigateModal(1);
        else this.navigateModal(-1);
      }
    });

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
    mediaEl.src = item.url || item.s3_url;
    mediaEl.controls = isVideo;
    mediaEl.style.width = '100%';
    mediaEl.style.height = '100%';
    mediaEl.style.objectFit = 'contain';
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

    favorites.check(id).then(isFav => {
      if (isFav) favoriteBtn.classList.add('active');
      else favoriteBtn.classList.remove('active');
    });

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  },

  closeModal() {
    const modal = document.getElementById('mediaModal');
    modal.classList.remove('active');
    document.body.style.overflow = '';

    if (this.scrollPosition !== undefined) {
      window.scrollTo(0, this.scrollPosition);
    }

    this.currentModalId = null;
    this.zoom = null;
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
