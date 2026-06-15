const db = require('../config/database');

const UserModel = {
  async findByToken(token) {
    const result = await db.query(
      'SELECT * FROM tokens WHERE token = $1 AND is_active = true',
      [token]
    );
    return result.rows[0] || null;
  },

  async createToken(token, type, expiresAt) {
    const result = await db.query(
      'INSERT INTO tokens (token, type, expires_at) VALUES ($1, $2, $3) RETURNING id, token, type, expires_at, is_active, created_at',
      [token, type, expiresAt]
    );
    return result.rows[0];
  },

  async getAllTokens() {
    const result = await db.query(
      'SELECT id, token, type, created_at, expires_at, is_active, jwt_hash FROM tokens ORDER BY created_at DESC'
    );
    return result.rows;
  },

  async updateToken(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'expires_at') {
        fields.push(`${key} = $${idx}`);
      } else {
        fields.push(`${key} = $${idx}`);
      }
      values.push(value);
      idx++;
    }
    values.push(id);

    const result = await db.query(
      `UPDATE tokens SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, token, type, created_at, expires_at, is_active`,
      values
    );
    return result.rows[0];
  },

  async deleteToken(id) {
    await db.query('DELETE FROM tokens WHERE id = $1', [id]);
  },

  async updateJwtHash(tokenId, hash) {
    await db.query('UPDATE tokens SET jwt_hash = $1 WHERE id = $2', [hash, tokenId]);
  },

  async clearJwtHash(tokenId) {
    await db.query('UPDATE tokens SET jwt_hash = NULL WHERE id = $1', [tokenId]);
  },
};

module.exports = UserModel;
