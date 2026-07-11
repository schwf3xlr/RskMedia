import { auth, api, toast, categories, favorites, events } from './main.js';

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

// Positive 31-bit int seed for the deterministic random shuffle. Matches
// the server-side cap (0x7fffffff) so we don't ship a value the backend
// will silently truncate. Random.random() * 2^31 covers the whole range.
function newRandomSeed() {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

// Custom multi-select dropdown backed by a checkbox list. Used instead of
// <select multiple> because the native control on mobile is awkward (opens a
// system-level picker that hides half the filter row) and doesn't compose
// well with our existing filter styling.
//
// Contract: attach to a <div class="multi-select" id="..." data-empty="…"
// data-label="…"></div>. Container becomes fully controlled by this class —
// contents get replaced. Use setOptions([{ id, name }]), setValue([ids]),
// getValue() → array of string ids. Only one panel opens at a time.
class MultiSelect {
  static _openInstance = null;
  static _globalListenerAttached = false;
  static _attachGlobalListener() {
    if (MultiSelect._globalListenerAttached) return;
    MultiSelect._globalListenerAttached = true;
    document.addEventListener('click', (e) => {
      const open = MultiSelect._openInstance;
      if (open && !open.container.contains(e.target)) open.close();
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
    // 'multi' (default): чекбоксы, панель остаётся открытой при клике,
    //                    getValue() → массив всех выбранных id.
    // 'single': радио-поведение, панель закрывается после клика,
    //           getValue() возвращает массив длины 0 или 1, getSingle()
    //           — строка или пустая строка. Всегда есть максимум одно
    //           выбранное значение.
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
    // Видимость управляется через класс .open на контейнере (см. CSS) —
    // атрибут hidden здесь не работал, потому что базовое правило панели
    // с более высокой специфичностью выставляло display: flex.
    this.container.appendChild(this.panel);
    this._updateLabel();
  }

  setOptions(options) {
    this.options = options.map(o => ({ id: String(o.id), name: String(o.name) }));
    this.panel.innerHTML = '';
    for (const opt of this.options) {
      if (this.mode === 'multi') {
        this.panel.appendChild(this._buildMultiOption(opt));
      } else {
        this.panel.appendChild(this._buildSingleOption(opt));
      }
    }
    // Purge from selected anything that no longer exists in options — otherwise
    // stale ids from a previous filter set would silently ride along in URLs.
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
    // В single-режиме роль элемента — role="option" (в multi это label с
    // input+checkbox). Клик выбирает и закрывает панель, как у нативного
    // <select>. Галочка — inline SVG (без зависимости от Lucide, потому
    // что элементы создаются динамически).
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
      this.panel.querySelectorAll('.multi-select-option').forEach(el => {
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
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    this.selected = new Set(list.map(String));
    if (this.mode === 'multi') {
      this.panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = this.selected.has(cb.value);
        cb.parentElement.classList.toggle('checked', cb.checked);
      });
    } else {
      // In single mode, options are div rows — sync their .checked class.
      this.panel.querySelectorAll('.multi-select-option').forEach((row, i) => {
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

  getValue() {
    return Array.from(this.selected);
  }

  // Convenience getter for single mode — returns the string or '' when
  // nothing is selected.
  getSingle() {
    return Array.from(this.selected)[0] || '';
  }

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

  open() {
    if (MultiSelect._openInstance && MultiSelect._openInstance !== this) {
      MultiSelect._openInstance.close();
    }
    this.container.classList.add('open');
    this.toggle.setAttribute('aria-expanded', 'true');
    MultiSelect._openInstance = this;
  }

  close() {
    this.container.classList.remove('open');
    this.toggle.setAttribute('aria-expanded', 'false');
    if (MultiSelect._openInstance === this) MultiSelect._openInstance = null;
  }
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
  currentModalId: null,
  // Tracks the modal's position in `this.media` rather than re-searching via
  // findIndex. Without this, if two entries in `this.media` happen to share
  // the same id (e.g. legacy data, or a future bug in pagination), navigateModal
  // would always pick the *first* match — pressing "next" while viewing the
  // first duplicate would open the second duplicate (visually identical),
  // and pressing "next" again would loop back to the first one, leaving the
  // user stuck on the same card while "back" still worked correctly (it lands
  // on the unique record before the duplicates).
  _currentModalIndex: -1,
  // Cached reference to the media object currently shown in the modal. The
  // edit panel and save/delete handlers previously did `this.media.find(m =>
  // m.id == currentModalId)`, which also returns the *first* match — for
  // duplicates that means admin actions (delete, save edits) could target
  // the wrong copy. Storing the actual object here removes the ambiguity.
  _currentModalItem: null,

  async init() {
    // Render skeleton placeholders synchronously so the first paint has
    // real geometry — otherwise the page is a blank white block for the
    // 200-800ms it takes categories + media to arrive.
    this.renderInitialSkeletons();
    // Categories + subcategories are independent — fetch in parallel.
    // Age + sort фильтры инициализируются синхронно из статических данных.
    this.initAgeFilter();
    this.initSortFilter();
    await Promise.all([this.loadCategories(), this.loadSubcategories()]);
    this.restoreFiltersFromURL();
    this.setupFilters();
    this.setupInfiniteScroll();
    this.setupModal();
    this.setupBackToTop();
    this.setupPullToRefresh();
    this.setupShortcutHelp();
    this.setupDensityPicker();
    await this.loadMore();
  },

  setupDensityPicker() {
    const picker = document.querySelector('.density-picker');
    if (!picker) return;
    const KEY = 'rskmedia-density';
    let stored;
    try { stored = localStorage.getItem(KEY); } catch {}
    const initial = ['comfortable', 'compact', 'dense'].includes(stored) ? stored : 'compact';
    const apply = (density) => {
      document.documentElement.setAttribute('data-density', density);
      picker.querySelectorAll('.density-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.density === density);
      });
    };
    apply(initial);
    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.density-btn');
      if (!btn) return;
      const density = btn.dataset.density;
      apply(density);
      try { localStorage.setItem(KEY, density); } catch {}
    });
  },

  renderInitialSkeletons() {
    const grid = document.getElementById('mediaGrid');
    if (!grid) return;
    const count = window.innerWidth < 600 ? 4 : 6;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'media-card skeleton skeleton-initial';
      el.style.animationDelay = `${i * 0.04}s`;
      grid.appendChild(el);
    }
    this._initialSkeletonCount = count;
  },

  clearInitialSkeletons() {
    if (!this._initialSkeletonCount) return;
    const grid = document.getElementById('mediaGrid');
    if (grid) grid.querySelectorAll('.skeleton-initial').forEach(el => el.remove());
    this._initialSkeletonCount = 0;
  },

  setupFilters() {
    const applyBtn = document.getElementById('applyFilters');
    const clearBtn = document.getElementById('clearFilters');
    // MultiSelect instances are created in loadCategories / loadSubcategories /
    // initAgeFilter / initSortFilter and stored on `this` so all filter
    // methods can hit them.
    const catMs = this._categoryMs;
    const subMs = this._subcategoryMs;
    const ageMs = this._ageMs;
    const sortMs = this._sortMs;

    // Restore checked-state from filters loaded from the URL (see
    // restoreFiltersFromURL). Splits comma-separated strings back into arrays.
    const csvToArray = (s) => (s ? String(s).split(',').filter(Boolean) : []);
    if (catMs) catMs.setValue(csvToArray(this.filters.category_id));
    if (subMs) subMs.setValue(csvToArray(this.filters.subcategory_id));
    if (ageMs) ageMs.setValue(csvToArray(this.filters.age));
    if (sortMs) sortMs.setValue([this.filters.sort || 'newest']);

    const apply = () => {
      const nextSort = sortMs?.getSingle() || 'newest';
      this.filters = {
        // Multi-value filters go over the wire as comma-separated ids —
        // the models parse each of these into IN(...) clauses.
        category_id: catMs ? catMs.getValue().join(',') : '',
        subcategory_id: subMs ? subMs.getValue().join(',') : '',
        age: ageMs ? ageMs.getValue().join(',') : '',
        sort: nextSort,
        // Seeded random shuffle. Without a seed the server rerandomizes on
        // every page fetch, so LIMIT/OFFSET pagination duplicates items
        // across pages and the modal loops back after ~1-2 pages of
        // swiping (visible especially on mobile where paging happens fast).
        // A fresh seed on every apply/clear gives the user a new order;
        // during pagination we keep the same seed so pages line up.
        ...(nextSort === 'random' ? { random_seed: newRandomSeed() } : {}),
      };
      this.updateURL();
      this.resetGrid();
      this.loadMore();
    };

    if (applyBtn) applyBtn.addEventListener('click', apply);

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        catMs?.clear();
        subMs?.clear();
        ageMs?.clear();
        // Sort всегда имеет ровно одно значение — сброс возвращает дефолт,
        // а не очищает (иначе тогглер показал бы "Сортировка" вместо
        // "Новые", что вводило бы в заблуждение).
        if (sortMs) sortMs.setValue(['newest']);
        this.filters = {};
        this.updateURL();
        this.resetGrid();
        this.loadMore();
      });
    }
  },

  restoreFiltersFromURL() {
    const params = new URLSearchParams(window.location.search);
    const sort = params.get('sort') || 'newest';
    this.filters = {
      category_id: params.get('category_id') || '',
      subcategory_id: params.get('subcategory_id') || '',
      age: params.get('age') || '',
      sort,
    };
    if (sort === 'random') {
      // Reuse the seed from the URL when present (sharing/reloading a link
      // reproduces the same shuffle). Otherwise mint a fresh one so the
      // very first page load isn't stuck on the raw non-seeded fallback.
      const urlSeed = Number(params.get('random_seed'));
      this.filters.random_seed = Number.isFinite(urlSeed) && urlSeed > 0
        ? String(urlSeed)
        : String(newRandomSeed());
    }
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
    // Modal must close before we wipe this.media — otherwise navigateModal /
    // edit / delete would run against a stale index and either open the wrong
    // item or throw on _currentModalItem = null. Guard so we don't touch DOM
    // if it's already inactive.
    const modal = document.getElementById('mediaModal');
    if (modal && modal.classList.contains('active')) {
      this.closeModal();
    }
    this.page = 1;
    this.media = [];
    this.hasMore = true;
    this.favoriteCache.clear();
    // Abort any in-flight loadMore so stale responses don't overwrite the new grid
    if (this.abortController) this.abortController.abort();
    const grid = document.getElementById('mediaGrid');
    if (grid) grid.innerHTML = '';
    // Show skeletons again for the new filter's first page so we don't
    // flash an empty grid while the request is in flight.
    this.renderInitialSkeletons();
  },

  async loadCategories() {
    const cats = await categories.loadAll();
    const el = document.getElementById('categoryFilter');
    if (!el) return;
    this._categoryMs ||= new MultiSelect(el);
    this._categoryMs.setOptions(cats.map(c => ({ id: c.id, name: c.name })));
  },

  async loadSubcategories() {
    // Пользователь: "подкатегории в каждой категории одинаковые" — поэтому
    // всегда грузим весь список подкатегорий (loadSubcategories(null) в
    // main.js уже дедуплицирует по имени и склеивает id через запятую).
    // Список НЕ пересобирается при смене категорий — user-friendly и
    // экономит round-trip.
    const subs = await categories.loadSubcategories();
    const el = document.getElementById('subcategoryFilter');
    if (!el) return;
    this._subcategoryMs ||= new MultiSelect(el);
    this._subcategoryMs.setOptions(subs.map(s => ({ id: s.id, name: s.name })));
  },

  initAgeFilter() {
    const el = document.getElementById('ageFilter');
    if (!el) return;
    this._ageMs ||= new MultiSelect(el);
    // AGE_RATINGS приходит из <meta name="app-config"> — общий источник
    // истины и для сервера, и для клиента (см. public/js/constants.js).
    const meta = document.querySelector('meta[name="app-config"]');
    let ages = [13, 14, 15, 16, 17, 18, 19];
    try {
      const cfg = meta ? JSON.parse(meta.content) : null;
      if (cfg?.ageRatings?.length) ages = cfg.ageRatings;
    } catch {}
    this._ageMs.setOptions(ages.map(a => ({ id: a, name: a >= 19 ? `${a}+` : String(a) })));
  },

  initSortFilter() {
    const el = document.getElementById('sortFilter');
    if (!el) return;
    // data-mode="single" в HTML переключает MultiSelect в радио-режим:
    // одно значение, панель закрывается после выбора, галочка вместо
    // чекбокса — как нативный <select>, но в стиль сайта.
    this._sortMs ||= new MultiSelect(el);
    // Список keys совпадает с SORT_MAP + TYPE_SORT_MAP в config/constants.js.
    // Порядок и подписи повторяют прежний <select>, чтобы UX не менялся.
    this._sortMs.setOptions([
      { id: 'newest',   name: 'Новые' },
      { id: 'oldest',   name: 'Старые' },
      { id: 'name',     name: 'По имени' },
      { id: 'photos',   name: 'Фото' },
      { id: 'videos',   name: 'Видео' },
      { id: 'random',   name: 'Случайно' },
      { id: 'age_desc', name: 'По возрасту ↓' },
      { id: 'age_asc',  name: 'По возрасту ↑' },
    ]);
    // Дефолт "Новые" — тогглер никогда не пустой, даже до restoreFiltersFromURL.
    this._sortMs.setValue(['newest']);
  },

  setupInfiniteScroll() {
    const sentinel = document.getElementById('sentinel');
    if (!sentinel) return;

    // Bigger rootMargin so we start the next request while the user still
    // has a screen of cards to look at — hides the network latency.
    this._infiniteObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !this.loading && this.hasMore) {
          this.loadMore();
        }
      });
    }, { rootMargin: '800px' });

    this._infiniteObserver.observe(sentinel);
  },

  // IntersectionObserver only fires when the target CROSSES the intersect
  // boundary — if a page of results is short enough that the sentinel
  // stayed in view after the load, no further callback ever fires and the
  // feed appears frozen until the user scrolls up a bit (which re-crosses
  // the boundary). This runs after every successful loadMore and, if the
  // sentinel is still in the trigger zone AND we haven't reached the end,
  // schedules another load. requestAnimationFrame lets layout settle
  // before we measure geometry.
  _maybeLoadMoreIfSentinelVisible() {
    if (!this.hasMore || this.loading) return;
    const sentinel = document.getElementById('sentinel');
    if (!sentinel) return;
    requestAnimationFrame(() => {
      if (this.loading || !this.hasMore) return;
      const rect = sentinel.getBoundingClientRect();
      // Match the observer's rootMargin so behavior is consistent.
      const TRIGGER = 800;
      const inTriggerZone = rect.top < window.innerHeight + TRIGGER;
      if (inTriggerZone) this.loadMore();
    });
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

      // First real payload arrived — drop skeleton placeholders regardless
      // of empty or populated response.
      if (this.page === 1) this.clearInitialSkeletons();
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
        // Defense-in-depth: filter out any ids we've already loaded before
        // pushing. The seeded shuffle on the server should prevent this,
        // but a race between a batch upload and pagination could still
        // shift item positions; without dedupe those items would appear
        // twice in the grid and trap the modal's index calculations.
        const seen = new Set(this.media.map(m => m.id));
        const fresh = items.filter(m => !seen.has(m.id));
        this.media.push(...fresh);
        await this.fetchFavoriteStates(fresh);
        // Hint the browser to start fetching the first few images in parallel
        // with layout work, before the <img> elements are even appended.
        // Without this, loading="lazy" defers fetches until the cards hit
        // the viewport, costing ~100-300ms on the first paint of the feed.
        if (this.page === 1) this.preloadAboveFoldImages(fresh);
        this.renderItems(fresh);
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
      // Cover the "sentinel never re-fires" case — see the doc comment
      // on _maybeLoadMoreIfSentinelVisible for the details.
      this._maybeLoadMoreIfSentinelVisible();
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

  // Hint the browser to start fetching the above-the-fold images in parallel
  // with HTML/CSS/layout work, so they're ready by the time the cards are
  // rendered. Only the first batch triggers preloads (later batches use the
  // browser's native lazy-load). Each preload is tagged with imagesrcset +
  // imagesizes so the browser picks the correct variant immediately instead
  // of re-resolving once the <img> element is parsed.
  preloadAboveFoldImages(items) {
    const PRELOAD_COUNT = 6;
    const head = document.head;
    const top = items.slice(0, PRELOAD_COUNT);
    for (const item of top) {
      const url = item.thumbnail_url || item.display_url || item.url;
      if (!url) continue;
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = url;
      if (item.display_url) {
        const stripQuery = (u) => u.split('?')[0];
        const thumbBase = stripQuery(item.thumbnail_url || item.display_url);
        const displayBase = stripQuery(item.display_url);
        link.setAttribute('imagesrcset', [
          `${thumbBase}?w=400 400w`,
          `${displayBase}?w=800 800w`,
          `${displayBase}?w=1200 1200w`,
          `${displayBase}?w=1920 1920w`,
        ].join(', '));
        link.setAttribute('imagesizes', '(max-width: 600px) 50vw, (max-width: 1024px) 33vw, 20vw');
      }
      head.appendChild(link);
    }
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
      // Photos: multi-step srcset + sizes so the browser picks the smallest
      // variant that still covers (viewport width x DPR). The proxy serves
      // /media/{type}/{id}?w=NNN with server-side sharp resize + per-variant
      // cache, so a 50vw card on a 1x display loads ~400w (~30 KB) instead
      // of the full 1920w display (~200 KB). High-DPR phones still get a
      // crisp 800-1200w variant via sizes x DPR.
      const stripQuery = (url) => url.split('?')[0];
      const thumbBase = stripQuery(item.thumbnail_url || item.display_url);
      const displayBase = stripQuery(item.display_url);
      mediaEl.src = `${displayBase}?w=1200`;
      mediaEl.srcset = [
        `${thumbBase}?w=400 400w`,
        `${displayBase}?w=800 800w`,
        `${displayBase}?w=1200 1200w`,
        `${displayBase}?w=1920 1920w`,
      ].join(', ');
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

      // Animated preview on hover. Only wire it up if the server actually
      // produced one (older uploads and codec-incompatible clips have no
      // preview_url — they stay on the static thumbnail without penalty).
      // Debounce with a small delay so a mouse crossing the grid doesn't
      // trigger dozens of network requests.
      if (item.preview_url && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        let previewImg = null;
        let hoverTimer = null;
        const enter = () => {
          hoverTimer = setTimeout(() => {
            if (previewImg) return;
            previewImg = document.createElement('img');
            previewImg.src = item.preview_url;
            previewImg.className = 'card-preview';
            previewImg.alt = '';
            previewImg.decoding = 'async';
            previewImg.style.opacity = '0';
            previewImg.addEventListener('load', () => {
              // Only fade in if we're still hovered (cheap check via parent)
              if (previewImg && previewImg.parentNode === card) previewImg.style.opacity = '1';
            }, { once: true });
            card.appendChild(previewImg);
          }, 200);
        };
        const leave = () => {
          clearTimeout(hoverTimer);
          if (previewImg) {
            previewImg.remove();
            previewImg = null;
          }
        };
        card.addEventListener('pointerenter', enter);
        card.addEventListener('pointerleave', leave);
      }
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

      // Navigation
      if (e.key === 'ArrowLeft') { this.navigateModal(-1); return; }
      if (e.key === 'ArrowRight') { this.navigateModal(1); return; }

      // Ignore combos so browser shortcuts like Cmd+F still work.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // Favorite (F)
      if (key === 'f' || key === 'а') {
        const favBtn = document.getElementById('modalFavorite');
        if (favBtn) { favBtn.click(); e.preventDefault(); }
        return;
      }

      // Admin: open edit panel (E)
      if (key === 'e' || key === 'у') {
        const editBtn = document.getElementById('modalEdit');
        if (editBtn) { editBtn.click(); e.preventDefault(); }
        return;
      }

      // Admin: delete (Delete key) — click through the edit panel's delete
      if (e.key === 'Delete') {
        const editPanel = document.getElementById('modalEditPanel');
        const deleteBtn = document.getElementById('editDelete');
        if (deleteBtn) {
          if (editPanel && editPanel.hidden) editPanel.hidden = false;
          deleteBtn.click();
          e.preventDefault();
        }
        return;
      }

      // Zoom controls (+ / - / 0). Only meaningful for images with active zoom.
      if (this.zoom) {
        if (e.key === '+' || e.key === '=') { this._nudgeZoom(1.25); e.preventDefault(); return; }
        if (e.key === '-' || e.key === '_') { this._nudgeZoom(0.8); e.preventDefault(); return; }
        if (e.key === '0') { this._resetZoom(); e.preventDefault(); return; }
      }

      // Shortcut help
      if (e.key === '?' || (e.shiftKey && key === '/')) {
        this.showShortcutHelp();
        e.preventDefault();
      }
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
      // Use the cached item reference rather than re-searching by id — see
      // _currentModalItem. For duplicates in this.media, find() returns the
      // first match, which may not be the record actually shown in the modal.
      const item = this._currentModalItem;
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
      const item = this._currentModalItem;
      if (!item) return;
      const id = item.id;
      const updates = {
        category_id: catSelect.value || null,
        subcategory_id: subSelect.value || null,
        age_rating: ageSelect.value ? parseInt(ageSelect.value, 10) : null,
      };
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение...';
      try {
        await api.put('/api/media/batch-update', { ids: [id], ...updates });
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
        const item = this._currentModalItem;
        if (!item) return;
        const id = item.id;

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

  openModal(id) {
    const modal = document.getElementById('mediaModal');
    const container = document.getElementById('modalMediaContainer');
    const ageEl = document.getElementById('modalAge');
    const favoriteBtn = document.getElementById('modalFavorite');

    // Only capture the underlying scroll position on the FIRST open. If
    // we re-captured every time, navigating prev/next in the modal (which
    // also calls openModal) would overwrite the saved position with
    // window.scrollY from inside the modal - on iOS Safari that resets
    // to 0 when body.overflow=hidden kicks in, so closing the modal
    // would jump the page back to the top instead of restoring the
    // scroll position the user was at when they clicked the card.
    if (this.scrollPosition === undefined || this.scrollPosition === null) {
      this.scrollPosition = window.scrollY;
    }

    const item = this.media.find(m => m.id == id);
    if (!item) return;

    this.currentModalId = id;
    this._currentModalIndex = this.media.indexOf(item);
    this._currentModalItem = item;
    // Before we rip the old media out of the DOM, pause any playing video
    // so audio doesn't briefly leak between prev/next transitions on slow
    // devices where the innerHTML="" removal is async-ish.
    container.querySelectorAll('video').forEach(v => { try { v.pause(); } catch {} });
    container.innerHTML = '';

    const isVideo = item.type === 'video';

    // Wrapper div holds the blur-up background, spinner, and media element.
    // For videos, no blur-up is needed (the browser shows its own loading UI).
    const wrapper = document.createElement('div');
    wrapper.className = 'modal-media-wrapper';
    if (!isVideo) {
      // Use display_url (the high-res version) with w=64 - sharp will
      // downsample a large JPEG to 64px, producing a tiny ~1-2KB image
      // that looks great when CSS-blurred. Using the thumbnail itself
      // would upscale/pixelate.
      const blurSrc = (item.display_url || item.url || '').split('?')[0];
      if (blurSrc) {
        const blur = document.createElement('div');
        blur.className = 'modal-media-blur';
        blur.style.backgroundImage = `url("${blurSrc}?w=64")`;
        // If the blur request fails (network, 404), don't leave an empty
        // placeholder - the .modal-media-blur element just stays invisible.
        blur.addEventListener('error', () => { blur.remove(); }, { once: true });
        wrapper.appendChild(blur);
      }

      const spinner = document.createElement('div');
      spinner.className = 'modal-media-spinner';
      spinner.innerHTML = '<div class="spinner"></div>';
      wrapper.appendChild(spinner);
    }

    const mediaEl = document.createElement(isVideo ? 'video' : 'img');
    const displaySrc = isVideo ? item.url : (item.display_url || item.url);
    mediaEl.src = displaySrc;
    mediaEl.controls = isVideo;
    mediaEl.className = 'modal-media';
    if (!isVideo) {
      // Image starts hidden until decoded/loaded, then fades in over the blur.
      mediaEl.classList.add('modal-media-loading');
    }
    mediaEl.setAttribute('aria-label', isVideo ? 'Видео' : 'Изображение');
    mediaEl.alt = isVideo ? 'Видео' : `Изображение, возраст ${item.age_rating !== null ? item.age_rating + ' лет' : 'не указан'}`;

    if (!isVideo) {
      const revealImage = () => {
        mediaEl.classList.remove('modal-media-loading');
        mediaEl.classList.add('modal-media-ready');
        // Put .modal-media-ready on the WRAPPER too so the spinner and
        // blur fade out simultaneously with the image fade-in (CSS
        // selectors target .modal-media-wrapper.modal-media-ready .*).
        wrapper.classList.add('modal-media-ready');
        // Tear down the spinner/blur DOM nodes after the CSS transitions
        // finish (350ms matches .modal-media-ready's transition). Keeping
        // them around longer would just waste layout work.
        setTimeout(() => {
          const b = wrapper.querySelector('.modal-media-blur');
          const s = wrapper.querySelector('.modal-media-spinner');
          if (b) b.remove();
          if (s) s.remove();
        }, 350);
      };
      mediaEl.addEventListener('load', revealImage, { once: true });
      // If the image fails to load (404, network error), reveal the blur
      // background so the user at least sees *something* instead of a
      // permanently empty modal. Strip the spinner immediately so the
      // user doesn't think we're still trying.
      mediaEl.addEventListener('error', () => {
        mediaEl.classList.remove('modal-media-loading');
        mediaEl.classList.add('modal-media-ready');
        wrapper.classList.add('modal-media-ready');
        const spinner = wrapper.querySelector('.modal-media-spinner');
        if (spinner) spinner.remove();
      }, { once: true });
    }

    if (isVideo) {
      mediaEl.autoplay = true;
      // playsInline stops iOS from booting into its own full-window
      // player automatically; the native <video controls> fullscreen
      // button handles it on demand.
      mediaEl.playsInline = true;
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

      // Swipe-down to close the modal (mobile-only gesture). Tracks
      // vertical drag on the image element. Only triggers when the image
      // is not zoomed and not currently being pinched - otherwise the
      // existing pinch/pan logic owns the gesture.
      const swipe = {
        startY: 0,
        startX: 0,
        active: false,
        // True once the gesture is committed to a downward swipe (vertical
        // motion exceeded the slant threshold). Used to decide whether to
        // snap back vs. animate the wrapper down with the finger.
        committed: false,
        dy: 0,
        // If we translate the wrapper, we want a smooth transition back to
        // 0 when the user releases below the threshold. We capture the
        // current transition state so we can disable it during the drag
        // and restore it on release.
        originalTransition: '',
      };
      const SWIPE_THRESHOLD = 100;
      const SWIPE_SLANT = 1.5; // |dy/dx| must exceed this to count as vertical

      const applySwipeTransform = (px) => {
        // Dim the modal slightly as the user pulls down, mirroring iOS.
        const opacity = Math.max(0, 1 - px / 400);
        wrapper.style.transform = `translateY(${px}px)`;
        wrapper.style.opacity = opacity;
        wrapper.style.transition = 'none';
      };
      const resetSwipeTransform = () => {
        // Restore identity, then clear the inline transition so future
        // stylesheets can take over (the snap-back animation is set
        // BEFORE calling this).
        wrapper.style.transform = '';
        wrapper.style.opacity = '';
      };

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
          // Cancel any in-progress swipe-down: user is pinching now.
          swipe.active = false;
          swipe.committed = false;
        } else if (e.touches.length === 1) {
          zoom.hasDragged = false;
          if (zoom.scale === 1) {
            // Potentially a swipe-down to close. We don't commit until the
            // finger moves far enough vertically to be unambiguous.
            swipe.startY = e.touches[0].clientY;
            swipe.startX = e.touches[0].clientX;
            swipe.active = true;
            swipe.committed = false;
            swipe.dy = 0;
            swipe.originalTransition = mediaEl.style.transition;
            return;
          }
          // Zoomed in: pan the image
          swipe.active = false;
          swipe.committed = false;
          zoom.isDragging = true;
          zoom.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          zoom.dragImageStart = { x: zoom.x, y: zoom.y };
          zoom.el.style.transition = 'none';
        }
      }, { passive: true });

      mediaEl.addEventListener('touchmove', (e) => {
        if (zoom.isPinching && e.touches.length === 2) {
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
          return;
        }

        // Swipe-down to close (single finger, unzoomed). Only commits if
        // the user has moved enough downward AND the motion is dominantly
        // vertical (so a casual horizontal drag doesn't trigger it).
        if (swipe.active && e.touches.length === 1 && zoom.scale === 1) {
          const touch = e.touches[0];
          const dy = touch.clientY - swipe.startY;
          const dx = Math.abs(touch.clientX - swipe.startX);
          if (!swipe.committed && dy > 10 && (dx === 0 || Math.abs(dy) / dx > SWIPE_SLANT)) {
            swipe.committed = true;
          }
          if (swipe.committed && dy > 0) {
            e.preventDefault();
            // Resistive pull so the wrapper feels rubbery past the threshold.
            applySwipeTransform(dy * 0.6);
            swipe.dy = dy * 0.6;
          }
        }
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
        // Swipe-down: commit or snap back.
        if (swipe.active && swipe.committed && e.touches.length === 0) {
          if (swipe.dy >= SWIPE_THRESHOLD * 0.6) {
            // Past threshold: animate the wrapper off-screen, then close.
            const finalY = window.innerHeight;
            wrapper.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
            wrapper.style.transform = `translateY(${finalY}px)`;
            wrapper.style.opacity = '0';
            setTimeout(() => this.closeModal(), 220);
          } else {
            // Below threshold: snap back to identity.
            wrapper.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
            resetSwipeTransform();
          }
          swipe.active = false;
          swipe.committed = false;
          swipe.dy = 0;
        }
        // Always reset swipe state when the last finger lifts, even if not
        // committed (e.g. user tapped without moving).
        if (e.touches.length === 0) {
          swipe.active = false;
          swipe.committed = false;
        }
      };
      mediaEl.addEventListener('touchend', endTouches);
      mediaEl.addEventListener('touchcancel', endTouches);

      mediaEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (zoom.hasDragged || zoom.isPinching || swipe.committed) return;
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

    wrapper.appendChild(mediaEl);
    container.appendChild(wrapper);

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
    document.body.classList.add('modal-open');
    this.resetIdleTimer(modal);
    this.setupFocusTrap(modal);
    const closeBtn = document.getElementById('modalClose');
    if (closeBtn) closeBtn.focus();

    // Warm the browser cache for the previous and next items so pressing
    // ← / → feels instant. Uses <link rel="prefetch"> which the browser
    // schedules at a lower priority — it doesn't fight the current display
    // image download.
    this.prefetchModalNeighbors();
  },

  prefetchModalNeighbors() {
    if (this._currentModalIndex < 0) return;
    const neighbors = [
      this.media[this._currentModalIndex - 1],
      this.media[this._currentModalIndex + 1],
    ].filter(Boolean);
    // Clean up prior prefetch links so head doesn't accumulate on rapid
    // navigation.
    document.querySelectorAll('link[data-modal-prefetch]').forEach(n => n.remove());
    for (const item of neighbors) {
      if (!item) continue;
      const url = item.type === 'video'
        ? (item.thumbnail_url || item.url)
        : (item.display_url || item.url);
      if (!url) continue;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      // as=image lets the browser prioritize decode when the neighbor is
      // eventually shown.
      link.as = 'image';
      link.href = url;
      link.setAttribute('data-modal-prefetch', '1');
      document.head.appendChild(link);
    }
  },

  closeModal() {
    const modal = document.getElementById('mediaModal');
    const container = document.getElementById('modalMediaContainer');
    modal.classList.remove('active', 'idle');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');

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
      // Clear so the next openModal call captures a fresh position
      // (otherwise re-opening without navigating would skip the capture).
      this.scrollPosition = null;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.currentModalId = null;
    this._currentModalIndex = -1;
    this._currentModalItem = null;
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

  // Floating "back to top" button. Hidden until the user has scrolled past
  // ~600px, then fades in. Uses scroll listener with requestAnimationFrame
  // throttling so it doesn't fire on every scroll event.
  setupBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    const THRESHOLD = 600;
    let ticking = false;

    const update = () => {
      btn.classList.toggle('visible', window.scrollY > THRESHOLD);
      ticking = false;
    };

    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    }, { passive: true });

    btn.addEventListener('click', () => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    });

    // Re-render lucide icon now that the button is in the DOM
    if (window.lucide) window.lucide.createIcons();
  },

  // Pull-to-refresh for touch devices. Only triggers when the page is
  // already scrolled to the top - otherwise we'd interfere with normal
  // scrolling. The visual indicator grows in height as the user pulls
  // down; releasing past the threshold reloads the page.
  setupPullToRefresh() {
    const indicator = document.getElementById('pullToRefresh');
    if (!indicator) return;

    // Skip on desktop browsers (they don't fire touch events).
    if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;

    // Respect the CSS: if the indicator is display:none (mobile stylesheet
    // opts out of pull-to-refresh), don't attach the touchmove hijack
    // either — otherwise the user's pull gesture still triggers a
    // location.reload() with no visual feedback.
    if (getComputedStyle(indicator).display === 'none') return;

    const THRESHOLD = 80;
    const MAX_PULL = 140;
    let startY = 0;
    let active = false;
    let pulling = false;

    const setHeight = (px) => {
      indicator.style.height = `${Math.min(px, MAX_PULL)}px`;
    };

    document.addEventListener('touchstart', (e) => {
      if (window.scrollY > 0) return;
      // Only single-finger gestures - pinch-zoom should still work.
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      active = true;
      pulling = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!active) return;
      if (window.scrollY > 0) {
        active = false;
        setHeight(0);
        return;
      }
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        setHeight(0);
        pulling = false;
        return;
      }
      // Only intercept scrolling once we're committed to a pull.
      if (dy > 10) {
        pulling = true;
        // Resist further than MAX_PULL so the indicator feels rubbery.
        setHeight(dy * 0.5);
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!active) return;
      const currentHeight = parseInt(indicator.style.height, 10) || 0;
      active = false;
      pulling = false;
      if (currentHeight >= THRESHOLD) {
        indicator.classList.add('refreshing');
        setHeight(60);
        // Small delay so the user sees the spinner before the page
        // navigation interrupts the JS event loop.
        setTimeout(() => window.location.reload(), 300);
      } else {
        setHeight(0);
      }
    });
  },

  _nudgeZoom(factor) {
    const z = this.zoom;
    if (!z) return;
    const next = Math.max(1, Math.min(z.MAX_SCALE, z.scale * factor));
    if (next === z.scale) return;
    z.scale = next;
    if (z.scale <= 1.01) {
      z.scale = 1; z.x = 0; z.y = 0;
      z.el.style.cursor = 'zoom-in';
    } else {
      z.el.style.cursor = 'grab';
    }
    z.el.style.transition = 'transform 0.2s ease';
    z.el.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
  },

  _resetZoom() {
    const z = this.zoom;
    if (!z) return;
    z.scale = 1; z.x = 0; z.y = 0;
    z.el.style.cursor = 'zoom-in';
    z.el.style.transition = 'transform 0.2s ease';
    z.el.style.transform = 'translate(0px, 0px) scale(1)';
  },

  setupShortcutHelp() {
    const btn = document.getElementById('shortcutHelpBtn');
    if (btn) btn.addEventListener('click', () => this.showShortcutHelp());
  },

  showShortcutHelp() {
    if (document.getElementById('shortcutHelpOverlay')) return;
    const isAdmin = document.querySelector('meta[name="user-type"]')?.content === 'admin';
    const overlay = document.createElement('div');
    overlay.id = 'shortcutHelpOverlay';
    overlay.className = 'confirm-overlay';
    const rows = [
      ['←', 'Предыдущее медиа'],
      ['→', 'Следующее медиа'],
      ['Esc', 'Закрыть модалку'],
      ['F', 'Избранное'],
      ['+ / −', 'Увеличить / Уменьшить'],
      ['0', 'Сбросить зум'],
      ['?', 'Эта справка'],
    ];
    if (isAdmin) {
      rows.push(['E', 'Открыть редактирование']);
      rows.push(['Delete', 'Удалить медиа']);
    }
    const modal = document.createElement('div');
    modal.className = 'confirm-modal shortcut-help-modal';
    const heading = document.createElement('h3');
    heading.textContent = 'Клавиатурные шорткаты';
    heading.className = 'shortcut-help-title';
    modal.appendChild(heading);
    const list = document.createElement('dl');
    list.className = 'shortcut-help-list';
    for (const [key, desc] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = desc;
      list.append(dt, dd);
    }
    modal.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary btn-sm';
    closeBtn.textContent = 'Закрыть';
    actions.appendChild(closeBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    const dismiss = () => overlay.remove();
    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    const onKey = (e) => {
      if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  },

  async navigateModal(direction) {
    if (!this.currentModalId) return;
    // Use the cached index from openModal instead of findIndex. findIndex
    // returns the first match for an id, so duplicates (same id in two slots)
    // would trap the user on a phantom "next" press — see _currentModalIndex.
    let currentIndex = this._currentModalIndex;
    // Guard: if this.media was mutated behind the modal's back (filter reset,
    // batch delete elsewhere), the cached index may point to a different or
    // now-missing item. Re-resolve via id and warn.
    if (
      currentIndex < 0 ||
      currentIndex >= this.media.length ||
      !this._currentModalItem ||
      this.media[currentIndex] !== this._currentModalItem
    ) {
      const recovered = this.media.findIndex(m => m.id == this.currentModalId);
      if (recovered < 0) {
        console.warn('navigateModal: current item no longer in this.media, closing');
        this.closeModal();
        return;
      }
      console.warn('navigateModal: modal index desynced, recovering via findIndex');
      currentIndex = recovered;
      this._currentModalIndex = recovered;
      this._currentModalItem = this.media[recovered];
    }
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

// Realtime gallery refresh via SSE. When an admin uploads/deletes elsewhere,
// this quietly refreshes the current view instead of asking the user to
// F5. Debounced with a small window so a batch upload of 100 files doesn't
// trigger 100 refetches.
{
  let refreshTimer = null;
  const schedule = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Reset to page 1 and re-fetch. Only when the gallery is idle to
      // avoid trampling an in-flight infinite-scroll load.
      if (gallery.loading) { schedule(); return; }
      gallery.media = [];
      gallery.page = 1;
      gallery.hasMore = true;
      const grid = document.getElementById('mediaGrid');
      if (grid) grid.innerHTML = '';
      gallery.loadMore();
    }, 800);
  };
  events.on('media.created', schedule);
  events.on('media.deleted', schedule);
  events.on('media.updated', schedule);
}
