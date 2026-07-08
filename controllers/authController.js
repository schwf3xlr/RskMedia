const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const UserModel = require('../models/user');
const { setAuthCookie, clearAuthCookie, invalidateAuthCache, JWT_SECRET, JWT_EXPIRES } = require('../middleware/auth');
const sseBroker = require('../helpers/sseBroker');
const logger = require('../helpers/logger');

const AuthController = {
  async login(req, res) {
    const { token } = req.body;

    if (!token || (!token.startsWith('client_') && !token.startsWith('admin_'))) {
      logger.warn({ ip: req.ip }, 'AUTH rejected login (bad format)');
      return res.status(400).json({ error: 'Неверный формат токена. Токен должен начинаться с client_ или admin_' });
    }

    const user = await UserModel.findByToken(token);
    if (!user) {
      // Rate limiter (20/15min per IP) blocks brute force; the log gives
      // ops something to grep when they see the block fire.
      logger.warn({ ip: req.ip }, 'AUTH failed login (unknown token)');
      return res.status(401).json({ error: 'Токен не найден. Проверьте правильность введённого токена' });
    }

    const tokenPayload = {
      token_id: user.id,
      type: user.type,
    };

    const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    // Use SHA256 for the JWT lookup hash instead of bcrypt. The hash's only
    // purpose is to let the auth middleware verify the cookie matches what
    // we issued on login — it doesn't need to be slow. Using bcrypt here
    // (a) adds ~100ms of CPU to every login and (b) creates a race where
    // two concurrent logins for the same token can produce two valid JWTs
    // but only one valid hash; the other login's JWT silently stops working.
    // SHA256 is collision-resistant and the JWT itself is already
    // tamper-proof via its signature, so this hash only needs to be unique.
    const jwtHash = crypto.createHash('sha256').update(jwtToken).digest('hex');
    await UserModel.updateJwtHash(user.id, jwtHash);

    // Any OTHER SSE stream for this same token was authenticated against the
    // old jwt_hash and will start rejecting on next api call. Push a targeted
    // auth.revoked so those clients can render a toast + redirect to /login
    // instead of dying silently on the next click.
    sseBroker.publishToToken(user.id, 'auth.revoked', {
      reason: 'concurrent_login',
      message: 'Выполнен вход с другого устройства',
    });
    // Also drop the old sessions from the auth cache so they can't ride the
    // 30s cache TTL past the invalidation.
    invalidateAuthCache(user.id);

    setAuthCookie(res, jwtToken);
    logger.info({ token_id: user.id, type: user.type }, 'AUTH login successful');

    res.json({
      type: user.type,
    });
  },

  async logout(req, res) {
    try {
      if (req.user?.token_id) {
        await UserModel.clearJwtHash(req.user.token_id);
      }
    } catch (err) {
      logger.error({ err }, 'Logout error');
    }
    clearAuthCookie(res);
    res.json({ message: 'Logged out successfully' });
  },
};

module.exports = AuthController;
