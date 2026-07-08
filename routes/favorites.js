const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const FavoritesController = require('../controllers/favoritesController');
const { validate } = require('../middleware/validate');

router.get('/', FavoritesController.getAll);
router.get('/export', FavoritesController.exportZip);
router.post('/batch-check', [
  body('ids').isArray({ min: 1, max: 500 }).withMessage('ids must be an array'),
  body('ids.*').isInt().withMessage('Each id must be an integer'),
  validate,
], FavoritesController.batchCheck);
router.post('/:media_id', [
  param('media_id').isInt().withMessage('media_id must be an integer'),
  validate,
], FavoritesController.add);
router.delete('/:media_id', [
  param('media_id').isInt().withMessage('media_id must be an integer'),
  validate,
], FavoritesController.remove);
router.get('/check/:media_id', [
  param('media_id').isInt().withMessage('media_id must be an integer'),
  validate,
], FavoritesController.check);

module.exports = router;
