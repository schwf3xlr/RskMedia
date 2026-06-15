const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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

    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Срок действия токена истёк. Запросите новый токен у администратора' });
    }

    const tokenPayload = {
      token_id: user.id,
      type: user.type,
    };

    const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    // Store a hash of the JWT in DB for server-side invalidation
    const jwtHash = await bcrypt.hash(jwtToken, 10);
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
