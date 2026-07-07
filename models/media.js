const db = require('../config/database');
const { SORT_MAP } = require('../config/constants');

const ALLOWED_FIELDS = ['category_id', 'subcategory_id', 'age_rating'];

function buildWhere({ categoryId, subcategoryId, age, type, missingFields, query, params, idx = 1 }) {
  let queryStr = ' WHERE 1=1';

  if (categoryId) {
    queryStr += ` AND m.category_id = $${idx++}`;
    params.push(categoryId);
  }
  if (subcategoryId) {
    const ids = String(subcategoryId).split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length > 0) {
      queryStr += ` AND m.subcategory_id IN (${ids.map(() => `$${idx++}`).join(',')})`;
      params.push(...ids);
    }
  }
  if (age !== undefined && age !== null && age !== '') {
    queryStr += ` AND m.age_rating = $${idx++}`;
    params.push(age);
  }
  if (type === 'photo' || type === 'video') {
    queryStr += ` AND m.type = $${idx++}`;
    params.push(type);
  }
  if (missingFields && Array.isArray(missingFields) && missingFields.length > 0) {
    for (const field of missingFields) {
      if (ALLOWED_FIELDS.includes(field)) {
        queryStr += ` AND m.${field} IS NULL`;
      }
    }
  }
  if (query) {
    queryStr += ` AND (m.s3_key ILIKE $${idx++} OR c.name ILIKE $${idx++} OR s.name ILIKE $${idx++})`;
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  return { queryStr, idx };
}

const MediaModel = {
  async getAll({ categoryId, subcategoryId, age, type, missingFields, sort, limit = 20, offset = 0 }) {
    return this.getAllWithCount({ categoryId, subcategoryId, age, type, missingFields, sort, limit, offset });
  },

  // Single-query variant: returns rows with `total_count` from window function (no separate COUNT query)
  async getAllWithCount({ categoryId, subcategoryId, age, type, missingFields, sort, limit = 20, offset = 0 }) {
    const params = [];
    const where = buildWhere({ categoryId, subcategoryId, age, type, missingFields, params });
    const queryStr = where.queryStr;
    let idx = where.idx;

    const order = SORT_MAP[sort] || 'm.uploaded_at DESC';
    const query = `
      SELECT m.*, c.name as category_name, s.name as subcategory_name,
             COUNT(*) OVER() AS total_count
      FROM media m
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN subcategories s ON m.subcategory_id = s.id
      ${queryStr}
      ORDER BY ${order}
      LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async search({ query, categoryId, subcategoryId, age, type, sort, limit = 20, offset = 0 }) {
    return this.searchWithCount({ query, categoryId, subcategoryId, age, type, sort, limit, offset });
  },

  async searchWithCount({ query, categoryId, subcategoryId, age, type, sort, limit = 20, offset = 0 }) {
    const params = [];
    const where = buildWhere({ categoryId, subcategoryId, age, type, params, query });
    const queryStr = where.queryStr;
    let idx = where.idx;

    const order = SORT_MAP[sort] || 'm.uploaded_at DESC';
    const sql = `
      SELECT m.*, c.name as category_name, s.name as subcategory_name,
             COUNT(*) OVER() AS total_count
      FROM media m
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN subcategories s ON m.subcategory_id = s.id
      ${queryStr}
      ORDER BY ${order}
      LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(sql, params);
    return result.rows;
  },

  async getById(id) {
    const result = await db.query(
      `SELECT m.*, c.name as category_name, s.name as subcategory_name
       FROM media m
       LEFT JOIN categories c ON m.category_id = c.id
       LEFT JOIN subcategories s ON m.subcategory_id = s.id
       WHERE m.id = $1`,
      [id]
    );
    return result.rows[0];
  },

  async create({ type, s3Key, thumbnailS3Key, displayS3Key, fileSize, categoryId, subcategoryId, ageRating }) {
    const result = await db.query(
      'INSERT INTO media (type, s3_key, thumbnail_s3_key, display_s3_key, file_size, category_id, subcategory_id, age_rating) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [type, s3Key, thumbnailS3Key, displayS3Key || null, fileSize || null, categoryId, subcategoryId, ageRating]
    );
    return result.rows[0];
  },

  async update(id, updates) {
    // Whitelist: even though we camelCase→snake_case the keys, an attacker who
    // could control the input could still inject arbitrary SQL via a key like
    // "id=1; DROP TABLE media; --" (the lowercase transform doesn't sanitize).
    // Locking down the field list also protects against typos silently writing
    // to the wrong column.
    const ALLOWED_MEDIA_FIELDS = [
      'category_id', 'subcategory_id', 'age_rating',
      's3_key', 'thumbnail_s3_key', 'display_s3_key', 'phash',
    ];
    const fields = [];
    const values = [];
    let idx = 1;

    let thumbnailChanged = false;
    let phashExplicitlySet = false;
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (!ALLOWED_MEDIA_FIELDS.includes(dbField)) continue;
      if (dbField === 'thumbnail_s3_key') thumbnailChanged = true;
      if (dbField === 'phash') phashExplicitlySet = true;
      fields.push(`${dbField} = $${idx}`);
      values.push(value);
      idx++;
    }
    // If the thumbnail key changed but phash wasn't updated by the caller,
    // the old phash no longer describes the (potentially different) image.
    // Null it so findDuplicates recomputes on next pass — otherwise stale
    // hashes cause phantom "duplicate" matches or miss actual dupes.
    if (thumbnailChanged && !phashExplicitlySet) {
      fields.push('phash = NULL');
    }
    if (fields.length === 0) return await this.getById(id);
    values.push(id);

    const result = await db.query(
      `UPDATE media SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  async delete(id) {
    await db.query('DELETE FROM media WHERE id = $1', [id]);
  },

  async getTotalCount({ categoryId, subcategoryId, age, type, missingFields }) {
    const params = [];
    const { queryStr } = buildWhere({ categoryId, subcategoryId, age, type, missingFields, params });

    const query = `SELECT COUNT(*) FROM media m ${queryStr}`;
    const result = await db.query(query, params);
    return parseInt(result.rows[0].count);
  },

  async getSearchCount({ query, categoryId, subcategoryId, age, type }) {
    const params = [];
    const { queryStr } = buildWhere({ categoryId, subcategoryId, age, type, params, query });

    const sql = `SELECT COUNT(*) FROM media m ${queryStr}`;
    const result = await db.query(sql, params);
    return parseInt(result.rows[0].count);
  },
};

module.exports = MediaModel;
