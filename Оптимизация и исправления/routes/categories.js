const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const CategoryController = require('../controllers/categoryController');
const { requireAdmin } = require('../middleware/admin');
const { validate } = require('../middleware/validate');

router.get('/', CategoryController.getAll);
router.get('/subcategories', CategoryController.getAllSubcategories);
router.get('/subcategories/:category_id', [
  param('category_id').isInt().withMessage('category_id must be an integer'),
  validate,
], CategoryController.getSubcategories);
router.post('/', requireAdmin, [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  validate,
], CategoryController.create);
router.post('/subcategories', requireAdmin, [
  body('categoryId').isInt().withMessage('categoryId must be an integer'),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  validate,
], CategoryController.createSubcategory);
router.put('/:id', requireAdmin, [
  param('id').isInt().withMessage('id must be an integer'),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  validate,
], CategoryController.update);
router.delete('/:id', requireAdmin, [
  param('id').isInt().withMessage('id must be an integer'),
  validate,
], CategoryController.delete);
router.delete('/subcategories/:id', requireAdmin, [
  param('id').isInt().withMessage('id must be an integer'),
  validate,
], CategoryController.deleteSubcategory);

module.exports = router;
