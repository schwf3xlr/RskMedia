const db = require('../config/database');

const SubcategoryModel = {
  async getAll() {
    const result = await db.query(
      'SELECT id, category_id, name FROM subcategories ORDER BY name'
    );
    return result.rows;
  },

  async getByCategoryId(categoryId) {
    const result = await db.query(
      'SELECT id, name FROM subcategories WHERE category_id = $1 ORDER BY name',
      [categoryId]
    );
    return result.rows;
  },

  async create(categoryId, name) {
    const result = await db.query(
      'INSERT INTO subcategories (category_id, name) VALUES ($1, $2) RETURNING *',
      [categoryId, name]
    );
    return result.rows[0];
  },

  async delete(id) {
    await db.query('DELETE FROM subcategories WHERE id = $1', [id]);
  },
};

module.exports = SubcategoryModel;
