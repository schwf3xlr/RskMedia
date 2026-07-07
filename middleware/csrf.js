const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getCsrfToken(req, res) {
  let token = req.signedCookies?.[CSRF_COOKIE_NAME] || req.cookies?.[CSRF_COOKIE_NAME];
  if (!token) {
    token = generateToken();
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      signed: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
  return token;
}

function csrfProtection(req, res, next) {
  // Safe methods do not require CSRF token
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const cookieToken = req.signedCookies?.[CSRF_COOKIE_NAME] || req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME] || req.headers[CSRF_HEADER_NAME.replace(/-/g, '_')] || req.body?._csrf;

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }

  next();
}

function csrfTokenMiddleware(req, res, next) {
  res.locals.csrfToken = getCsrfToken(req, res);
  next();
}

// Public endpoint clients hit after a 403 "Invalid or missing CSRF token" so
// they can refresh their in-memory <meta> value without a full page reload.
// The cookie is httpOnly, so JS can't read it directly — this returns just
// the value (also refreshing the cookie if it was cleared) as JSON.
function csrfTokenEndpoint(req, res) {
  const token = getCsrfToken(req, res);
  res.json({ csrfToken: token });
}

module.exports = {
  csrfProtection,
  csrfTokenMiddleware,
  csrfTokenEndpoint,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
};
