// Общая обогалка URL'ов для media rows. Раньше эта логика была скопирована в
// mediaController / adminController / favoritesController — три копии
// незаметно расходились и ловили баги при смене режима раздачи.
//
// Три режима раздачи (env.MEDIA_DELIVERY):
//   proxy — наш /media/:type/:id. Node качает с S3, кэширует, шлёт клиенту.
//           Плюсы: auth-gate, sharp-трансформации ?w=NNN, ETag/Range.
//           Минусы: Node в цепочке — самый узкий bottleneck.
//   s3    — прямые presigned URLs на S3. Обход прокси, но каждая ссылка
//           тайм-лимитирована.
//   cdn   — прямые публичные URLs на CDN (Beget). Максимум скорости, CDN
//           кэширует. Трансформации не работают — отдаём файл как есть.
const env = require('../config/env');
const { getSignedUrlForKey } = require('../config/s3');

const MODE = env.MEDIA_DELIVERY; // 'proxy' | 's3' | 'cdn'
const SIGN_EXPIRES = env.SIGN_URL_EXPIRES;
const CDN_URL = env.CDN_URL;

function proxyUrl(req, type, id) {
  return `${req.protocol}://${req.get('host')}/media/${type}/${id}`;
}

function cdnUrl(s3Key) {
  // CDN сконфигурирован так, что ключ идёт от корня — /display/xxx.jpg,
  // /thumbnails/xxx.jpg, /media/xxx.mp4 и т.п. Никакого /<bucket>/ префикса.
  if (!s3Key) return null;
  // s3Key не должен начинаться со слэша, но на всякий случай нормализуем.
  const clean = String(s3Key).replace(/^\/+/, '');
  return `${CDN_URL}/${clean}`;
}

function enrichProxy(row, req) {
  const out = {
    ...row,
    url: proxyUrl(req, 'original', row.id),
    thumbnail_url: proxyUrl(req, 'thumb', row.id),
  };
  if (row.display_s3_key) out.display_url = proxyUrl(req, 'display', row.id);
  if (row.preview_s3_key) out.preview_url = proxyUrl(req, 'preview', row.id);
  return out;
}

async function enrichSigned(row) {
  const [url, thumbnail_url, display_url, preview_url] = await Promise.all([
    getSignedUrlForKey(row.s3_key, SIGN_EXPIRES),
    getSignedUrlForKey(row.thumbnail_s3_key, SIGN_EXPIRES),
    row.display_s3_key ? getSignedUrlForKey(row.display_s3_key, SIGN_EXPIRES) : null,
    row.preview_s3_key ? getSignedUrlForKey(row.preview_s3_key, SIGN_EXPIRES) : null,
  ]);
  return { ...row, url, thumbnail_url, display_url, preview_url };
}

function enrichCdn(row) {
  // CDN-режим: полностью синхронный — никаких S3-запросов на сервер, просто
  // склеиваем строку. Auth-gate нет: URL публичный, любой с ссылкой откроет.
  // Если бакет приватный — Beget CDN должен уметь ходить в него по своему
  // access-key, настраивается в UI Beget'а.
  return {
    ...row,
    url: cdnUrl(row.s3_key),
    thumbnail_url: cdnUrl(row.thumbnail_s3_key),
    display_url: row.display_s3_key ? cdnUrl(row.display_s3_key) : null,
    preview_url: row.preview_s3_key ? cdnUrl(row.preview_s3_key) : null,
  };
}

async function enrichOne(row, req) {
  if (MODE === 'cdn') return enrichCdn(row);
  if (MODE === 'proxy') return enrichProxy(row, req);
  return enrichSigned(row);
}

async function enrichMany(rows, req) {
  if (MODE === 'cdn') return rows.map(enrichCdn);
  if (MODE === 'proxy') return rows.map(r => enrichProxy(r, req));
  return Promise.all(rows.map(enrichSigned));
}

module.exports = { enrichOne, enrichMany, proxyUrl, cdnUrl };
