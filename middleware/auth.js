const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const COOKIE_SECRET = process.env.COOKIE_SECRET;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
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

async function authenticateToken(req, res, next) {
  const token = req.signedCookies?.auth_token || (req.headers['authorization']?.split(' ')[1]);

  if (!token) {
    console.log(`Auth: no token for ${req.method} ${req.path}, isPage=${isPageRequest(req)}`);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log(`Auth: token decoded, token_id=${decoded.token_id}`);
    const result = await db.query(
      'SELECT id, type, expires_at, is_active, jwt_hash FROM tokens WHERE id = $1 AND is_active = true',
      [decoded.token_id]
    );
    if (result.rows.length === 0) {
      console.log(`Auth: token_id=${decoded.token_id} not found or inactive`);
    res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(403).json({ error: 'Token deactivated' });
  }

  const user = result.rows[0];
  if (user.expires_at && new Date(user.expires_at) < new Date()) {
    console.log(`Auth: token_id=${decoded.token_id} expired at DB level`);
    res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(403).json({ error: 'Token expired' });
  }

  if (!user.jwt_hash) {
    console.log(`Auth: token_id=${decoded.token_id} has no jwt_hash (revoked or stale)`);
    res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(403).json({ error: 'Token revoked' });
  }

  const hashMatch = await bcrypt.compare(token, user.jwt_hash);
  if (!hashMatch) {
    console.log(`Auth: token_id=${decoded.token_id} jwt_hash mismatch`);
    res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
    if (isPageRequest(req)) {
      return redirectToLogin(res);
    }
    return res.status(403).json({ error: 'Token revoked' });
  }

    console.log(`Auth: success for token_id=${decoded.token_id}`);
    req.user = decoded;
    next();
  } catch (err) {
    console.log(`Auth: invalid token - ${err.message}`);
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

module.exports = { authenticateToken, setAuthCookie, clearAuthCookie, JWT_SECRET, JWT_EXPIRES, COOKIE_SECRET };
