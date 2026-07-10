const db = require('../config/database');
const { SORT_MAP } = require('../config/constants');

// Same seeded-random trick as models/media.js. Without it, ORDER BY RANDOM()
// re-shuffles per LIMIT/OFFSET page, and the same favorite lands on multiple
// pages, so listing/modal loops back after a few swipes.
function buildOrderBy(sort, randomSeed, params, fallback) {
  if (sort === 'random' && Number.isFinite(randomSeed)) {
    params.push(String(randomSeed));
    return { order: `md5(m.id::text || $${params.length}), m.id`, idxOffset: 1 };
  }
  return { order: SORT_MAP[sort] || fallback, idxOffset: 0 };
}

// See models/media.js for parseIds — same purpose: accept comma-separated
// multi-select values from the client (e.g. category_id=1,3&age=13,15).
function parseIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw).split(',').map(Number).filter(n => !Number.isNaN(n));
}

function buildWhere({ categoryId, subcategoryId, age, type, params, idx = 2 }) {
  let query = '';
  const categoryIds = parseIds(categoryId);
  if (categoryIds.length > 0) {
    query += ` AND m.category_id IN (${categoryIds.map(() => `$${idx++}`).join(',')})`;
    params.push(...categoryIds);
  }
  const subcategoryIds = parseIds(subcategoryId);
  if (subcategoryIds.length > 0) {
    query += ` AND m.subcategory_id IN (${subcategoryIds.map(() => `$${idx++}`).join(',')})`;
    params.push(...subcategoryIds);
  }
  const ages = parseIds(age);
  if (ages.length > 0) {
    query += ` AND m.age_rating IN (${ages.map(() => `$${idx++}`).join(',')})`;
    params.push(...ages);
  }
  if (type === 'photo' || type === 'video') {
    query += ` AND m.type = $${idx++}`;
    params.push(type);
  }
  return { query, idx };
}

const FavoritesModel = {
  async getByTokenId(tokenId, { categoryId, subcategoryId, age, type, sort, randomSeed, limit = 20, offset = 0 }) {
    return this.getByTokenIdWithCount(tokenId, { categoryId, subcategoryId, age, type, sort, randomSeed, limit, offset });
  },

  async getByTokenIdWithCount(tokenId, { categoryId, subcategoryId, age, type, sort, randomSeed, limit = 20, offset = 0 }) {
    const params = [tokenId];
    const where = buildWhere({ categoryId, subcategoryId, age, type, params });
    const whereClause = where.query;
    let idx = where.idx;

    // Same stable-sort rule as config/constants.js SORT_MAP: when many
    // favorites share the same `added_at` (e.g. user adds several in quick
    // succession), we need a deterministic tiebreaker or pagination can
    // duplicate/skip rows between pages.
    const { order, idxOffset } = buildOrderBy(sort, randomSeed, params, 'f.added_at DESC, m.id DESC');
    idx += idxOffset;
    const query = `
      SELECT m.*, c.name as category_name, s.name as subcategory_name,
             COUNT(*) OVER() AS total_count
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

  async getTotalCount(tokenId, { categoryId, subcategoryId, age, type }) {
    const params = [tokenId];
    const { query: whereClause } = buildWhere({ categoryId, subcategoryId, age, type, params });

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
