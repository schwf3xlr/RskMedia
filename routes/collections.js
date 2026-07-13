const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const CollectionController = require('../controllers/collectionController');
const { validate } = require('../middleware/validate');
const asyncHandler = require('../helpers/asyncHandler');

const idParam = [param('id').isInt({ min: 1 }).withMessage('id должен быть положительным целым'), validate];
const idsBody = [
  body('ids').isArray({ min: 1, max: 1000 }).withMessage('ids должен быть массивом 1..1000'),
  body('ids.*').isInt({ min: 1 }).withMessage('каждый id — положительное целое'),
  validate,
];
const nameBody = [
  body('name').isString().trim().isLength({ min: 1, max: 100 })
    .withMessage('Название 1..100 символов'),
  validate,
];

router.get('/', asyncHandler(CollectionController.getAll));
router.post('/', nameBody, asyncHandler(CollectionController.create));

router.get('/for-media/:media_id', [
  param('media_id').isInt({ min: 1 }).withMessage('media_id'),
  validate,
], asyncHandler(CollectionController.getForMedia));

router.get('/:id', idParam, asyncHandler(CollectionController.getOne));
router.put('/:id', idParam, nameBody, asyncHandler(CollectionController.rename));
router.delete('/:id', idParam, asyncHandler(CollectionController.delete));

router.get('/:id/media', idParam, asyncHandler(CollectionController.getMedia));
router.get('/:id/filters', idParam, asyncHandler(CollectionController.getFilters));
router.get('/:id/export', idParam, asyncHandler(CollectionController.exportZip));

router.post('/:id/items', idParam, asyncHandler(CollectionController.addItems));
// batch-remove — POST/DELETE с телом; используем POST чтобы body не терялся
// в некоторых прокси (некоторые режут body у DELETE).
router.post('/:id/items/batch-remove', idParam, idsBody, asyncHandler(CollectionController.removeItems));
router.delete('/:id/items/:media_id', [
  ...idParam,
  param('media_id').isInt({ min: 1 }).withMessage('media_id'),
  validate,
], asyncHandler(CollectionController.removeItems));

module.exports = router;
