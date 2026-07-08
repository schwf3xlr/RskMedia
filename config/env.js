// Centralized env loader. Called exactly once at process boot from app.js /
// bin scripts — reads process.env, validates required vars, and exports a
// frozen object with typed values. Anything reading process.env directly
// elsewhere is legacy: prefer requiring this module instead.
const dotenv = require('dotenv');
dotenv.config();

function requireStr(name, minLen = 0) {
  const v = process.env[name];
  if (!v || v.length < minLen) {
    throw new Error(
      minLen
        ? `${name} is not set or too weak (min ${minLen} chars). Set it in .env`
        : `${name} is required. Set it in .env`
    );
  }
  return v;
}

function optStr(name, fallback) {
  return process.env[name] || fallback;
}

function optInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function optBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

const NODE_ENV = optStr('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

// Validated at load-time. Fail loudly rather than starting a half-configured
// server that hands out unsigned URLs or connects to the wrong database.
const env = Object.freeze({
  NODE_ENV,
  isProd,

  PORT: optInt('PORT', 3000),
  TRUST_PROXY: process.env.TRUST_PROXY ? (optInt('TRUST_PROXY', 1) || 1) : null,
  CORS_ORIGIN: process.env.CORS_ORIGIN || false,

  JWT_SECRET: requireStr('JWT_SECRET', 32),
  JWT_EXPIRES: optStr('JWT_EXPIRES', '7d'),
  COOKIE_SECRET: requireStr('COOKIE_SECRET', 32),

  DB: {
    HOST: optStr('DB_HOST', 'localhost'),
    PORT: optInt('DB_PORT', 5432),
    NAME: optStr('DB_NAME', 'rskmedia'),
    USER: optStr('DB_USER', 'postgres'),
    PASSWORD: String(process.env.DB_PASSWORD || ''),
    SSL: optBool('DB_SSL', false),
  },

  // S3 endpoint/bucket/creds are load-bearing — the app cannot function
  // without media storage. Fail at boot rather than at first upload.
  S3: {
    ENDPOINT: requireStr('S3_ENDPOINT'),
    REGION: optStr('S3_REGION', 'ru-1'),
    ACCESS_KEY: requireStr('S3_ACCESS_KEY'),
    SECRET_KEY: requireStr('S3_SECRET_KEY'),
    BUCKET: requireStr('S3_BUCKET'),
    URL_CACHE_TTL: optInt('S3_URL_CACHE_TTL', 3300),
    URL_CACHE_MAX: optInt('S3_URL_CACHE_MAX', 5000),
  },

  SIGN_URL_EXPIRES: optInt('SIGN_URL_EXPIRES', 3600),
  USE_MEDIA_PROXY: process.env.USE_MEDIA_PROXY !== 'false',

  UPLOAD: {
    MAX_FILE_SIZE_MB: optInt('MAX_FILE_SIZE_MB', 500),
    MAX_PHOTO_SIZE_MB: optInt('MAX_PHOTO_SIZE_MB', 50),
    MAX_VIDEO_SIZE_MB: optInt('MAX_VIDEO_SIZE_MB', 500),
    MAX_BATCH_FILES: optInt('MAX_BATCH_FILES', 100),
  },

  RATE_LIMITS: {
    API: optInt('API_RATE_LIMIT', 300),
    UPLOAD: optInt('UPLOAD_RATE_LIMIT', 50),
    ADMIN: optInt('ADMIN_RATE_LIMIT', 200),
    AUTH: optInt('AUTH_RATE_LIMIT', 20),
    WINDOW_MS: 15 * 60 * 1000,
  },

  SHUTDOWN_TIMEOUT_MS: optInt('SHUTDOWN_TIMEOUT_MS', 15000),
});

module.exports = env;
