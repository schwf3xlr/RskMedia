const db = require('../config/database');

const UserModel = {
  async findByToken(token) {
    const result = await db.query('SELECT * FROM tokens WHERE token = $1 AND is_active = true', [token]);
    return result.rows[0];
  },

  async createToken(token, type, expiresAt) {
    const result = await db.query(
      'INSERT INTO tokens (token, type, expires_at) VALUES ($1, $2, $3) RETURNING *',
      [token, type, expiresAt]
    );
    return result.rows[0];
  },

  async getAllTokens() {
    const result = await db.query('SELECT * FROM tokens ORDER BY created_at DESC');
    return result.rows;
  },

  async updateToken(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
    values.push(id);

    const result = await db.query(
      `UPDATE tokens SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async deleteToken(id) {
    await db.query('DELETE FROM tokens WHERE id = $1', [id]);
  },
};

module.exports = UserModel;
