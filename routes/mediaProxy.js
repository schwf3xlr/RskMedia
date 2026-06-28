const express = require('express');
const db = require('../config/database');
const { s3Client, bucket } = require('../config/s3');
const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

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

const contentCache = new Map();
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

function parseRange(header, totalSize) {
  if (!header || totalSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];

  let start;
  let end;
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

async function getMediaSize(s3Key) {
  try {
    const response = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
    return response.ContentLength || 0;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
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

async function streamFromS3(s3Key, range, res) {
  const params = { Bucket: bucket, Key: s3Key };
  if (range) params.Range = `bytes=${range.start}-${range.end}`;

  const response = await s3Client.send(new GetObjectCommand(params));

  res.status(range ? 206 : 200);
  res.setHeader('Content-Type', response.ContentType || 'image/jpeg');
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

async function handle(req, res, s3Key, isHead) {
  const cacheKey = `${req.params.type}:${req.params.id}`;
  const rangeHeader = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_S}`);

  let totalSize = null;
  let contentType = null;
  let fullBuffer = null;

  const cached = cacheGet(cacheKey);
  if (cached) {
    totalSize = cached.buffer.length;
    contentType = cached.contentType;
    fullBuffer = cached.buffer;
  } else {
    totalSize = await getMediaSize(s3Key);
    if (totalSize === null) return res.status(404).end();
  }

  let range = null;
  if (rangeHeader) {
    range = parseRange(rangeHeader, totalSize);
    if (!range) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
  }

  if (isHead) {
    res.setHeader('Content-Length', totalSize);
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.status(200).end();
  }

  if (fullBuffer) {
    if (range) {
      const slice = fullBuffer.subarray(range.start, range.end + 1);
      res.status(206);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', slice.length);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
      return res.end(slice);
    }
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fullBuffer.length);
    return res.end(fullBuffer);
  }

  if (!range) {
    try {
      const { buffer, contentType: ct } = await fetchFullBuffer(cacheKey, s3Key);
      res.status(200);
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Length', buffer.length);
      return res.end(buffer);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).end();
      }
      throw err;
    }
  }

  try {
    await streamFromS3(s3Key, range, res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).end();
    }
    throw err;
  }
}

function makeRoute(isHead) {
  return async (req, res) => {
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
