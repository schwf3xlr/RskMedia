const rateLimit = require('express-rate-limit');

const keyGenerator = (req) => {
  return req.user?.token_id?.toString() || req.ip;
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT, 10) || 300,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator,
  validate: { xForwardedForHeader: false },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT, 10) || 50,
  message: { error: 'Too many uploads, please try again later' },
  keyGenerator,
  validate: { xForwardedForHeader: false },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.ADMIN_RATE_LIMIT, 10) || 200,
  message: { error: 'Too many admin requests, please try again later' },
  keyGenerator,
  validate: { xForwardedForHeader: false },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  keyGenerator: (req) => req.ip,
  validate: { xForwardedForHeader: false },
});

module.exports = { apiLimiter, uploadLimiter, adminLimiter, authLimiter };
