const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req) => req.ip,
  validate: { xForwardedForHeader: false },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { error: 'Too many uploads, please try again later' },
  keyGenerator: (req) => req.ip,
  validate: { xForwardedForHeader: false },
});

module.exports = { apiLimiter, uploadLimiter };
