const db = require('../config/database');

const SORT_MAP = {
  newest: 'm.uploaded_at DESC',
  oldest: 'm.uploaded_at ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC',
  type: 'm.type ASC, m.uploaded_at DESC',
  name: 'm.s3_key ASC',
};

const MediaModel = {
  async getAll({ categoryId, subcategoryId, age, missingFields, sort, limit = 20, offset = 0 }) {
    let query = 'SELECT m.*, c.name as category_name, s.name as subcategory_name FROM media m LEFT JOIN categories c ON m.category_id = c.id LEFT JOIN subcategories s ON m.subcategory_id = s.id WHERE 1=1';
    const params = [];
    let idx = 1;

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
    if (missingFields && Array.isArray(missingFields) && missingFields.length > 0) {
      for (const field of missingFields) {
        query += ` AND m.${field} IS NULL`;
      }
    }

    const order = SORT_MAP[sort] || 'm.uploaded_at DESC';
    query += ` ORDER BY ${order} LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async getById(id) {
    const result = await db.query(
      'SELECT m.*, c.name as category_name, s.name as subcategory_name FROM media m LEFT JOIN categories c ON m.category_id = c.id LEFT JOIN subcategories s ON m.subcategory_id = s.id WHERE m.id = $1',
      [id]
    );
    return result.rows[0];
  },

  async create({ type, s3Key, thumbnailS3Key, categoryId, subcategoryId, ageRating }) {
    const result = await db.query(
      'INSERT INTO media (type, s3_key, thumbnail_s3_key, category_id, subcategory_id, age_rating) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [type, s3Key, thumbnailS3Key, categoryId, subcategoryId, ageRating]
    );
    return result.rows[0];
  },

  async update(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        fields.push(`${dbField} = $${idx}`);
        values.push(value);
        idx++;
      }
    }
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

  async getTotalCount({ categoryId, subcategoryId, age, missingFields, sort }) {
    let query = 'SELECT COUNT(*) FROM media WHERE 1=1';
    const params = [];
    let idx = 1;

    if (categoryId) {
      query += ` AND category_id = $${idx++}`;
      params.push(categoryId);
    }
    if (subcategoryId) {
      query += ` AND subcategory_id = $${idx++}`;
      params.push(subcategoryId);
    }
    if (age !== undefined && age !== null && age !== '') {
      query += ` AND age_rating = $${idx++}`;
      params.push(age);
    }
    if (missingFields && Array.isArray(missingFields) && missingFields.length > 0) {
      for (const field of missingFields) {
        query += ` AND ${field} IS NULL`;
      }
    }

    const result = await db.query(query, params);
    return parseInt(result.rows[0].count);
  },
};

module.exports = MediaModel;
