const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const byTokenOrIp = (req) => req.user?.token_id?.toString() || req.ip;

// Factory instead of 4 near-identical rateLimit() calls. Anything not in
// `overrides` inherits the shared defaults — window, key generator, and the
// XFF-header trust flag (which must be false: we already set trust proxy
// explicitly in app.js, so rate-limit's own XFF validation is redundant
// noise that fires on every request behind a reverse proxy).
function makeLimiter({ max, message, keyGenerator = byTokenOrIp, windowMs = env.RATE_LIMITS.WINDOW_MS }) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    keyGenerator,
    validate: { xForwardedForHeader: false },
  });
}

const apiLimiter = makeLimiter({
  max: env.RATE_LIMITS.API,
  message: 'Too many requests, please try again later',
});

const uploadLimiter = makeLimiter({
  max: env.RATE_LIMITS.UPLOAD,
  message: 'Too many uploads, please try again later',
});

const adminLimiter = makeLimiter({
  max: env.RATE_LIMITS.ADMIN,
  message: 'Too many admin requests, please try again later',
});

// authLimiter keys by IP only — a user attempting brute-force doesn't have a
// valid token yet, so token-based keying would be no-op here.
const authLimiter = makeLimiter({
  max: env.RATE_LIMITS.AUTH,
  message: 'Too many login attempts, please try again later',
  keyGenerator: (req) => req.ip,
});

module.exports = { apiLimiter, uploadLimiter, adminLimiter, authLimiter, makeLimiter };
