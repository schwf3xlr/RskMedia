const express = require('express');
const router = express.Router();
const CategoryController = require('../controllers/categoryController');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

router.get('/', authenticateToken, CategoryController.getAll);
router.get('/subcategories', authenticateToken, CategoryController.getAllSubcategories);
router.get('/subcategories/:category_id', authenticateToken, CategoryController.getSubcategories);
router.post('/', authenticateToken, requireAdmin, CategoryController.create);
router.post('/subcategories', authenticateToken, requireAdmin, CategoryController.createSubcategory);
router.put('/:id', authenticateToken, requireAdmin, CategoryController.update);
router.delete('/:id', authenticateToken, requireAdmin, CategoryController.delete);

module.exports = router;
