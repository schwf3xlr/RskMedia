import { toast, collections, showPrompt } from './main.js';

// Простое подтверждение "да/нет" — свой мини-showConfirm без импорта.
function confirmDialog({ title, message, okText = 'Да', okDanger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    if (title) {
      const h = document.createElement('h3');
      h.className = 'confirm-title';
      h.textContent = title;
      modal.appendChild(h);
    }
    if (message) {
      const p = document.createElement('p');
      p.className = 'confirm-message';
      p.textContent = message;
      modal.appendChild(p);
    }
    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Отмена';
    const ok = document.createElement('button');
    ok.className = okDanger ? 'btn btn-danger' : 'btn btn-primary';
    ok.textContent = okText;
    buttons.append(cancel, ok);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
  });
}

const state = { list: [] };

async function load() {
  const spinner = document.getElementById('loadingSpinner');
  spinner?.classList.remove('hidden');
  try {
    state.list = await collections.list();
    render();
  } catch (err) {
    toast.show(err.message || 'Ошибка загрузки', 'error');
  } finally {
    spinner?.classList.add('hidden');
  }
}

function render() {
  const grid = document.getElementById('collectionsGrid');
  const empty = document.getElementById('collectionsEmpty');
  const count = document.getElementById('collectionsCount');
  if (!grid) return;

  grid.innerHTML = '';
  if (state.list.length === 0) {
    empty?.classList.remove('hidden');
    if (count) count.textContent = '';
    return;
  }
  empty?.classList.add('hidden');
  if (count) count.textContent = `${state.list.length}`;

  const frag = document.createDocumentFragment();
  for (const c of state.list) frag.appendChild(renderCard(c));
  grid.appendChild(frag);
  if (window.lucide) window.lucide.createIcons();
}

function renderCard(c) {
  const card = document.createElement('div');
  card.className = 'collection-card';
  card.setAttribute('role', 'listitem');

  // Клик по карточке → открыть коллекцию. Действия (переименовать/удалить/
  // скачать) — по своим кнопкам с stopPropagation.
  card.addEventListener('click', () => {
    window.location.href = `/collections/${c.id}`;
  });

  // Preview: до трёх миниатюр, наплывающих друг на друга. Если пусто —
  // показываем иконку-плейсхолдер.
  const preview = document.createElement('div');
  preview.className = 'collection-card-preview';
  if (c.thumbs && c.thumbs.length > 0) {
    c.thumbs.forEach((url, i) => {
      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.className = `collection-thumb collection-thumb-${i + 1}`;
      preview.appendChild(img);
    });
  } else {
    const ph = document.createElement('div');
    ph.className = 'collection-card-empty';
    ph.innerHTML = '<i data-lucide="image" class="icon-lg"></i>';
    preview.appendChild(ph);
  }
  card.appendChild(preview);

  const body = document.createElement('div');
  body.className = 'collection-card-body';
  const title = document.createElement('div');
  title.className = 'collection-card-title';
  title.textContent = c.name;
  const meta = document.createElement('div');
  meta.className = 'collection-card-meta';
  meta.textContent = `${c.count} медиа`;
  body.append(title, meta);
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'collection-card-actions';
  actions.appendChild(iconBtn('pencil', 'Переименовать', async (e) => {
    e.stopPropagation();
    const newName = await showPrompt({
      title: 'Переименовать',
      placeholder: 'Название',
      initial: c.name,
      okText: 'Сохранить',
    });
    if (!newName || newName === c.name) return;
    try {
      await collections.rename(c.id, newName);
      toast.show('Переименовано');
      await load();
    } catch (err) { toast.show(err.message || 'Ошибка', 'error'); }
  }));
  actions.appendChild(iconBtn('download', 'Скачать zip', (e) => {
    e.stopPropagation();
    window.location.href = `/api/collections/${c.id}/export`;
  }));
  actions.appendChild(iconBtn('trash-2', 'Удалить', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Удалить коллекцию?',
      message: `«${c.name}» будет удалена. Сами медиа останутся в галерее.`,
      okText: 'Удалить',
      okDanger: true,
    });
    if (!ok) return;
    try {
      await collections.remove(c.id);
      toast.show('Коллекция удалена');
      await load();
    } catch (err) { toast.show(err.message || 'Ошибка', 'error'); }
  }, 'danger'));
  card.appendChild(actions);

  return card;
}

function iconBtn(icon, label, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn ${extraClass}`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<i data-lucide="${icon}" class="icon-sm"></i>`;
  b.addEventListener('click', onClick);
  return b;
}

document.getElementById('createCollectionBtn')?.addEventListener('click', createNew);
document.getElementById('createFirstCollectionBtn')?.addEventListener('click', createNew);

async function createNew() {
  const name = await showPrompt({
    title: 'Новая коллекция',
    placeholder: 'Название',
    okText: 'Создать',
  });
  if (!name) return;
  try {
    await collections.create(name);
    toast.show('Коллекция создана');
    await load();
  } catch (err) {
    toast.show(err.message || 'Ошибка', 'error');
  }
}

load();
