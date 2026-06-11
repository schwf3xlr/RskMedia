const db = require('../config/database');

const CategoryModel = {
  async getAll() {
    const result = await db.query('SELECT * FROM categories ORDER BY name');
    return result.rows;
  },

  async create(name) {
    const result = await db.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING *',
      [name]
    );
    return result.rows[0];
  },

  async update(id, name) {
    const result = await db.query(
      'UPDATE categories SET name = $1 WHERE id = $2 RETURNING *',
      [name, id]
    );
    return result.rows[0];
  },

  async delete(id) {
    await db.query('DELETE FROM categories WHERE id = $1', [id]);
  },
};

module.exports = CategoryModel;
