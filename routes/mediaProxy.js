const express = require('express');
const db = require('../config/database');
const { getObjectStream } = require('../config/s3');

const router = express.Router();

const TYPE_TO_FIELD = {
  thumb: 'thumbnail_s3_key',
  display: 'display_s3_key',
  original: 's3_key',
};

const MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5 MB
const contentCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function cacheGet(key) {
  const entry = contentCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    contentCache.delete(key);
    return null;
  }
  // LRU: re-insert to move to end
  contentCache.delete(key);
  contentCache.set(key, entry);
  return entry;
}

function cacheSet(key, buffer, ttlMs) {
  if (buffer.length > MAX_CACHE_SIZE) return;
  if (contentCache.size >= MAX_CACHE_ENTRIES && !contentCache.has(key)) {
    const firstKey = contentCache.keys().next().value;
    contentCache.delete(firstKey);
  }
  contentCache.set(key, { buffer, expiresAt: Date.now() + ttlMs });
}

router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const field = TYPE_TO_FIELD[type];
  if (!field) return res.status(400).end();

  try {
    const result = await db.query(
      `SELECT ${field} FROM media WHERE id = $1`,
      [id]
    );
    const s3Key = result.rows[0]?.[field];
    if (!s3Key) return res.status(404).end();

    const cacheKey = `${type}:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', cached.buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(cached.buffer);
    }

    const { body, contentType, contentLength } = await getObjectStream(s3Key);

    const chunks = [];
    let totalSize = 0;
    let cacheable = contentLength !== undefined && contentLength <= MAX_CACHE_SIZE;

    body.on('data', chunk => {
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > MAX_CACHE_SIZE) cacheable = false;
    });
    body.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (cacheable) cacheSet(cacheKey, buffer, 3600 * 1000);

      res.setHeader('Content-Type', contentType || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buffer);
    });
    body.on('error', err => {
      console.error('S3 stream error:', err);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    });
  } catch (err) {
    console.error('Media proxy error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

module.exports = router;
