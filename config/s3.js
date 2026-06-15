const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
  maxAttempts: 3,
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

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn });
  urlCache.set(cacheKey, url, CACHE_TTL_MS);
  return url;
}

async function getObjectBuffer(key) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const response = await s3Client.send(command);
  const stream = response.Body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = {
  s3Client,
  uploadToS3,
  deleteFromS3,
  getSignedUrlForKey,
  getObjectBuffer,
  bucket,
};
