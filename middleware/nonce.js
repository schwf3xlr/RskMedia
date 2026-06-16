const crypto = require('crypto');

function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function nonceMiddleware(req, res, next) {
  res.locals.nonce = generateNonce();
  next();
}

module.exports = { nonceMiddleware };
