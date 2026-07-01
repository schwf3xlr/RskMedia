const express = require('express');
const crypto = require('crypto');
const db = require('../config/database');
const { s3Client, bucket } = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const router = express.Router();

const TYPE_TO_FIELD = {
  thumb: 'thumbnail_s3_key',
  display: 'display_s3_key',
  original: 's3_key',
};

const MAX_CACHE_SIZE = 5 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 3600 * 1000;
const CACHE_TTL_S = 3600;
const S3KEY_CACHE_TTL_MS = 60 * 1000;
const S3KEY_CACHE_MAX = 2000;

const contentCache = new Map();
const s3KeyCache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  const entry = contentCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    contentCache.delete(key);
    return null;
  }
  contentCache.delete(key);
  contentCache.set(key, entry);
  return entry;
}

function cacheSet(key, buffer, contentType) {
  if (buffer.length > MAX_CACHE_SIZE) return;
  if (contentCache.size >= MAX_CACHE_ENTRIES && !contentCache.has(key)) {
    const firstKey = contentCache.keys().next().value;
    contentCache.delete(firstKey);
  }
  contentCache.set(key, { buffer, contentType, expiresAt: Date.now() + CACHE_TTL_MS });
}

function s3KeyCacheGet(id) {
  const entry = s3KeyCache.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    s3KeyCache.delete(id);
    return null;
  }
  return entry;
}

function s3KeyCacheSet(id, field, s3Key) {
  if (s3KeyCache.size >= S3KEY_CACHE_MAX) {
    const firstKey = s3KeyCache.keys().next().value;
    s3KeyCache.delete(firstKey);
  }
  s3KeyCache.set(id, { field, s3Key, expiresAt: Date.now() + S3KEY_CACHE_TTL_MS });
}

function etagFor(s3Key) {
  return '"' + crypto.createHash('sha1').update(s3Key).digest('hex') + '"';
}

async function fetchFullBuffer(cacheKey, s3Key) {
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = (async () => {
    try {
      const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
      const chunks = [];
      let total = 0;
      let cacheable = response.ContentLength !== undefined && response.ContentLength <= MAX_CACHE_SIZE;

      for await (const chunk of response.Body) {
        chunks.push(chunk);
        total += chunk.length;
        if (total > MAX_CACHE_SIZE) cacheable = false;
      }

      const buffer = Buffer.concat(chunks, total);
      const contentType = response.ContentType || 'image/jpeg';
      if (cacheable) cacheSet(cacheKey, buffer, contentType);
      return { buffer, contentType };
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

async function streamFromS3(s3Key, rangeHeader, res) {
  const params = { Bucket: bucket, Key: s3Key };
  if (rangeHeader) params.Range = rangeHeader;

  const response = await s3Client.send(new GetObjectCommand(params));

  res.status(rangeHeader ? 206 : 200);
  if (response.ContentType) res.setHeader('Content-Type', response.ContentType);
  else res.setHeader('Content-Type', 'image/jpeg');
  if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange);
  if (response.ContentLength !== undefined) res.setHeader('Content-Length', response.ContentLength);

  res.on('close', () => {
    if (response.Body && !response.Body.destroyed) response.Body.destroy();
  });
  response.Body.on('error', err => {
    console.error('S3 stream error:', err);
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  });
  response.Body.pipe(res);
}

function parseRange(header, totalSize) {
  if (!header || totalSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];

  let start, end;
  if (startStr === '' && endStr !== '') {
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = startStr === '' ? 0 : parseInt(startStr, 10);
    end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
  }

  if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

async function handle(req, res, s3Key, isHead) {
  const cacheKey = `${req.params.type}:${req.params.id}`;
  const rangeHeader = req.headers.range;
  const etag = etagFor(s3Key);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
  res.setHeader('ETag', etag);

  // ETag-based 304: skip body if client already has this version
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  // Range request on cache miss: let S3 handle the range directly (no buffer needed)
  if (rangeHeader) {
    const cached = cacheGet(cacheKey);
    if (!cached) {
      try {
        await streamFromS3(s3Key, rangeHeader, res);
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          return res.status(404).end();
        }
        throw err;
      }
      return;
    }
    // Cached: parse and slice
    const totalSize = cached.buffer.length;
    const range = parseRange(rangeHeader, totalSize);
    if (!range) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
    const slice = cached.buffer.subarray(range.start, range.end + 1);
    res.status(206);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Content-Length', slice.length);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
    return res.end(slice);
  }

  // Non-range request: prefer buffer cache
  const cached = cacheGet(cacheKey);
  if (cached) {
    if (isHead) {
      res.setHeader('Content-Length', cached.buffer.length);
      res.setHeader('Content-Type', cached.contentType);
      return res.status(200).end();
    }
    res.status(200);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Content-Length', cached.buffer.length);
    return res.end(cached.buffer);
  }

  if (isHead) {
    try {
      const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key, Range: 'bytes=0-0' }));
      const totalSize = parseInt((response.ContentRange || '').split('/')[1], 10) || response.ContentLength || 0;
      if (response.ContentType) res.setHeader('Content-Type', response.ContentType);
      res.setHeader('Content-Length', totalSize);
      return res.status(200).end();
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return res.status(404).end();
      throw err;
    }
  }

  // Full fetch (single GetObject, no extra HeadObject)
  try {
    const { buffer, contentType } = await fetchFullBuffer(cacheKey, s3Key);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).end();
    }
    throw err;
  }
}

async function lookupS3Key(id, field) {
  const cached = s3KeyCacheGet(id);
  if (cached && cached.field === field) return cached.s3Key;

  const result = await db.query(
    `SELECT ${field} FROM media WHERE id = $1`,
    [id]
  );
  const s3Key = result.rows[0]?.[field];
  if (s3Key) s3KeyCacheSet(id, field, s3Key);
  return s3Key || null;
}

function makeRoute(isHead) {
  return async (req, res) => {
    const { type, id } = req.params;
    const field = TYPE_TO_FIELD[type];
    if (!field) return res.status(400).end();

    try {
      const s3Key = await lookupS3Key(id, field);
      if (!s3Key) return res.status(404).end();

      await handle(req, res, s3Key, isHead);
    } catch (err) {
      console.error('Media proxy error:', err);
      if (!res.headersSent) res.status(500).end();
    }
  };
}

router.get('/:type/:id', makeRoute(false));
router.head('/:type/:id', makeRoute(true));

module.exports = router;
