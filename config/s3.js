const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const http = require('http');

// Keep-alive агенты: без них AWS SDK на каждый запрос создаёт новый TCP+TLS
// коннект к S3, что даёт лишние 100-300ms latency И упирается в лимит
// ephemeral-портов при бурсте запросов (проявляется как "иногда одно медиа
// грузится 15 секунд"). Пулим соединения — переиспользуем.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });

const rawS3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({
    // connect ≤ 5s: если Beget не отвечает по TCP handshake — не ждём вечно.
    connectionTimeout: 5000,
    // Между чтением байт ≤ 60s. Streaming больших видео должен успеть, но
    // если Beget шлёт по 1 байту в минуту — прерываем.
    socketTimeout: 60000,
    httpsAgent,
    httpAgent,
  }),
});

// === Concurrency limiter ===
// Beget S3 (и любой S3-совместимый провайдер) throttle'ит при бурсте
// параллельных connection'ов — это проявляется как "9KB/сек скачивания"
// вместо нормальных 5-50 MB/с. Явно ограничиваем количество активных
// s3Client.send()'ов — очередь на нашей стороне мягче, чем throttle.
// 8 — эмпирически хорошо для одного user'а: параллельно грузятся 6-8
// миниатюр карточек, остальное ждёт микросекунды.
const S3_MAX_CONCURRENT = parseInt(process.env.S3_MAX_CONCURRENT, 10) || 8;
let s3Active = 0;
const s3Waiters = [];

function s3Acquire() {
  if (s3Active < S3_MAX_CONCURRENT) {
    s3Active++;
    return Promise.resolve();
  }
  return new Promise(resolve => s3Waiters.push(resolve));
}
function s3Release() {
  const next = s3Waiters.shift();
  if (next) next();
  else s3Active--;
}

// === Общий deadline ===
// Beget может подвиснуть посередине стрима — socketTimeout не спасёт,
// если байты продолжают капать по чуть-чуть. Общий request-deadline
// (по умолчанию 20с) вырубит запрос и AWS SDK попробует ещё раз через
// maxAttempts:3. Deadlines применяем только к небольшим запросам —
// thumb/display/preview кладутся в память полностью, они должны быть
// быстрыми. Для original (стрим видео с Range) — 90s чтобы медленный
// клиент успел скачать.
const DEADLINE_SMALL_MS = parseInt(process.env.S3_DEADLINE_SMALL_MS, 10) || 20000;
const DEADLINE_LARGE_MS = parseInt(process.env.S3_DEADLINE_LARGE_MS, 10) || 90000;

function timeoutSignal(ms) {
  // AbortSignal.timeout был добавлен в Node 17. Fallback через
  // AbortController если нет.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  t.unref?.();
  return ctrl.signal;
}

// Прокси для s3Client.send() — оборачивает в concurrency + deadline.
// Экспортируется как обычный s3Client вниз по коду, так что вся кодовая
// база (mediaProxy, mediaController, favoritesController, ...) автоматом
// получает эти защиты.
const s3Client = new Proxy(rawS3Client, {
  get(target, prop) {
    if (prop !== 'send') return target[prop];
    return async (command, opts = {}) => {
      await s3Acquire();
      const isLarge = opts.large === true;
      const deadline = timeoutSignal(isLarge ? DEADLINE_LARGE_MS : DEADLINE_SMALL_MS);
      try {
        return await target.send(command, { ...opts, abortSignal: opts.abortSignal || deadline });
      } finally {
        s3Release();
      }
    };
  },
});

const bucket = process.env.S3_BUCKET;
const CACHE_TTL_MS = (parseInt(process.env.S3_URL_CACHE_TTL, 10) || 3300) * 1000;
const CACHE_MAX = parseInt(process.env.S3_URL_CACHE_MAX, 10) || 5000;

class LRUCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now() + 60000) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max && !this.map.has(key)) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const urlCache = new LRUCache(CACHE_MAX);
const inFlight = new Map();

async function uploadToS3(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  return `${process.env.S3_ENDPOINT}/${bucket}/${key}`;
}

async function deleteFromS3(key) {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  await s3Client.send(command);
}

async function getSignedUrlForKey(key, expiresIn = 3600) {
  const cacheKey = `${key}:${expiresIn}`;
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const url = await getSignedUrl(s3Client, command, { expiresIn });
      urlCache.set(cacheKey, url, CACHE_TTL_MS);
      return url;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

async function getObjectBuffer(key, timeoutMs = 10000) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const response = await s3Client.send(command);
  const stream = response.Body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch {}
      reject(new Error(`S3 download timeout after ${timeoutMs}ms: ${key}`));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);

    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

async function getObjectSize(key) {
  const command = new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const response = await s3Client.send(command);
  return response.ContentLength || 0;
}

async function getObjectStream(key) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const response = await s3Client.send(command);
  return {
    body: response.Body,
    contentType: response.ContentType,
    contentLength: response.ContentLength,
  };
}

module.exports = {
  s3Client,
  uploadToS3,
  deleteFromS3,
  getSignedUrlForKey,
  getObjectBuffer,
  getObjectSize,
  getObjectStream,
  bucket,
};
