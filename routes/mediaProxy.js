const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
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

// Allowed width buckets for adaptive sizing. Anything outside the range is
// rejected (returns 400) so we don't accidentally serve arbitrary sharp
// requests that would flood the cache. Includes tiny sizes (32/64/128) for
// the modal blur-up placeholder - sharp downsamples a large image to these
// widths so the JPEG is genuinely small (~1-3 KB) and inlines into CSS
// quickly even on slow connections.
const ALLOWED_WIDTHS = [32, 64, 128, 400, 600, 800, 1200, 1920];
const ALLOWED_FORMATS = {
  webp: { contentType: 'image/webp', sharpFormat: 'webp', quality: 82 },
  avif: { contentType: 'image/avif', sharpFormat: 'avif', quality: 60 },
  jpeg: { contentType: 'image/jpeg', sharpFormat: 'jpeg', quality: 85 },
  png: { contentType: 'image/png', sharpFormat: 'png', quality: 90 },
};

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

// Parse and validate `?w=` and `?format=` query parameters. Returns either
// { kind: 'passthrough' } (no transform needed) or { kind: 'transform', width, format }
// with validated values. Rejects anything outside the allow-list.
function parseTransformParams(query) {
  const w = query.w !== undefined ? parseInt(query.w, 10) : null;
  const f = query.format !== undefined ? String(query.format).toLowerCase() : null;

  if (w === null && f === null) return { kind: 'passthrough' };

  if (w !== null && (!ALLOWED_WIDTHS.includes(w) || w <= 0)) {
    return { kind: 'invalid', reason: `Width must be one of: ${ALLOWED_WIDTHS.join(', ')}` };
  }
  if (f !== null && !ALLOWED_FORMATS[f]) {
    return { kind: 'invalid', reason: `Format must be one of: ${Object.keys(ALLOWED_FORMATS).join(', ')}` };
  }
  return { kind: 'transform', width: w, format: f };
}

// Apply sharp resize + format conversion. The output is cached separately
// from the source buffer so the S3 hit is shared across all transform
// variants.
async function applyTransform(buffer, width, format) {
  let pipeline = sharp(buffer, { failOn: 'none', limitInputPixels: false });
  if (width) {
    pipeline = pipeline.resize(width, null, { withoutEnlargement: true, fit: 'inside' });
  }
  if (format) {
    const spec = ALLOWED_FORMATS[format];
    pipeline = pipeline.toFormat(spec.sharpFormat, { quality: spec.quality });
  } else {
    // No format requested - keep source format but re-encode for consistency
    // (e.g. progressive JPEG). Skip re-encode if not specified to save CPU.
  }
  return { buffer: await pipeline.toBuffer(), format };
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

  // Parse transform params (w/format). Range requests on transformed output
  // are not supported - clients that need ranges should request the source.
  const transform = parseTransformParams(req.query);
  if (transform.kind === 'invalid') {
    return res.status(400).json({ error: transform.reason });
  }
  const isTransformed = transform.kind === 'transform';

  // For transformed output, derive a variant-specific cache key and ETag.
  // Different (width, format) combinations produce different bytes, so they
  // must not collide.
  const variantKey = isTransformed
    ? `${cacheKey}?w=${transform.width ?? ''}&f=${transform.format ?? ''}`
    : cacheKey;
  const variantEtag = isTransformed
    ? '"' + crypto.createHash('sha1').update(variantKey).digest('hex') + '"'
    : etag;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
  res.setHeader('ETag', variantEtag);

  // ETag-based 304: skip body if client already has this version
  if (req.headers['if-none-match'] === variantEtag) {
    return res.status(304).end();
  }

  // Range request on cache miss (only for non-transformed, since transforms
  // produce fixed-size buffers): let S3 handle the range directly.
  if (rangeHeader && !isTransformed) {
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

  // Non-range request: prefer buffer cache (variant-specific for transforms)
  const cached = cacheGet(variantKey);
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

  if (isHead && !isTransformed) {
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

  // Fetch source from S3 (or cache), then apply transform if requested.
  try {
    const { buffer: srcBuffer, contentType: srcContentType } = await fetchFullBuffer(cacheKey, s3Key);

    if (!isTransformed) {
      res.status(200);
      res.setHeader('Content-Type', srcContentType);
      res.setHeader('Content-Length', srcBuffer.length);
      return res.end(srcBuffer);
    }

    // Videos can't be resized/formatted as still images. Fall back to
    // original bytes with the source content type.
    if (!srcContentType.startsWith('image/')) {
      res.status(200);
      res.setHeader('Content-Type', srcContentType);
      res.setHeader('Content-Length', srcBuffer.length);
      return res.end(srcBuffer);
    }

    const { buffer: outBuffer, format } = await applyTransform(srcBuffer, transform.width, transform.format);
    const outContentType = format ? ALLOWED_FORMATS[format].contentType : srcContentType;

    if (outBuffer.length <= MAX_CACHE_SIZE) {
      cacheSet(variantKey, outBuffer, outContentType);
    }

    res.status(200);
    res.setHeader('Content-Type', outContentType);
    res.setHeader('Content-Length', outBuffer.length);
    return res.end(outBuffer);
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
