const CategoryModel = require('../models/category');
const SubcategoryModel = require('../models/subcategory');

const CategoryController = {
  async getAll(req, res) {
    const categories = await CategoryModel.getAll();
    res.json(categories);
  },

  async create(req, res) {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const category = await CategoryModel.create(name);
    res.status(201).json(category);
  },

  async update(req, res) {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const category = await CategoryModel.update(id, name);
    res.json(category);
  },

  async delete(req, res) {
    const { id } = req.params;
    await CategoryModel.delete(id);
    res.json({ message: 'Category deleted' });
  },

  async getAllSubcategories(req, res) {
    const subcategories = await SubcategoryModel.getAll();
    res.json(subcategories);
  },

  async getSubcategories(req, res) {
    const { category_id } = req.params;
    const subcategories = await SubcategoryModel.getByCategoryId(category_id);
    res.json(subcategories);
  },

  async createSubcategory(req, res) {
    const { categoryId, name } = req.body;
    if (!categoryId || !name) return res.status(400).json({ error: 'Category ID and name are required' });
    const subcategory = await SubcategoryModel.create(categoryId, name);
    res.status(201).json(subcategory);
  },
};

module.exports = CategoryController;
