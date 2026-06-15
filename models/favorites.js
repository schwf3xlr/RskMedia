const db = require('../config/database');

const SORT_MAP = {
  newest: 'm.uploaded_at DESC',
  oldest: 'm.uploaded_at ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC',
  photo_first: "m.type = 'photo' DESC, m.uploaded_at DESC",
  video_first: "m.type = 'video' DESC, m.uploaded_at DESC",
  name: 'm.s3_key ASC',
};

function buildWhere({ categoryId, subcategoryId, age, params, idx = 2 }) {
  let query = '';
  if (categoryId) {
    query += ` AND m.category_id = $${idx++}`;
    params.push(categoryId);
  }
  if (subcategoryId) {
    const ids = String(subcategoryId).split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length > 0) {
      query += ` AND m.subcategory_id IN (${ids.map(() => `$${idx++}`).join(',')})`;
      params.push(...ids);
    }
  }
  if (age !== undefined && age !== null && age !== '') {
    query += ` AND m.age_rating = $${idx++}`;
    params.push(age);
  }
  return { query, idx };
}

const FavoritesModel = {
  async getByTokenId(tokenId, { categoryId, subcategoryId, age, sort, limit = 20, offset = 0 }) {
    const params = [tokenId];
    const where = buildWhere({ categoryId, subcategoryId, age, params });
    const whereClause = where.query;
    let idx = where.idx;

    const order = SORT_MAP[sort] || 'f.added_at DESC';
    const query = `
      SELECT m.*, c.name as category_name, s.name as subcategory_name
      FROM favorites f
      JOIN media m ON f.media_id = m.id
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN subcategories s ON m.subcategory_id = s.id
      WHERE f.token_id = $1 ${whereClause}
      ORDER BY ${order}
      LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async getTotalCount(tokenId, { categoryId, subcategoryId, age }) {
    const params = [tokenId];
    const { query: whereClause } = buildWhere({ categoryId, subcategoryId, age, params });

    const query = `
      SELECT COUNT(*)
      FROM favorites f
      JOIN media m ON f.media_id = m.id
      WHERE f.token_id = $1 ${whereClause}`;
    const result = await db.query(query, params);
    return parseInt(result.rows[0].count);
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

  async batchCheck(tokenId, mediaIds) {
    const result = await db.query(
      'SELECT media_id FROM favorites WHERE token_id = $1 AND media_id = ANY($2::int[])',
      [tokenId, mediaIds]
    );
    const favoriteIds = new Set(result.rows.map(r => r.media_id));
    const output = {};
    for (const id of mediaIds) {
      output[id] = favoriteIds.has(id);
    }
    return output;
  },

  async mediaExists(mediaId) {
    const result = await db.query('SELECT id FROM media WHERE id = $1', [mediaId]);
    return result.rows.length > 0;
  },
};

module.exports = FavoritesModel;
