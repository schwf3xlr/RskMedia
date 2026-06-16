import { auth } from './main.js';

lucide.createIcons();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('tokenInput').value.trim();
  const errorEl = document.getElementById('loginError');

  try {
    await auth.login(token);
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message || 'Ошибка подключения к серверу';
  }
});
