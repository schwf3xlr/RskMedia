const db = require('../config/database');
const bcrypt = require('bcryptjs');

const HASH_ROUNDS = 12;

const UserModel = {
  async findByToken(tokenPlain) {
    const result = await db.query(
      `SELECT id, token_hash, type, expires_at, is_active, created_at, jwt_hash
       FROM tokens
       WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())`
    );
    for (const row of result.rows) {
      if (await bcrypt.compare(tokenPlain, row.token_hash)) {
        return row;
      }
    }
    return null;
  },

  async createToken(tokenPlain, type, expiresAt) {
    const tokenHash = await bcrypt.hash(tokenPlain, HASH_ROUNDS);
    const result = await db.query(
      `INSERT INTO tokens (token_hash, type, expires_at) VALUES ($1, $2, $3)
       RETURNING id, type, created_at, expires_at, is_active`,
      [tokenHash, type, expiresAt || null]
    );
    return result.rows[0];
  },

  async getAllTokens() {
    const result = await db.query(
      `SELECT id, type, created_at, expires_at, is_active, jwt_hash
       FROM tokens ORDER BY created_at DESC`
    );
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
      `UPDATE tokens SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, type, created_at, expires_at, is_active`,
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
