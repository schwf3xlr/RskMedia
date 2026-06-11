const jwt = require('jsonwebtoken');
const UserModel = require('../models/user');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';

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
      expires_at: user.expires_at,
    };

    const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({
      token: jwtToken,
      type: user.type,
    });
  },

  logout(req, res) {
    res.json({ message: 'Logged out successfully' });
  },
};

module.exports = AuthController;
