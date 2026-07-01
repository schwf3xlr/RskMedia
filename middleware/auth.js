const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const COOKIE_SECRET = process.env.COOKIE_SECRET;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  signed: true,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const CLEAR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  signed: true,
};

function isPageRequest(req) {
  return !req.path.startsWith('/api/') && req.accepts('html');
}

function redirectToLogin(res) {
  res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
  return res.redirect('/login');
}

// Token auth cache: tokenHash -> { result, expiresAt }
// Avoids DB query + bcrypt.compare on every API call (50-100ms saved per request).
const TOKEN_CACHE_TTL_MS = 30 * 1000;
const TOKEN_CACHE_MAX = 2000;
const authCache = new Map();

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getCachedAuth(fp) {
  const entry = authCache.get(fp);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    authCache.delete(fp);
    return null;
  }
  // LRU touch
  authCache.delete(fp);
  authCache.set(fp, entry);
  return entry;
}

function setCachedAuth(fp, result) {
  if (authCache.size >= TOKEN_CACHE_MAX) {
    const firstKey = authCache.keys().next().value;
    authCache.delete(firstKey);
  }
  authCache.set(fp, { result, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}

function invalidateAuthCache() {
  authCache.clear();
}

async function authenticateToken(req, res, next) {
  const token = req.signedCookies?.auth_token || (req.headers['authorization']?.split(' ')[1]);

  if (!token) {
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(401).json({ error: 'Access token required' });
  }

  const fp = tokenFingerprint(token);
  const cached = getCachedAuth(fp);
  if (cached) {
    req.user = cached.result;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.query(
      'SELECT id, type, expires_at, is_active, jwt_hash FROM tokens WHERE id = $1 AND is_active = true',
      [decoded.token_id]
    );
    if (result.rows.length === 0) {
      res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token deactivated' });
    }

    const user = result.rows[0];
    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token expired' });
    }

    if (!user.jwt_hash) {
      res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token revoked' });
    }

    // Compare against the SHA256 hash that login() stored (see
    // authController.login). Constant-time compare avoids leaking match
    // information via timing differences. timingSafeEqual requires equal-
    // length buffers, so fall back to bcrypt when we encounter a legacy
    // hash from before the SHA256 migration (length != 64 hex chars).
    let hashMatch;
    if (user.jwt_hash.length === 64) {
      const expected = crypto.createHash('sha256').update(token).digest('hex');
      hashMatch = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(user.jwt_hash));
    } else {
      hashMatch = await bcrypt.compare(token, user.jwt_hash);
    }
    if (!hashMatch) {
      res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token revoked' });
    }

    const userContext = { token_id: decoded.token_id, type: user.type };
    setCachedAuth(fp, userContext);
    req.user = userContext;
    next();
  } catch (err) {
    res.clearCookie('auth_token', COOKIE_OPTIONS);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, COOKIE_OPTIONS);
}

function clearAuthCookie(res) {
  res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
}

module.exports = { authenticateToken, setAuthCookie, clearAuthCookie, invalidateAuthCache, JWT_SECRET, JWT_EXPIRES, COOKIE_SECRET };
