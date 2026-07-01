const CategoryModel = require('../models/category');
const SubcategoryModel = require('../models/subcategory');

// Categories and subcategories change very rarely. Cache them for 60s on the
// client so the browser doesn't refetch on every navigation between gallery
// and favourites pages.
const READ_CACHE_CONTROL = 'private, max-age=60';

const CategoryController = {
  async getAll(req, res) {
    const categories = await CategoryModel.getAll();
    res.setHeader('Cache-Control', READ_CACHE_CONTROL);
    res.json(categories);
  },

  async create(req, res) {
    const { name } = req.body;
    try {
      const category = await CategoryModel.create(name);
      res.status(201).json(category);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Category already exists' });
      }
      throw err;
    }
  },

  async update(req, res) {
    const { id } = req.params;
    const { name } = req.body;
    try {
      const category = await CategoryModel.update(id, name);
      if (!category) return res.status(404).json({ error: 'Category not found' });
      res.json(category);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Category name already exists' });
      }
      throw err;
    }
  },

  async delete(req, res) {
    const { id } = req.params;
    try {
      const count = await CategoryModel.getMediaCount(id);
      if (count > 0) {
        return res.status(409).json({ error: `Cannot delete category with ${count} media items` });
      }
      await CategoryModel.delete(id);
      res.json({ message: 'Category deleted' });
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({ error: 'Cannot delete category with subcategories' });
      }
      throw err;
    }
  },

  async getAllSubcategories(req, res) {
    const subcategories = await SubcategoryModel.getAll();
    res.setHeader('Cache-Control', READ_CACHE_CONTROL);
    res.json(subcategories);
  },

  async getSubcategories(req, res) {
    const { category_id } = req.params;
    const subcategories = await SubcategoryModel.getByCategoryId(category_id);
    res.setHeader('Cache-Control', READ_CACHE_CONTROL);
    res.json(subcategories);
  },

  async deleteSubcategory(req, res) {
    const { id } = req.params;
    try {
      await SubcategoryModel.delete(id);
      res.json({ message: 'Subcategory deleted' });
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({ error: 'Cannot delete subcategory with media' });
      }
      throw err;
    }
  },

  async createSubcategory(req, res) {
    const { categoryId, name } = req.body;
    const category = await CategoryModel.getById(categoryId);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    try {
      const subcategory = await SubcategoryModel.create(categoryId, name);
      res.status(201).json(subcategory);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Subcategory already exists in this category' });
      }
      throw err;
    }
  },
};

module.exports = CategoryController;
