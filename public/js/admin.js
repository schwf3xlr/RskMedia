import { auth, api, toast, categories } from './main.js';

if (!auth.isAdmin()) {
  window.location.href = '/';
}

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
      adminHasMore = true;
      adminLoading = false;
      currentMediaPage = 1;
      loadMediaCards(1, false).then(() => setupAdminInfiniteScroll());
    }
    if (target === 'tokens') loadTokens();
  });
});

let adminMissingFilters = [];

document.querySelectorAll('.admin-missing-filter').forEach(cb => {
  cb.addEventListener('change', () => {
    adminMissingFilters = Array.from(document.querySelectorAll('.admin-missing-filter:checked'))
      .map(c => c.dataset.field);
    adminHasMore = true;
    adminLoading = false;
    currentMediaPage = 1;
    const grid = document.getElementById('mediaCards');
    grid.innerHTML = '';
    if (adminObserver) adminObserver.disconnect();
    loadMediaCards(1, false).then(() => setupAdminInfiniteScroll());
  });
});

async function loadAdminCategories() {
  const cats = await categories.loadAll();
  const selects = ['singleCategory', 'batchCategory', 'batchSetCategory'];
  selects.forEach(id => {
    const select = document.getElementById(id);
    if (select) categories.populateSelect(select, cats, id.includes('Set') ? 'Установить категорию' : 'Без категории');
  });
}

// Batch subcategory: load when category changes
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
    const event = new Event('change', { bubbles: true });
    fileInput.dispatchEvent(event);
  });

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (files.length === 1) {
      const text = dropZone.querySelector('.file-drop-zone-text');
      text.innerHTML = `<strong>Выбран: ${files[0].name}</strong>`;
    } else if (files.length > 1) {
      const text = dropZone.querySelector('.file-drop-zone-text');
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
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  try {
    const response = await fetch('/api/media/upload/single', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${auth.getToken()}` },
      body: formData,
    });

    if (!response.ok) throw new Error('Upload failed');

    progressFill.style.width = '100%';
    toast.show('Файл загружен');
    e.target.reset();
    const dropZone = document.getElementById('singleDropZone');
    const text = dropZone.querySelector('.file-drop-zone-text');
    text.innerHTML = `<i data-lucide="image-plus" style="width:32px;height:32px;color:var(--accent);margin-bottom:8px"></i><br><strong>Перетащите файл</strong> или нажмите для выбора`;
    lucide.createIcons();
  } catch (err) {
    toast.show(err.message, 'error');
  } finally {
    setTimeout(() => {
      progressBar.style.display = 'none';
      progressFill.style.width = '0%';
    }, 2000);
  }
});

// Batch upload
document.getElementById('batchUploadForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = document.getElementById('batchFiles').files;
  if (!files.length) return;

  const queue = document.getElementById('uploadQueue');
  queue.innerHTML = '';

  const categoryId = document.getElementById('batchCategory').value;
  const subcategoryId = document.getElementById('batchSubcategory').value;
  const ageRating = document.getElementById('batchAge').value;

  const fileArray = Array.from(files);
  const queueItems = fileArray.map(file => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const icon = file.type.startsWith('video') ? '🎥' : '🖼️';
    item.innerHTML = `
      <div class="queue-icon">${icon}</div>
      <span class="queue-name">${file.name}</span>
      <span class="queue-status">В очереди</span>
      <div class="queue-progress"><div class="queue-progress-fill"></div></div>
    `;
    queue.appendChild(item);
    return { file, item, status: item.querySelector('.queue-status'), progress: item.querySelector('.queue-progress-fill') };
  });

  for (let i = 0; i < queueItems.length; i += 2) {
    const batch = queueItems.slice(i, i + 2);
    await Promise.all(batch.map(async ({ file, status, progress }) => {
      status.textContent = 'Загрузка...';
      progress.style.width = '50%';

      const formData = new FormData();
      formData.append('files', file);
      if (categoryId) formData.append('category_id', categoryId);
      if (subcategoryId) formData.append('subcategory_id', subcategoryId);
      if (ageRating) formData.append('age_rating', ageRating);

      try {
        const response = await fetch('/api/media/upload/multiple', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${auth.getToken()}` },
          body: formData,
        });

        if (!response.ok) throw new Error();
        progress.style.width = '100%';
        status.textContent = 'Готово';
        status.classList.add('done');
      } catch {
        progress.style.width = '100%';
        progress.style.background = 'var(--danger)';
        status.textContent = 'Ошибка';
        status.classList.add('error');
      }
    }));
  }

  toast.show(`Загрузка завершена: ${files.length} файлов`);
  const dropZone = document.getElementById('batchDropZone');
  const text = dropZone.querySelector('.file-drop-zone-text');
  text.innerHTML = `<i data-lucide="folder-plus" style="width:32px;height:32px;color:var(--accent);margin-bottom:8px"></i><br><strong>Перетащите файлы</strong> или нажмите для выбора`;
  lucide.createIcons();
});

let currentMediaPage = 1;
let allAdminCategories = [];
let allAdminSubcategories = {};
let adminLoading = false;
let adminHasMore = true;
let adminObserver = null;

async function loadMediaCards(page = 1, append = false) {
  if (adminLoading || !adminHasMore) return;
  adminLoading = true;
  currentMediaPage = page;
  const grid = document.getElementById('mediaCards');

  if (!append) {
    grid.innerHTML = '<div class="skeleton-grid">' + Array(8).fill('<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-controls"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>').join('') + '</div>';
  }

  try {
    let url = `/api/admin/media?page=${page}&limit=50`;
    if (adminMissingFilters.length > 0) {
      url += `&missing=${adminMissingFilters.join(',')}`;
    }
    const data = await api.get(url);
    adminHasMore = page < data.totalPages;

    if (!append) grid.innerHTML = '';

    if (data.media.length === 0 && !append) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-state-icon">🖼️</div>
          <div class="empty-state-title">Нет медиа</div>
          <div class="empty-state-text">Загрузите файлы во вкладке "Загрузка"</div>
        </div>`;
    } else {
      if (!allAdminCategories.length) {
        allAdminCategories = await categories.loadAll();
      }
      data.media.forEach((item, i) => {
        const startIndex = (page - 1) * 50;
        const card = createAdminCard(item, startIndex + i);
        grid.appendChild(card);
      });
    }

    updateSelectedCount();
    lucide.createIcons();
  } catch (err) {
    if (!append) {
      grid.innerHTML = '<div class="skeleton-grid">' + Array(8).fill('<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-controls"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>').join('') + '</div>';
    }
  } finally {
    adminLoading = false;
  }
}

function setupAdminInfiniteScroll() {
  const sentinel = document.getElementById('adminGridSentinel');
  if (!sentinel) return;

  if (adminObserver) adminObserver.disconnect();

  adminObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !adminLoading && adminHasMore) {
        loadMediaCards(currentMediaPage + 1, true);
      }
    });
  }, { rootMargin: '300px' });

  adminObserver.observe(sentinel);
}

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-icon"><i data-lucide="alert-triangle" style="width:28px;height:28px;color:var(--warning)"></i></div>
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

    overlay.querySelector('#confirmCancel').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
      resolve(false);
    });
    overlay.querySelector('#confirmOk').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
      resolve(true);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        document.body.style.overflow = '';
        resolve(false);
      }
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
  img.addEventListener('click', () => openPreview(item));
  card.appendChild(img);

  const overlay = document.createElement('div');
  overlay.className = 'admin-card-overlay';
  overlay.innerHTML = `
    <span class="admin-card-type">${item.type === 'photo' ? '🖼️' : '🎥'}</span>
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

  // Category select
  const catSelect = document.createElement('select');
  catSelect.className = 'admin-card-select';
  catSelect.dataset.field = 'category';
  catSelect.innerHTML = '<option value="">Категория</option>' +
    allAdminCategories.map(c => `<option value="${c.id}" ${c.id === item.category_id ? 'selected' : ''}>${c.name}</option>`).join('');
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

  // Subcategory select (initial options)
  const subSelect = document.createElement('select');
  subSelect.className = 'admin-card-select';
  subSelect.dataset.field = 'subcategory';
  subSelect.innerHTML = '<option value="">Подкатегория</option>';
  subSelect.addEventListener('change', async () => {
    await saveSingleChange(item.id, { subcategory_id: subSelect.value || null });
  });
  controls.appendChild(subSelect);

  // Pre-load subcategories if category set
  if (item.category_id) {
    categories.loadSubcategories(item.category_id).then(subs => {
      subSelect.innerHTML = '<option value="">Подкатегория</option>' +
        subs.map(s => `<option value="${s.id}" ${s.id === item.subcategory_id ? 'selected' : ''}>${s.name}</option>`).join('');
    });
  }

  // Age select
  const ageSelect = document.createElement('select');
  ageSelect.className = 'admin-card-select';
  ageSelect.innerHTML = '<option value="">Возраст</option>' +
    [13, 14, 15, 16, 17, 18, 19].map(a => `<option value="${a}" ${item.age_rating === a ? 'selected' : ''}>${a >= 19 ? a + '+' : a}</option>`).join('');
  ageSelect.addEventListener('change', async () => {
    await saveSingleChange(item.id, { age_rating: ageSelect.value || null });
  });
  controls.appendChild(ageSelect);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-sm';
  delBtn.innerHTML = '<i data-lucide="trash-2" style="width:14px;height:14px"></i>';
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
        ? `<video src="${item.url}" controls autoplay style="width:100%;height:100%;object-fit:contain"></video>`
        : `<img src="${item.url}" style="width:100%;height:100%;object-fit:contain">`}
    </div>
    <button class="modal-close" id="previewClose">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  modal.querySelector('.modal-overlay').addEventListener('click', () => {
    modal.remove();
    document.body.style.overflow = '';
  });
  modal.querySelector('#previewClose').addEventListener('click', () => {
    modal.remove();
    document.body.style.overflow = '';
  });
}

function updateSelectedCount() {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox:checked');
  const countEl = document.getElementById('selectedCount');
  if (countEl) {
    countEl.textContent = `Выбрано: ${checkboxes.length}`;
  }
}

document.addEventListener('change', (e) => {
  if (e.target.classList.contains('admin-card-checkbox')) {
    updateSelectedCount();
  }
});

let allSelected = false;

document.getElementById('selectAllBtn')?.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.admin-card-checkbox');
  allSelected = !allSelected;
  checkboxes.forEach(cb => cb.checked = allSelected);
  const btn = document.getElementById('selectAllBtn');
  if (allSelected) {
    btn.innerHTML = '<i data-lucide="square" style="width:14px;height:14px"></i> Снять всё';
  } else {
    btn.innerHTML = '<i data-lucide="check-square" style="width:14px;height:14px"></i> Выбрать всё';
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
    adminHasMore = true;
    adminLoading = false;
    currentMediaPage = 1;
    loadMediaCards(1, false);
    allSelected = false;
    document.getElementById('selectAllBtn').innerHTML = '<i data-lucide="check-square" style="width:14px;height:14px"></i> Выбрать всё';
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
    adminHasMore = true;
    adminLoading = false;
    currentMediaPage = 1;
    loadMediaCards(1, false);
    allSelected = false;
    document.getElementById('selectAllBtn').innerHTML = '<i data-lucide="check-square" style="width:14px;height:14px"></i> Выбрать всё';
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

window.deleteSingleMedia = async function(id) {
  if (!await showConfirm('Удалить это медиа?')) return;
  try {
    await api.delete(`/api/media/${id}`);
    toast.show('Медиа удалено');
    adminHasMore = true;
    adminLoading = false;
    currentMediaPage = 1;
    loadMediaCards(1, false);
    allSelected = false;
    document.getElementById('selectAllBtn').innerHTML = '<i data-lucide="check-square" style="width:14px;height:14px"></i> Выбрать всё';
  } catch (err) {
    toast.show(err.message, 'error');
  }
};

async function loadTokens() {
  const tbody = document.getElementById('tokensTableBody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Загрузка...</td></tr>';

  try {
    const tokens = await api.get('/api/admin/tokens');
    tbody.innerHTML = '';

    if (tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">🔐</div><div class="empty-state-title">Нет токенов</div><div class="empty-state-text">Создайте токен для нового пользователя</div></div></td></tr>';
    } else {
      tokens.forEach(token => {
        const row = document.createElement('tr');
        const isActive = token.is_active;
        const statusBadge = isActive
          ? '<span class="badge badge-active">активен</span>'
          : '<span class="badge badge-inactive">неактивен</span>';
        row.innerHTML = `
          <td><code style="font-family:var(--font-display);font-size:13px;background:var(--bg-2);padding:4px 8px;border-radius:4px;border:1px solid var(--border)">${token.token}</code></td>
          <td><span class="badge badge-${token.type}">${token.type}</span></td>
          <td><span class="table-cell-date">${new Date(token.created_at).toLocaleDateString()}</span></td>
          <td><span class="table-cell-date">${token.expires_at ? new Date(token.expires_at).toLocaleDateString() : 'Никогда'}</span></td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn ${isActive ? 'btn-danger' : 'btn-primary'} btn-sm" onclick="toggleToken(${token.id}, ${!isActive})">
              <i data-lucide="${isActive ? 'x' : 'check'}" style="width:14px;height:14px"></i>
              ${isActive ? 'Деактивировать' : 'Активировать'}
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteToken(${token.id})" style="margin-left:4px">
              <i data-lucide="trash-2" style="width:14px;height:14px"></i>
            </button>
          </td>
        `;
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
    await api.post('/api/admin/tokens', { type, expires_at: expiresAt });
    toast.show('Токен создан');
    document.getElementById('tokenExpires').value = '';
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
});

window.toggleToken = async function(id, isActive) {
  try {
    await api.put(`/api/admin/tokens/${id}`, { is_active: isActive });
    toast.show(isActive ? 'Токен активирован' : 'Токен деактивирован');
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
};

window.deleteToken = async function(id) {
  if (!await showConfirm('Удалить этот токен? Пользователь потеряет доступ')) return;
  try {
    await api.delete(`/api/admin/tokens/${id}`);
    toast.show('Токен удалён');
    loadTokens();
  } catch (err) {
    toast.show(err.message, 'error');
  }
};

// === BACKUP / RESTORE ===

document.getElementById('backupBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('backupBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Скачивание...';

  try {
    const response = await fetch('/api/admin/backup', {
      headers: { 'Authorization': `Bearer ${auth.getToken()}` },
    });
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
    btn.innerHTML = '<i data-lucide="download" style="width:16px;height:16px"></i> Скачать бэкап';
    lucide.createIcons();
  }
});

// Restore file drop zone
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
    const event = new Event('change', { bubbles: true });
    restoreFile.dispatchEvent(event);
  });

  restoreFile.addEventListener('change', () => {
    if (restoreFile.files.length > 0) {
      const text = restoreDropZone.querySelector('.file-drop-zone-text');
      text.innerHTML = `<i data-lucide="file-check" style="width:32px;height:32px;color:var(--success);margin-bottom:8px"></i><br><strong>Выбран: ${restoreFile.files[0].name}</strong>`;
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
  restoreBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Восстановление...';
  restoreStatus.style.display = 'block';
  restoreStatus.className = '';
  restoreStatus.textContent = 'Восстановление...';

  const formData = new FormData();
  formData.append('file', restoreFile.files[0]);

  try {
    const response = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${auth.getToken()}` },
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
    restoreBtn.innerHTML = '<i data-lucide="refresh-cw" style="width:16px;height:16px"></i> Восстановить';
    lucide.createIcons();
  }
});
