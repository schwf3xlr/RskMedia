// env must be required first — it validates required vars (S3_*, JWT_SECRET,
// COOKIE_SECRET) at load time and fails fast if any are missing/too weak.
const env = require('./config/env');
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const initDatabase = require('./scripts/init-db');
const logger = require('./helpers/logger');
const ApiError = require('./helpers/apiError');
const { authenticateToken } = require('./middleware/auth');
const { requireAdmin } = require('./middleware/admin');
const { csrfProtection, csrfTokenMiddleware, csrfTokenEndpoint } = require('./middleware/csrf');
const { nonceMiddleware } = require('./middleware/nonce');
const { AGE_RATINGS } = require('./config/constants');
const { apiLimiter } = require('./middleware/rateLimiter');
const dbPool = require('./config/database').pool;

const app = express();
const PORT = env.PORT;

if (env.TRUST_PROXY !== null) {
  app.set('trust proxy', env.TRUST_PROXY);
}

// Security middleware
//
// S3 endpoint is served as media URLs when USE_MEDIA_PROXY=false (direct
// signed URLs to the bucket). Extract the origin so we can whitelist just
// that host in img-src/media-src instead of the whole https: scheme —
// otherwise a script that manages to inject an <img src=…> can exfiltrate
// data to any HTTPS host by abusing the browser's image loader.
function s3Origin() {
  try {
    return new URL(env.S3.ENDPOINT).origin;
  } catch {
    return null;
  }
}
const S3_ORIGIN = s3Origin();

function buildCspDirectives(res) {
  const mediaHosts = ["'self'", "data:", "blob:"];
  if (S3_ORIGIN) mediaHosts.push(S3_ORIGIN);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", `'nonce-${res.locals.nonce}'`],
    styleSrc: ["'self'", `'nonce-${res.locals.nonce}'`, "https://fonts.googleapis.com"],
    // player.js/admin.js set element.style.* imperatively (zoom transforms,
    // swipe-down opacity, etc). Browsers permit that under styleSrc today,
    // but that fallback is being tightened — declaring styleSrcAttr
    // explicitly locks the behavior in place.
    styleSrcAttr: ["'unsafe-inline'"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: mediaHosts,
    mediaSrc: mediaHosts.filter(h => h !== "data:"),
    connectSrc: ["'self'"],
    frameSrc: ["'none'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  };
}

app.use(cookieParser(env.COOKIE_SECRET));
app.use(csrfTokenMiddleware);
app.use(nonceMiddleware);
app.use((req, res, next) => {
  res.locals.AGE_RATINGS = AGE_RATINGS;
  // Client-facing constants exposed via <meta> in header.ejs so the
  // frontend doesn't fork the numbers out of sync with config/constants.js.
  res.locals.CLIENT_CONFIG = {
    ageRatings: AGE_RATINGS,
    maxPhotoSizeMb: env.UPLOAD.MAX_PHOTO_SIZE_MB,
    maxVideoSizeMb: env.UPLOAD.MAX_VIDEO_SIZE_MB,
    maxFileSizeMb: env.UPLOAD.MAX_FILE_SIZE_MB,
    maxBatchFiles: env.UPLOAD.MAX_BATCH_FILES,
  };
  next();
});

app.use((req, res, next) => {
  const cspDirectives = buildCspDirectives(res);
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    // HSTS only makes sense over HTTPS. In dev this header on a
    // localhost:3000 (HTTP) response confuses browsers into refusing to
    // load the site later on the same host over HTTP.
    strictTransportSecurity: env.isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
  })(req, res, next);
});

app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  credentials: true,
}));

app.use(compression({
  filter: (req, res) => {
    // /media/* serves already-compressed JPEG/PNG/MP4/WebM — compression is wasted CPU
    if (req.path.startsWith('/media/')) return false;
    return compression.filter(req, res);
  },
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  // Skip media/static — these floods logs and adds response-time tracking overhead
  skip: (req) => req.path.startsWith('/media/') || req.path.startsWith('/css/') || req.path.startsWith('/js/'),
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: env.isProd ? '1d' : 0,
}));

// Health check — probed by reverse proxy / k8s / uptime monitor. Returns
// 200 only when both dependencies (Postgres + S3) respond within the
// timeout; 503 otherwise so the orchestrator can pull the pod out of
// rotation instead of returning 500s to real users. HEAD on the bucket is
// cheap (no body transfer) and validates credentials + network path.
const { HeadBucketCommand } = require('@aws-sdk/client-s3');
const { s3Client, bucket } = require('./config/s3');
app.get('/health', async (req, res) => {
  const checks = { db: false, s3: false };
  const start = Date.now();
  try {
    await Promise.all([
      dbPool.query('SELECT 1').then(() => { checks.db = true; }),
      s3Client.send(new HeadBucketCommand({ Bucket: bucket })).then(() => { checks.s3 = true; }),
    ]);
    res.json({ status: 'ok', checks, elapsedMs: Date.now() - start });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      checks,
      error: err.message,
      elapsedMs: Date.now() - start,
    });
  }
});

// Media proxy — serves S3 media through local server (avoids CORS/firewall
// issues on phone). Gated behind auth so anyone on the LAN can't hit
// /media/original/<id> without a token. The auth cache (30s LRU) makes this
// cheap — typical page has ~30 image requests but they all reuse one cached
// verification result.
app.use('/media', authenticateToken, require('./routes/mediaProxy'));

// Unregister old service workers and prevent cross-origin fetch interception
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    self.addEventListener('install', e => {
      e.waitUntil(self.skipWaiting());
    });
    self.addEventListener('activate', e => {
      e.waitUntil(
        Promise.all([
          self.clients.claim(),
          self.registration.unregister()
        ])
      );
    });
    self.addEventListener('fetch', e => {
      // Don't intercept cross-origin requests
      if (new URL(e.request.url).origin !== self.location.origin) {
        return;
      }
      e.respondWith(fetch(e.request));
    });
  `);
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// CSRF-token refresh endpoint — clients hit this after a 403 to refresh a
// stale in-memory token without a full reload. GET is safe (no state change),
// so we don't csrfProtection it (it's the very endpoint used to recover from
// CSRF failures).
app.get('/api/csrf-token', csrfTokenEndpoint);

// SSE stream for realtime updates: auth.revoked (new login from another
// device), media.created / media.updated / media.deleted (gallery reactivity
// without polling). Auth-gated so a stranger on the LAN can't listen.
const sseBroker = require('./helpers/sseBroker');
app.get('/api/events', authenticateToken, (req, res) => {
  sseBroker.attach(res, req.user.token_id);
});

// API Routes
app.use('/api/auth', csrfProtection, require('./routes/auth'));
app.use('/api/media', apiLimiter, authenticateToken, csrfProtection, require('./routes/media'));
app.use('/api/categories', apiLimiter, authenticateToken, csrfProtection, require('./routes/categories'));
app.use('/api/favorites', apiLimiter, authenticateToken, csrfProtection, require('./routes/favorites'));
app.use('/api/admin', authenticateToken, requireAdmin, csrfProtection, require('./routes/admin'));

// Page routes
app.get('/login', (req, res) => {
  res.render('login', { title: 'Login', user: null });
});

app.get('/', authenticateToken, (req, res) => {
  res.render('page', { title: 'RskMedia - Галерея', user: req.user, activePage: 'home' });
});

app.get('/favorites', authenticateToken, (req, res) => {
  res.render('page', { title: 'Избранное - RskMedia', user: req.user, activePage: 'favorites' });
});

app.get('/admin', authenticateToken, requireAdmin, (req, res) => {
  res.render('admin', { title: 'Админ - RskMedia', user: req.user });
});

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.status(404).render('error', { title: 'Страница не найдена', message: 'Запрошенная страница не существует', user: req.user || null });
});

// Error handling
app.use((err, req, res, next) => {
  const isApi = req.path.startsWith('/api/');
  const isKnown = err && err.isApiError === true;
  const status = err?.status || 500;

  // Log known 4xx errors at debug (they're operator-visible via response
  // status codes already); unknown/500s at error with a stack trace.
  if (isKnown && status < 500) {
    logger.debug({ err, path: req.path, status }, 'API error');
  } else {
    logger.error({ err, path: req.path, status }, 'Unhandled error');
  }

  // Only leak the raw error message to clients when it's an intentional
  // ApiError (message was chosen deliberately) or we're not in production.
  const message = isKnown || !env.isProd
    ? (err?.message || 'Something went wrong')
    : 'Something went wrong';
  const code = isKnown ? err.code : null;

  if (isApi) {
    const body = { error: message };
    if (code) body.code = code;
    return res.status(status).json(body);
  }

  res.status(status).render('error', { title: 'Ошибка', message, user: req.user || null });
});

async function start() {
  // Required env vars are validated inside config/env.js at load time.
  // If we got this far, JWT_SECRET / COOKIE_SECRET / S3_* are all present.
  try {
    await initDatabase();
    const server = app.listen(PORT, '0.0.0.0', () => {
      const networkInterfaces = require('os').networkInterfaces();
      let localIP = 'localhost';
      for (const iface of Object.values(networkInterfaces).flat()) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
      logger.info({ port: PORT, env: env.NODE_ENV, localIP }, `Server running`);
      logger.info(`Local:   http://localhost:${PORT}`);
      logger.info(`Network: http://${localIP}:${PORT}`);
    });
    registerGracefulShutdown(server);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown: stop accepting new connections, let in-flight requests
// drain, close the DB pool, then exit. Without this, `pm2 restart` / Docker
// stop kills in-flight uploads mid-stream and can leave half-written files
// in S3 (multipart upload parts that never get CompletedMultipartUpload).
function registerGracefulShutdown(server) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received, shutting down gracefully');

    // Force-exit watchdog: if cleanup stalls (hung upload, etc.) we still
    // exit eventually so the process supervisor doesn't have to SIGKILL.
    // Timeout is configurable via SHUTDOWN_TIMEOUT_MS — bump it when in-
    // flight batch uploads routinely exceed the default (a 100-file batch
    // can take longer than 15s to finish streaming to S3).
    const forceExitTimer = setTimeout(() => {
      console.error(`Graceful shutdown timed out after ${env.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new connections. Existing requests continue.
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed');

      // 2. Drain in-flight S3 multipart uploads / open DB queries.
      await dbPool.end();
      logger.info('DB pool drained');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Unhandled errors should be logged with context but not crash the process
  // silently. Log + continue for now (the supervisor will restart on real
  // crashes via process.exit in uncaughtException below).
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    // Give the logger a tick to flush, then exit so the supervisor restarts
    // a clean process (avoids undefined state after a synchronous throw).
    setImmediate(() => process.exit(1));
  });
}

start();
