const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function isPageRequest(req) {
  return !req.path.startsWith('/api/') && req.accepts('html');
}

function redirectToLogin(res) {
  res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax', path: '/' });
  return res.redirect('/login');
}

async function authenticateToken(req, res, next) {
  const token = req.cookies?.auth_token || (req.headers['authorization']?.split(' ')[1]);

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
      'SELECT * FROM tokens WHERE id = $1 AND is_active = true',
      [decoded.token_id]
    );
    if (result.rows.length === 0) {
      console.log(`Auth: token_id=${decoded.token_id} not found or inactive`);
      res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax', path: '/' });
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token deactivated' });
    }

    // Verify token hasn't expired at the DB level
    const user = result.rows[0];
    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      console.log(`Auth: token_id=${decoded.token_id} expired at DB level`);
      res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax', path: '/' });
      if (isPageRequest(req)) {
        return redirectToLogin(res);
      }
      return res.status(403).json({ error: 'Token expired' });
    }

    console.log(`Auth: success for token_id=${decoded.token_id}`);
    req.user = decoded;
    next();
  } catch (err) {
    console.log(`Auth: invalid token - ${err.message}`);
    res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax', path: '/' });
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
  res.clearCookie('auth_token', { httpOnly: true, sameSite: 'strict' });
}

module.exports = { authenticateToken, setAuthCookie, clearAuthCookie, JWT_SECRET, JWT_EXPIRES };
