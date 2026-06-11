const db = require('../config/database');

const SORT_MAP = {
  newest: 'm.uploaded_at DESC',
  oldest: 'm.uploaded_at ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC',
  type: 'm.type ASC, m.uploaded_at DESC',
  name: 'm.s3_key ASC',
};

const FavoritesModel = {
  async getByTokenId(tokenId, { categoryId, subcategoryId, age, sort, limit = 20, offset = 0 }) {
    let query = `
      SELECT m.*, c.name as category_name, s.name as subcategory_name
      FROM favorites f
      JOIN media m ON f.media_id = m.id
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN subcategories s ON m.subcategory_id = s.id
      WHERE f.token_id = $1
    `;
    const params = [tokenId];
    let idx = 2;

    if (categoryId) {
      query += ` AND m.category_id = $${idx++}`;
      params.push(categoryId);
    }
    if (subcategoryId) {
      query += ` AND m.subcategory_id = $${idx++}`;
      params.push(subcategoryId);
    }
    if (age !== undefined && age !== null && age !== '') {
      query += ` AND m.age_rating = $${idx++}`;
      params.push(age);
    }

    const order = SORT_MAP[sort] || 'f.added_at DESC';
    query += ` ORDER BY ${order} LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async add(tokenId, mediaId) {
    const result = await db.query(
      'INSERT INTO favorites (token_id, media_id) VALUES ($1, $2) ON CONFLICT (token_id, media_id) DO NOTHING RETURNING *',
      [tokenId, mediaId]
    );
    return result.rows[0];
  },

  async remove(tokenId, mediaId) {
    await db.query(
      'DELETE FROM favorites WHERE token_id = $1 AND media_id = $2',
      [tokenId, mediaId]
    );
  },

  async isFavorite(tokenId, mediaId) {
    const result = await db.query(
      'SELECT * FROM favorites WHERE token_id = $1 AND media_id = $2',
      [tokenId, mediaId]
    );
    return result.rows.length > 0;
  },
};

module.exports = FavoritesModel;
