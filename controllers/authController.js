const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const UserModel = require('../models/user');
const { setAuthCookie, clearAuthCookie, JWT_SECRET, JWT_EXPIRES } = require('../middleware/auth');

const AuthController = {
  async login(req, res) {
    const { token } = req.body;

    if (!token || (!token.startsWith('client_') && !token.startsWith('admin_'))) {
      return res.status(400).json({ error: 'Неверный формат токена. Токен должен начинаться с client_ или admin_' });
    }

    const user = await UserModel.findByToken(token);
    if (!user) {
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

    setAuthCookie(res, jwtToken);
    console.log(`Login successful for token_id=${user.id}, type=${user.type}`);

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
      console.error('Logout error:', err);
    }
    clearAuthCookie(res);
    res.json({ message: 'Logged out successfully' });
  },
};

module.exports = AuthController;
