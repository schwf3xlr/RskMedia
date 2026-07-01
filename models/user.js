const db = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const HASH_ROUNDS = 12;

// SHA256 fingerprint of the plaintext token — used to look up the row in O(1)
// via the token_lookup UNIQUE index BEFORE running the intentionally-slow
// bcrypt.compare. Without this, every login would run bcrypt against every
// active token (~100ms each), turning the endpoint into a DoS vector as the
// token table grows.
function tokenLookup(tokenPlain) {
  return crypto.createHash('sha256').update(tokenPlain).digest('hex');
}

const UserModel = {
  async findByToken(tokenPlain) {
    const lookup = tokenLookup(tokenPlain);
    // Single-row lookup by indexed lookup hash, then bcrypt-verifies the match.
    // Fallback: if the row was created before token_lookup was backfilled, the
    // lookup hash won't match — fall back to scanning by token type (still
    // O(n) but only one bcrypt per type-bucket, and only for legacy rows).
    const result = await db.query(
      `SELECT id, token_hash, type, expires_at, is_active, created_at, jwt_hash, token_lookup
       FROM tokens
       WHERE is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
         AND token_lookup = $1`,
      [lookup]
    );
    if (result.rows.length === 0) {
      // Legacy fallback for tokens predating the token_lookup column. Scoped
      // to the same type prefix (client_ / admin_) to keep the bcrypt scan
      // proportional to one bucket rather than the whole table.
      const typePrefix = tokenPlain.startsWith('admin_') ? 'admin' : 'client';
      const legacy = await db.query(
        `SELECT id, token_hash, type, expires_at, is_active, created_at, jwt_hash, token_lookup
         FROM tokens
         WHERE is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())
           AND type = $1
           AND token_lookup IS NULL`,
        [typePrefix]
      );
      for (const row of legacy.rows) {
        if (await bcrypt.compare(tokenPlain, row.token_hash)) {
          // Backfill token_lookup so next login hits the fast path.
          await db.query(
            'UPDATE tokens SET token_lookup = $1 WHERE id = $2 AND token_lookup IS NULL',
            [lookup, row.id]
          );
          return row;
        }
      }
      return null;
    }

    const row = result.rows[0];
    const ok = await bcrypt.compare(tokenPlain, row.token_hash);
    if (!ok) return null;
    return row;
  },

  async createToken(tokenPlain, type, expiresAt) {
    const tokenHash = await bcrypt.hash(tokenPlain, HASH_ROUNDS);
    const lookup = tokenLookup(tokenPlain);
    const result = await db.query(
      `INSERT INTO tokens (token_hash, token_lookup, type, expires_at) VALUES ($1, $2, $3, $4)
       RETURNING id, type, created_at, expires_at, is_active`,
      [tokenHash, lookup, type, expiresAt || null]
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
    // Whitelist column names. The controller only passes is_active / expires_at,
    // but a model method that interpolates arbitrary object keys into SQL is a
    // SQL-injection trap waiting to fire if someone wires a new caller in the
    // future.
    const ALLOWED_TOKEN_FIELDS = ['is_active', 'expires_at'];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_TOKEN_FIELDS.includes(key)) continue;
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
    if (fields.length === 0) {
      const existing = await db.query(
        `SELECT id, type, created_at, expires_at, is_active FROM tokens WHERE id = $1`,
        [id]
      );
      return existing.rows[0];
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
