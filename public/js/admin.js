import { auth, api, toast, categories } from './main.js';
import { AGE_RATINGS } from './constants.js';

// Server-side middleware already ensures admin access for /admin route.
// If this script somehow runs without admin rights, backend calls will fail with 403.

const state = {
  adminMissingFilters: [],
  currentMediaPage: 1,
  allAdminCategories: [],
  adminLoading: false,
  adminHasMore: true,
  adminObserver: null,
  allSelected: false,
};

const tabs = document.querySelectorAll('.admin-tab');
const panels = document.querySelectorAll('.admin-panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${target}Panel`).classList.add('active');

    if (target === 'batch') {
      resetBatchGrid();
      loadMediaCards(1, false).then(() => setupAdminInfiniteScroll());
    }
    if (target === 'tokens') loadTokens();
    if (target === 'categories') loadCategoriesPanel();
    if (target === 'stats') loadStats();
  });
});

function resetBatchGrid() {
  state.adminHasMore = true;
  state.adminLoading = false;
  state.currentMediaPage = 1;
  state.allSelected = false;
  const selectAllBtn = document.getElementById('selectAllBtn');
  if (selectAllBtn) {
    selectAllBtn.innerHTML = '<i data-lucide="check-square" class="icon-sm"></i> Выбрать всё';
  }
  updateSelectedCount();
}

document.querySelectorAll('.admin-missing-filter').forEach(cb => {
  cb.addEventListener('change', () => {
    state.adminMissingFilters = Array.from(document.querySelectorAll('.admin-missing-filter:checked'))
      .map(c => c.dataset.field);
    resetBatchGrid();
    const grid = document.getElementById('mediaCards');
    if (grid) grid.innerHTML = '';
    if (state.adminObserver) state.adminObserver.disconnect();
    loadMediaCards(1, false).then(() => setupAdminInfiniteScroll());
  });
});

async function loadAdminCategories() {
  const cats = await categories.loadAll();
  state.allAdminCategories = cats;
  const selects = ['singleCategory', 'batchCategory', 'batchSetCategory', 'newSubcategoryCategory'];
  selects.forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      const emptyLabel = id === 'batchSetCategory' ? 'Установить категорию' : id === 'newSubcategoryCategory' ? 'Выберите категорию' : 'Без категории';
      categories.populateSelect(select, cats, emptyLabel);
    }
  });
}

const batchSetCategory = document.getElementById('batchSetCategory');
if (batchSetCategory) {
  batchSetCategory.addEventListener('change', async () => {
    const subSelect = document.getElementById('batchSetSubcategory');
    if (subSelect) {
      const subs = await categories.loadSubcategories(batchSetCategory.value);
      categories.populateSelect(subSelect, subs, 'Установить подкатегорию');
    }
  });
}

['singleCategory', 'batchCategory'].forEach(id => {
  const select = document.getElementById(id);
  if (select) {
    select.addEventListener('change', async () => {
      const subId = id.replace('Category', 'Subcategory');
      const subSelect = document.getElementById(subId);
      if (subSelect) {
        const subs = await categories.loadSubcategories(select.value);
        categories.populateSelect(subSelect, subs, 'Без подкатегории');
      }
    });
  }
});

loadAdminCategories();

// Drag and drop
function setupDropZone(dropZoneId, fileInputId) {
  const dropZone = document.getElementById(dropZoneId);
  const fileInput = document.getElementById(fileInputId);
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    const text = dropZone.querySelector('.file-drop-zone-text');
    if (files.length === 1) {
      text.innerHTML = `<strong>Выбран: ${files[0].name}</strong>`;
    } else if (files.length > 1) {
      text.innerHTML = `<strong>Выбрано: ${files.length} файлов</strong>`;
    }
  });
}

setupDropZone('singleDropZone', 'singleFile');
setupDropZone('batchDropZone', 'batchFiles');

// Single upload
document.getElementById('singleUploadForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('singleFile').files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('category_id', document.getElementById('singleCategory').value);
  formData.append('subcategory_id', document.getElementById('singleSubcategory').value);
  formData.append('age_rating', document.getElementById('singleAge').value);

  const progressBar = document.getElementById('singleProgress');
  const progressFill = document.getElementById('singleProgressFill');
  progressBar.classList.remove('hidden');
  progressFill.style.width = '0%';

  try {
    await api.upload('/api/media/upload/single', formData, {
      onProgress: (percent) => {
        progressFill.style.width = `${percent}%`;
      },
      signal: singleUploadController.signal,
    });

    progressFill.style.width = '100%';
    toast.show('Файл загружен');
    e.target.reset();
    resetSingleDropZone();
  } catch (err) {
    toast.show(err.message, 'error');
  } finally {
    setTimeout(() => {
      progressBar.classList.add('hidden');
      progressFill.style.width = '0%';
    }, 2000);
  }
});

function resetSingleDropZone() {
  const dropZone = document.getElementById('singleDropZone');
  const text = dropZone.querySelector('.file-drop-zone-text');
  text.innerHTML = '<i data-lucide="image-plus" class="icon-xl icon-accent mb-2"></i><br><strong>Перетащите файл</strong> или нажмите для выбора';
  lucide.createIcons();
}

// Batch upload
let batchUploadController = null;
const cancelBatchBtn = document.getElementById('cancelBatchUpload');

cancelBatchBtn?.addEventListener('click', () => {
  if (batchUploadController) {
    batchUploadController.abort();
  }
});

document.getElementById('batchUploadForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = document.getElementById('batchFiles').files;
  if (!files.length) return;

  const queue = document.getElementById('uploadQueue');
  queue.innerHTML = '';
  cancelBatchBtn.classList.remove('hidden');
  batchUploadController = new AbortController();

  const categoryId = document.getElementById('batchCategory').value;
  const subcategoryId = document.getElementById('batchSubcategory').value;
  const ageRating = document.getElementById('batchAge').value;

  const fileArray = Array.from(files);
  const queueItems = fileArray.map(file => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const icon = file.type.startsWith('video') ? 'video' : 'image';
    item.innerHTML = `
      <div class="queue-icon"><i data-lucide="${icon}" class="icon-md"></i></div>
      <span class="queue-name">${file.name}</span>
      <span class="queue-status">В очереди</span>
      <div class="queue-progress"><div class="queue-progress-fill"></div></div>
    `;
    queue.appendChild(item);
    return { file, item, status: item.querySelector('.queue-status'), progress: item.querySelector('.queue-progress-fill') };
  });
  lucide.createIcons();

  const CONCURRENCY = 3;
  let completed = 0;
  let errors = 0;

  try {
    for (let i = 0; i < queueItems.length; i += CONCURRENCY) {
      if (batchUploadController.signal.aborted) break;
      const batch = queueItems.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ file, status, progress }) => {
        if (batchUploadController.signal.aborted) return;
        status.textContent = 'Загрузка...';

        const formData = new FormData();
        formData.append('files', file);
        if (categoryId) formData.append('category_id', categoryId);
        if (subcategoryId) formData.append('subcategory_id', subcategoryId);
        if (ageRating) formData.append('age_rating', ageRating);

        try {
          await api.upload('/api/media/upload/multiple', formData, {
            onProgress: (percent) => {
              progress.style.width = `${percent}%`;
            },
            signal: batchUploadController.signal,
          });
          progress.style.width = '100%';
          status.textContent = 'Готово';
          status.classList.add('done');
          completed++;
        } catch (err) {
          progress.style.width = '100%';
          progress.classList.add('error');
          status.textContent = batchUploadController.signal.aborted ? 'Отменено' : 'Ошибка';
          status.classList.add('error');
          errors++;
        }
      }));
    }

    toast.show(`Загрузка завершена: ${completed} успешно, ${errors} ошибок`);
  } catch (err) {
    toast.show(err.message, 'error');
  } finally {
    batchUploadController = null;
    cancelBatchBtn.classList.add('hidden');
    resetBatchDropZone();
  }
});

function resetBatchDropZone() {
  const dropZone = document.getElementById('batchDropZone');
  const text = dropZone.querySelector('.file-drop-zone-text');
  text.innerHTML = '<i data-lucide="folder-plus" class="icon-xl icon-accent mb-2"></i><br><strong>Перетащите файлы</strong> или нажмите для выбора';
  lucide.createIcons();
}

async function loadMediaCards(page = 1, append = false) {
  if (state.adminLoading || !state.adminHasMore) return;
  state.adminLoading = true;
  state.currentMediaPage = page;
  const grid = document.getElementById('mediaCards');
  if (!grid) return;

  if (!append) {
    grid.innerHTML = '<div class="skeleton-grid">' + Array(8).fill('<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-controls"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>').join('') + '</div>';
  }

  try {
    let url = `/api/admin/media?page=${page}&limit=50`;
    if (state.adminMissingFilters.length > 0) {
      url += `&missing=${state.adminMissingFilters.join(',')}`;
    }
    console.log('Loading admin media:', url);
    const data = await api.get(url);
    console.log('Admin media response:', data);
    state.adminHasMore = page < data.totalPages;

    if (!append) grid.innerHTML = '';

    if (!data.media || data.media.length === 0 && !append) {
      grid.innerHTML = `
        <div class="empty-state grid-full">
          <div class="empty-state-icon"><i data-lucide="image" class="icon-lg"></i></div>
          <div class="empty-state-title">Нет медиа</div>
          <div class="empty-state-text">Загрузите файлы во вкладке "Загрузка"</div>
        </div>`;
    } else {
      data.media.forEach((item, i) => {
        const startIndex = (page - 1) * 50;
        const card = createAdminCard(item, startIndex + i);
        grid.appendChild(card);
      });
    }

    updateSelectedCount();
    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load admin media:', err);
    if (!append) {
      grid.innerHTML = '<div class="empty-state grid-full"><div class="empty-state-icon"><i data-lucide="alert-triangle" class="icon-lg"></i></div><div class="empty-state-title">Ошибка загрузки</div><div class="empty-state-text">' + (err.message || 'Не удалось загрузить медиа') + '</div></div>';
    }
  } finally {
    state.adminLoading = false;
  }
}

function setupAdminInfiniteScroll() {
  const sentinel = document.getElementById('adminGridSentinel');
  if (!sentinel) return;

  if (state.adminObserver) state.adminObserver.disconnect();

  state.adminObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !state.adminLoading && state.adminHasMore) {
        loadMediaCards(state.currentMediaPage + 1, true);
      }
    });
  }, { rootMargin: '300px' });

  state.adminObserver.observe(sentinel);
}

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-icon"><i data-lucide="alert-triangle" class="icon-lg icon-warning"></i></div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-actions">
          <button class="btn btn-sm" id="confirmCancel">Отмена</button>
          <button class="btn btn-danger btn-sm" id="confirmOk">Подтвердить</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    lucide.createIcons();

    const close = (result) => {
      overlay.remove();
      document.body.style.overflow = '';
      resolve(result);
    };

    overlay.querySelector('#confirmCancel').addEventListener('click', () => close(false));
    overlay.querySelector('#confirmOk').addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
  });
}

function createAdminCard(item, index = 0) {
  const card = document.createElement('div');
  card.className = 'admin-card';
  card.dataset.id = item.id;
  card.style.animationDelay = `${(index % 50) * 0.03}s`;

  const img = document.createElement('img');
  img.src = item.thumbnail_url || item.url;
  img.className = 'admin-card-thumb';
  img.loading = 'lazy';
  img.alt = `${item.type} ${item.age_rating !== null ? item.age_rating + ' лет' : ''}`;
  img.addEventListener('click', () => openPreview(item));
  card.appendChild(img);

  const overlay = document.createElement('div');
  overlay.className = 'admin-card-overlay';
  overlay.innerHTML = `
    <span class="admin-card-type"><i data-lucide="${item.type === 'photo' ? 'image' : 'video'}" class="icon-sm"></i> ${item.type === 'photo' ? 'Фото' : 'Видео'}</span>
    <span class="admin-card-id">#${item.id}</span>
  `;
  card.appendChild(overlay);

  const controls = document.createElement('div');
  controls.className = 'admin-card-controls';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'admin-card-checkbox';
  checkbox.value = item.id;
  checkbox.addEventListener('change', updateSelectedCount);
  card.appendChild(checkbox);

  const catSelect = document.createElement('select');
  catSelect.className = 'admin-card-select';
  catSelect.dataset.field = 'category';
  catSelect.innerHTML = '<option value="">Категория</option>' +
    state.allAdminCategories.map(c => `<option value="${c.id}" ${c.id === item.category_id ? 'selected' : ''}>${c.name}</option>`).join('');
  catSelect.addEventListener('change', async () => {
    const subSelect = card.querySelector('[data-field="subcategory"]');
    if (subSelect) {
      const subs = await categories.loadSubcategories(catSelect.value);
      subSelect.innerHTML = '<option value="">Подкатегория</option>' +
        subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }
    await saveSingleChange(item.id, { category_id: catSelect.value || null });
  });
  controls.appendChild(catSelect);

  const subSelect = document.createElement('select');
  subSelect.className = 'admin-card-select';
  subSelect.dataset.field = 'subcategory';
  subSelect.innerHTML = '<option value="">Подкатегория</option>';
  subSelect.addEventListener('change', async () => {
    await saveSingleChange(item.id, { subcategory_id: subSelect.value || null });
  });
  controls.appendChild(subSelect);

  if (item.category_id) {
    categories.loadSubcategories(item.category_id).then(subs => {
      subSelect.innerHTML = '<option value="">Подкатегория</option>' +
        subs.map(s => `<option value="${s.id}" ${s.id === item.subcategory_id ? 'selected' : ''}>${s.name}</option>`).join('');
    });
  }

  const ageSelect = document.createElement('select');
  ageSelect.className = 'admin-card-select';
  ageSelect.innerHTML = '<option value="">Возраст</option>' +
    AGE_RATINGS.map(a => `<option value="${a}" ${item.age_rating === a ? 'selected' : ''}>${a >= 19 ? a + '+' : a}</option>`).join('');
  ageSelect.addEventListener('change', async () => {
    await saveSingleChange(item.id, { age_rating: ageSelect.value || null });
  });
  controls.appendChild(ageSelect);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-sm';
  delBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i>';
  delBtn.addEventListener('click', () => deleteSingleMedia(item.id));
  controls.appendChild(delBtn);

  card.appendChild(controls);
  return card;
}

async function saveSingleChange(id, updates) {
  try {
    await api.put('/api/media/batch-update', { ids: [id], ...updates });
    toast.show('Сохранено');
  } catch (err) {
    toast.show(err.message, 'error');
  }
}

function openPreview(item) {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-media-full">
      ${item.type === 'video'
        ? `<video src="${item.url}" controls autoplay class="preview-media"></video>`
        : `<img src="${item.url}" class="preview-media" alt="${item.type} ${item.age_rating !== null ? item.age_rating + ' лет' : ''}">`}
    </div>
    <button class="modal-close" id="previewClose">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  const close = () => {
    modal.remove();
    document.body.style.overflow = '';
  };
  modal.querySelector('.modal-overlay').addEventListener('click', close);
  modal.querySelector('#previewClose').addEventListener('click', close);
}

function updateSelectedCount() {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox:checked');
  const countEl = document.getElementById('selectedCount');
  if (countEl) {
    countEl.textContent = `Выбрано: ${checkboxes.length}`;
  }
}

document.getElementById('selectAllBtn')?.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox');
  state.allSelected = !state.allSelected;
  checkboxes.forEach(cb => cb.checked = state.allSelected);
  const btn = document.getElementById('selectAllBtn');
  if (state.allSelected) {
    btn.innerHTML = '<i data-lucide="square" class="icon-sm"></i> Снять всё';
  } else {
    btn.innerHTML = '<i data-lucide="check-square" class="icon-sm"></i> Выбрать всё';
  }
  updateSelectedCount();
  lucide.createIcons();
});

document.getElementById('applyBatch')?.addEventListener('click', async () => {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox:checked');
  const ids = Array.from(checkboxes).map(cb => cb.value);
  if (!ids.length) {
    toast.show('Ничего не выбрано', 'error');
    return;
  }

  const categoryId = document.getElementById('batchSetCategory').value;
  const subcategoryId = document.getElementById('batchSetSubcategory').value;
  const ageRating = document.getElementById('batchSetAge').value;

  const updates = { ids };
  if (categoryId) updates.category_id = categoryId;
  if (subcategoryId) updates.subcategory_id = subcategoryId;
  if (ageRating) updates.age_rating = ageRating;

  if (Object.keys(updates).length === 1) {
    toast.show('Выберите действие', 'error');
    return;
  }

  try {
    await api.put('/api/media/batch-update', updates);
    toast.show('Изменения применены');
    resetBatchGrid();
    loadMediaCards(1, false);
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

document.getElementById('deleteBatch')?.addEventListener('click', async () => {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox:checked');
  const ids = Array.from(checkboxes).map(cb => cb.value);
  if (!ids.length) {
    toast.show('Ничего не выбрано', 'error');
    return;
  }

  if (!await showConfirm(`Удалить ${ids.length} элементов?`)) return;

  try {
    await api.post('/api/media/batch-delete', { ids });
    toast.show('Элементы удалены');
    resetBatchGrid();
    loadMediaCards(1, false);
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

async function deleteSingleMedia(id) {
  if (!await showConfirm('Удалить это медиа?')) return;
  try {
    await api.delete(`/api/media/${id}`);
    toast.show('Медиа удалено');
    resetBatchGrid();
    loadMediaCards(1, false);
  } catch (err) {
    toast.show(err.message, 'error');
  }
}

// === CATEGORIES ===
async function loadCategoriesPanel() {
  await loadAdminCategories();
  const tbody = document.getElementById('categoriesTableBody');
  if (!tbody) return;

  const [cats, subs] = await Promise.all([
    categories.loadAll(),
    api.get('/api/categories/subcategories'),
  ]);

  tbody.innerHTML = '';
  if (cats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state"><div class="empty-state-icon"><i data-lucide="folder" class="icon-lg"></i></div><div class="empty-state-title">Нет категорий</div></div></td></tr>';
    return;
  }

  const subsByCat = new Map();
  subs.forEach(s => {
    if (!subsByCat.has(s.category_id)) subsByCat.set(s.category_id, []);
    subsByCat.get(s.category_id).push(s);
  });

  cats.forEach(cat => {
    const row = document.createElement('tr');
    const catSubs = subsByCat.get(cat.id) || [];
    const subsHtml = catSubs.length === 0
      ? '-'
      : catSubs.map(s => `
          <span class="subcategory-tag">
            ${s.name}
            <button class="btn-icon btn-danger-subcategory" data-delete-subcategory="${s.id}" title="Удалить подкатегорию">
              <i data-lucide="x" class="icon-xs"></i>
            </button>
          </span>
        `).join('');
    row.innerHTML = `
      <td>${cat.name}</td>
      <td class="subcategory-list">${subsHtml}</td>
      <td>
        <button class="btn btn-danger btn-sm" data-delete-category="${cat.id}" title="Удалить категорию">
          <i data-lucide="trash-2" class="icon-sm"></i>
        </button>
      </td>
    `;
    row.querySelector('[data-delete-category]').addEventListener('click', async () => {
      if (!await showConfirm(`Удалить категорию "${cat.name}"?`)) return;
      try {
        await api.delete(`/api/categories/${cat.id}`);
        toast.show('Категория удалена');
        await loadAdminCategories();
        loadCategoriesPanel();
      } catch (err) {
        toast.show(err.message, 'error');
      }
    });
    row.querySelectorAll('[data-delete-subcategory]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const subId = btn.dataset.deleteSubcategory;
        const subName = catSubs.find(s => s.id == subId)?.name || '';
        if (!await showConfirm(`Удалить подкатегорию "${subName}"?`)) return;
        try {
          await api.delete(`/api/categories/subcategories/${subId}`);
          toast.show('Подкатегория удалена');
          loadCategoriesPanel();
        } catch (err) {
          toast.show(err.message, 'error');
        }
      });
    });
    tbody.appendChild(row);
  });
  lucide.createIcons();
}

document.getElementById('createCategoryBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('newCategoryName');
  const name = input.value.trim();
  if (!name) return;
  try {
    await api.post('/api/categories', { name });
    toast.show('Категория создана');
    input.value = '';
    await loadAdminCategories();
    loadCategoriesPanel();
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

document.getElementById('createSubcategoryBtn')?.addEventListener('click', async () => {
  const categorySelect = document.getElementById('newSubcategoryCategory');
  const input = document.getElementById('newSubcategoryName');
  const categoryId = categorySelect.value;
  const name = input.value.trim();
  if (!categoryId || !name) {
    toast.show('Выберите категорию и введите название', 'error');
    return;
  }
  try {
    await api.post('/api/categories/subcategories', { categoryId, name });
    toast.show('Подкатегория создана');
    input.value = '';
    loadCategoriesPanel();
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

// === TOKENS ===
async function loadTokens() {
  const tbody = document.getElementById('tokensTableBody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Загрузка...</td></tr>';

  try {
    const tokens = await api.get('/api/admin/tokens');
    tbody.innerHTML = '';

    if (tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon"><i data-lucide="lock" class="icon-lg"></i></div><div class="empty-state-title">Нет токенов</div><div class="empty-state-text">Создайте токен для нового пользователя</div></div></td></tr>';
    } else {
      const currentTokenIdInput = document.getElementById('currentTokenId');
      const currentTokenId = currentTokenIdInput ? parseInt(currentTokenIdInput.value, 10) : null;
      tokens.forEach(token => {
        const row = document.createElement('tr');
        const isActive = token.is_active;
        const isCurrentUser = token.id === currentTokenId;
        const statusBadge = isActive
          ? '<span class="badge badge-active">активен</span>'
          : '<span class="badge badge-inactive">неактивен</span>';
        row.innerHTML = `
          <td>
            <span class="token-mask" title="Токен хранится в зашифрованном виде и не отображается">••••••••••••</span>
          </td>
          <td><span class="badge badge-${token.type}">${token.type}</span></td>
          <td><span class="table-cell-date">${new Date(token.created_at).toLocaleDateString()}</span></td>
          <td>
            <span class="table-cell-date" id="token-expires-${token.id}">${token.expires_at ? new Date(token.expires_at).toLocaleDateString() : 'Никогда'}</span>
            <input type="date" class="token-expires-input hidden" id="token-expires-input-${token.id}" value="${token.expires_at ? token.expires_at.split('T')[0] : ''}">
            <button class="btn btn-sm btn-secondary ml-1" data-edit-expires="${token.id}" ${isCurrentUser ? 'disabled title="Нельзя изменить срок текущего токена"' : ''}>
              <i data-lucide="pencil" class="icon-sm"></i>
            </button>
            <button class="btn btn-sm btn-primary hidden ml-1" data-save-expires="${token.id}" id="token-save-expires-${token.id}" ${isCurrentUser ? 'disabled title="Нельзя изменить срок текущего токена"' : ''}>
              <i data-lucide="check" class="icon-sm"></i>
            </button>
          </td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn ${isActive ? 'btn-danger' : 'btn-primary'} btn-sm" data-toggle-token="${token.id}" data-active="${!isActive}" ${isCurrentUser ? 'disabled title="Нельзя деактивировать текущий токен"' : ''}>
              <i data-lucide="${isActive ? 'x' : 'check'}" class="icon-sm"></i>
              ${isActive ? 'Деактивировать' : 'Активировать'}
            </button>
            <button class="btn btn-danger btn-sm ml-1" data-delete-token="${token.id}" title="Удалить токен" ${isCurrentUser ? 'disabled title="Нельзя удалить текущий токен"' : ''}>
              <i data-lucide="trash-2" class="icon-sm"></i>
            </button>
          </td>
        `;
        row.querySelector('[data-toggle-token]').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const id = btn.dataset.toggleToken;
          const active = btn.dataset.active === 'true';
          await toggleToken(id, active);
        });
        const deleteBtn = row.querySelector('[data-delete-token]');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.deleteToken;
            await deleteToken(id);
          });
        }
        const editExpiresBtn = row.querySelector('[data-edit-expires]');
        if (editExpiresBtn) {
          editExpiresBtn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.editExpires;
            document.getElementById(`token-expires-${id}`).classList.add('hidden');
            document.getElementById(`token-expires-input-${id}`).classList.remove('hidden');
            document.getElementById(`token-save-expires-${id}`).classList.remove('hidden');
          });
        }
        const saveExpiresBtn = row.querySelector('[data-save-expires]');
        if (saveExpiresBtn) {
          saveExpiresBtn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.saveExpires;
            const input = document.getElementById(`token-expires-input-${id}`);
            const newDate = input.value || null;
            try {
              await api.put(`/api/admin/tokens/${id}`, { expires_at: newDate });
              toast.show('Дата обновлена');
              loadTokens();
            } catch (err) {
              toast.show(err.message, 'error');
            }
          });
        }
        tbody.appendChild(row);
      });
    }
    lucide.createIcons();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Ошибка загрузки</td></tr>';
  }
}

document.getElementById('createTokenBtn')?.addEventListener('click', async () => {
  const type = document.getElementById('tokenType').value;
  const expiresAt = document.getElementById('tokenExpires').value || null;

  try {
    const data = await api.post('/api/admin/tokens', { type, expires_at: expiresAt });
    showNewTokenModal(data.token);
    document.getElementById('tokenExpires').value = '';
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

function showNewTokenModal(token) {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="new-token-modal">
      <h3>Новый токен создан</h3>
      <p>Скопируйте его сейчас. После закрытия окна восстановить токен будет невозможно.</p>
      <div class="new-token-row">
        <code id="newTokenValue" class="new-token-value">${token}</code>
        <button class="btn btn-secondary" id="copyNewToken">
          <i data-lucide="copy" class="icon-md"></i>
        </button>
      </div>
      <button class="btn btn-primary" id="closeNewTokenModal">Я сохранил токен</button>
    </div>
  `;
  document.body.appendChild(modal);
  lucide.createIcons();

  modal.querySelector('#copyNewToken').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      toast.show('Токен скопирован');
    } catch {
      toast.show('Не удалось скопировать', 'error');
    }
  });
  modal.querySelector('#closeNewTokenModal').addEventListener('click', () => modal.remove());
  modal.querySelector('.modal-overlay').addEventListener('click', () => modal.remove());
}

async function toggleToken(id, isActive) {
  try {
    await api.put(`/api/admin/tokens/${id}`, { is_active: isActive });
    toast.show(isActive ? 'Токен активирован' : 'Токен деактивирован');
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
}

async function deleteToken(id) {
  if (!await showConfirm('Удалить этот токен? Пользователь потеряет доступ')) return;
  try {
    await api.delete(`/api/admin/tokens/${id}`);
    toast.show('Токен удалён');
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
}

// === DUPLICATES ===
const findDuplicatesBtn = document.getElementById('findDuplicatesBtn');
const duplicatesResults = document.getElementById('duplicatesResults');
const duplicatesProgress = document.getElementById('duplicatesProgress');
const duplicatesProgressFill = document.getElementById('duplicatesProgressFill');
const duplicatesStatus = document.getElementById('duplicatesStatus');

findDuplicatesBtn?.addEventListener('click', async () => {
  findDuplicatesBtn.disabled = true;
  findDuplicatesBtn.innerHTML = '<div class="spinner" class="spinner-sm"></div> Поиск...';
  duplicatesProgress.style.display = 'block';
  duplicatesProgressFill.style.width = '0%';
  duplicatesResults.innerHTML = '';
  duplicatesStatus.textContent = 'Вычисление хешей и поиск групп...';

  try {
    const data = await api.post('/api/admin/find-duplicates');
    duplicatesProgressFill.style.width = '100%';

    if (!data.groups || data.groups.length === 0) {
      duplicatesResults.innerHTML = `
        <div class="upload-card">
          <div class="empty-state">
            <div class="empty-state-icon"><i data-lucide="check-circle" class="icon-lg"></i></div>
            <div class="empty-state-title">Дубликаты не найдены</div>
            <div class="empty-state-text">Все медиа уникальны по обложкам</div>
          </div>
        </div>`;
    } else {
      duplicatesResults.innerHTML = `
        <div class="upload-card">
          <div class="upload-card-title flex-between">
            <span>Найдено групп: ${data.groups.length} (${data.totalDuplicates} медиа)</span>
            <div class="flex-gap-sm">
              <span class="selected-count" id="dupSelectedCount">Выбрано: 0</span>
              <button class="btn btn-danger btn-sm" id="deleteDupSelected" disabled>
                <i data-lucide="trash-2" class="icon-sm"></i>
                Удалить выбранные
              </button>
            </div>
          </div>
          <div id="duplicatesGroups"></div>
        </div>`;

      const groupsContainer = document.getElementById('duplicatesGroups');
      data.groups.forEach((group, gi) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'dup-group';
        groupEl.innerHTML = `<div class="dup-group-label">Группа ${gi + 1} (${group.items.length} шт.)</div><div class="dup-group-items"></div>`;
        const itemsContainer = groupEl.querySelector('.dup-group-items');
        group.items.forEach(item => {
          const card = document.createElement('div');
          card.className = 'dup-card';
          card.innerHTML = `
            <img src="${item.thumbnail_url}" class="dup-thumb" loading="lazy" alt="">
            <div class="dup-info">
              <span class="dup-id">#${item.id}</span>
              <span class="dup-type"><i data-lucide="${item.type === 'photo' ? 'image' : 'video'}" class="icon-xs"></i></span>
              ${item.age_rating !== null ? `<span class="card-age" class="age-static">${item.age_rating >= 19 ? item.age_rating + '+' : item.age_rating}</span>` : ''}
            </div>
            <label class="dup-checkbox-label">
              <input type="checkbox" class="dup-checkbox" value="${item.id}">
            </label>
          `;
          card.querySelector('.dup-thumb').addEventListener('click', () => openPreview(item));
          itemsContainer.appendChild(card);
        });
        groupsContainer.appendChild(groupEl);
      });

      lucide.createIcons();

      document.querySelectorAll('.dup-checkbox').forEach(cb => {
        cb.addEventListener('change', updateDupSelectedCount);
      });
      document.getElementById('deleteDupSelected')?.addEventListener('click', deleteDupSelected);
    }
  } catch (err) {
    duplicatesResults.innerHTML = `<div class="upload-card"><div class="status-error">Ошибка: ${err.message}</div></div>`;
  } finally {
    findDuplicatesBtn.disabled = false;
    findDuplicatesBtn.innerHTML = '<i data-lucide="search" class="icon-md"></i> Найти дубликаты';
    duplicatesStatus.textContent = '';
    setTimeout(() => {
      duplicatesProgress.style.display = 'none';
      duplicatesProgressFill.style.width = '0%';
    }, 500);
    lucide.createIcons();
  }
});

function updateDupSelectedCount() {
  const checked = document.querySelectorAll('.dup-checkbox:checked');
  const countEl = document.getElementById('dupSelectedCount');
  const delBtn = document.getElementById('deleteDupSelected');
  if (countEl) countEl.textContent = `Выбрано: ${checked.length}`;
  if (delBtn) delBtn.disabled = checked.length === 0;
}

async function deleteDupSelected() {
  const checked = document.querySelectorAll('.dup-checkbox:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (!ids.length) return;

  if (!await showConfirm(`Удалить ${ids.length} элементов?`)) return;

  try {
    await api.post('/api/media/batch-delete', { ids });
    toast.show('Элементы удалены');
    checked.forEach(cb => {
      const card = cb.closest('.dup-card');
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => card.remove(), 300);
    });
    updateDupSelectedCount();
  } catch (err) {
    toast.show(err.message, 'error');
  }
}

// === STATISTICS ===
async function loadStats() {
  const container = document.getElementById('statsContainer');
  if (!container) return;
  container.innerHTML = '<div class="skeleton-grid">' + Array(6).fill('<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-controls"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>').join('') + '</div>';

  try {
    const data = await api.get('/api/admin/stats');
    renderStats(container, data);
  } catch (err) {
    container.innerHTML = `<div class="status-error">Ошибка загрузки статистики: ${err.message}</div>`;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Б';
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 10) / 10 + ' ' + sizes[i];
}

function renderStats(container, data) {
  const totalCount = data.typeStats.reduce((s, t) => s + parseInt(t.count, 10), 0);
  const totalSize = data.typeStats.reduce((s, t) => s + (parseInt(t.total_size, 10) || 0), 0);

  const typeRows = data.typeStats.map(t => {
    const percent = totalCount ? Math.round((t.count / totalCount) * 100) : 0;
    return `
      <tr>
        <td>${t.type === 'photo' ? 'Фото' : 'Видео'}</td>
        <td>${t.count}</td>
        <td>${percent}%</td>
        <td>${formatBytes(t.avg_size)}</td>
        <td>${formatBytes(t.total_size)}</td>
      </tr>
    `;
  }).join('');

  const ageRows = data.ageStats.map(a => `
    <tr>
      <td>${a.age === 'Не указан' ? 'Не указан' : a.age + (parseInt(a.age, 10) >= 19 ? '+' : '')}</td>
      <td>${a.count}</td>
    </tr>
  `).join('');

  const categoryRows = data.categoryStats.map(c => `
    <tr>
      <td>${c.category || 'Без категории'}</td>
      <td>${c.subcategory}</td>
      <td>${c.count}</td>
    </tr>
  `).join('');

  const missing = data.missingMetadata;
  const processing = data.missingProcessing;
  const recent = data.recentUploads;

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-value">${totalCount}</div>
        <div class="stat-card-label">Всего файлов</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${formatBytes(totalSize)}</div>
        <div class="stat-card-label">Общий объём</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${recent.last_24h}</div>
        <div class="stat-card-label">За 24 часа</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${recent.last_7d}</div>
        <div class="stat-card-label">За 7 дней</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${recent.last_30d}</div>
        <div class="stat-card-label">За 30 дней</div>
      </div>
    </div>

    <div class="stats-tables-grid">
      <div class="stats-table-card">
        <div class="stats-table-title">Фото / Видео</div>
        <div class="table-container">
          <table class="admin-table">
            <thead><tr><th>Тип</th><th>Кол-во</th><th>Доля</th><th>Средний размер</th><th>Общий размер</th></tr></thead>
            <tbody>${typeRows}</tbody>
          </table>
        </div>
      </div>

      <div class="stats-table-card">
        <div class="stats-table-title">Возрастной рейтинг</div>
        <div class="table-container">
          <table class="admin-table">
            <thead><tr><th>Возраст</th><th>Кол-во</th></tr></thead>
            <tbody>${ageRows}</tbody>
          </table>
        </div>
      </div>

      <div class="stats-table-card stats-table-wide">
        <div class="stats-table-title">Категории / Подкатегории</div>
        <div class="table-container">
          <table class="admin-table">
            <thead><tr><th>Категория</th><th>Подкатегория</th><th>Кол-во</th></tr></thead>
            <tbody>${categoryRows}</tbody>
          </table>
        </div>
      </div>

      <div class="stats-table-card">
        <div class="stats-table-title">Проблемные файлы</div>
        <div class="table-container">
          <table class="admin-table">
            <thead><tr><th>Проблема</th><th>Кол-во</th><th></th></tr></thead>
            <tbody>
              <tr>
                <td>Без категории</td>
                <td>${missing.missing_category}</td>
                <td><button class="btn btn-sm btn-primary" data-missing-filter="category_id">Исправить</button></td>
              </tr>
              <tr>
                <td>Без подкатегории</td>
                <td>${missing.missing_subcategory}</td>
                <td><button class="btn btn-sm btn-primary" data-missing-filter="subcategory_id">Исправить</button></td>
              </tr>
              <tr>
                <td>Без возраста</td>
                <td>${missing.missing_age}</td>
                <td><button class="btn btn-sm btn-primary" data-missing-filter="age_rating">Исправить</button></td>
              </tr>
              <tr>
                <td>Без миниатюры</td>
                <td>${processing.missing_thumbnail}</td>
                <td></td>
              </tr>
              <tr>
                <td>Без display-версии</td>
                <td>${processing.missing_display}</td>
                <td></td>
              </tr>
              <tr>
                <td>Без phash</td>
                <td>${processing.missing_phash}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('[data-missing-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.missingFilter;
      document.querySelectorAll('.admin-missing-filter').forEach(cb => cb.checked = false);
      const target = document.querySelector(`.admin-missing-filter[data-field="${field}"]`);
      if (target) {
        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const batchTab = document.querySelector('.admin-tab[data-tab="batch"]');
      if (batchTab) batchTab.click();
    });
  });

  lucide.createIcons();
}

document.getElementById('refreshStatsBtn')?.addEventListener('click', loadStats);

// === BACKUP / RESTORE ===
document.getElementById('backupBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('backupBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner spinner-sm"></div> Скачивание...';

  try {
    const response = await fetch('/api/admin/backup', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Ошибка скачивания бэкапа');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = response.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || `rskmedia_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.show('Бэкап скачан');
  } catch (err) {
    toast.show(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="download" class="icon-md"></i> Скачать бэкап';
    lucide.createIcons();
  }
});

const restoreDropZone = document.getElementById('restoreDropZone');
const restoreFile = document.getElementById('restoreFile');
const restoreBtn = document.getElementById('restoreBtn');
const restoreStatus = document.getElementById('restoreStatus');

if (restoreDropZone && restoreFile) {
  restoreDropZone.addEventListener('click', () => restoreFile.click());

  restoreDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    restoreDropZone.classList.add('dragover');
  });

  restoreDropZone.addEventListener('dragleave', () => {
    restoreDropZone.classList.remove('dragover');
  });

  restoreDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    restoreDropZone.classList.remove('dragover');
    restoreFile.files = e.dataTransfer.files;
    restoreFile.dispatchEvent(new Event('change', { bubbles: true }));
  });

  restoreFile.addEventListener('change', () => {
    if (restoreFile.files.length > 0) {
      const text = restoreDropZone.querySelector('.file-drop-zone-text');
      text.innerHTML = `<i data-lucide="file-check" class=\"icon-xl icon-success mb-2\"></i><br><strong>Выбран: ${restoreFile.files[0].name}</strong>`;
      restoreBtn.disabled = false;
      restoreStatus.style.display = 'none';
      lucide.createIcons();
    } else {
      restoreBtn.disabled = true;
    }
  });
}

restoreBtn?.addEventListener('click', async () => {
  if (!restoreFile.files.length) return;

  if (!await showConfirm('Восстановление заменит все текущие данные в базе. Продолжить?')) return;

  restoreBtn.disabled = true;
  restoreBtn.innerHTML = '<div class="spinner spinner-sm"></div> Восстановление...';
  restoreStatus.style.display = 'block';
  restoreStatus.className = '';
  restoreStatus.textContent = 'Восстановление...';

  const formData = new FormData();
  formData.append('file', restoreFile.files[0]);

  try {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const response = await fetch('/api/admin/restore', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': meta ? meta.content : '',
      },
      body: formData,
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Ошибка восстановления');
    }

    restoreStatus.className = 'status-success';
    restoreStatus.textContent = 'База данных успешно восстановлена';
    toast.show('База данных восстановлена');
  } catch (err) {
    restoreStatus.className = 'status-error';
    restoreStatus.textContent = err.message;
    toast.show(err.message, 'error');
  } finally {
    restoreBtn.disabled = false;
    restoreBtn.innerHTML = '<i data-lucide="refresh-cw" class="icon-md"></i> Восстановить';
    lucide.createIcons();
  }
});
