const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { body, param } = require('express-validator');
const MediaController = require('../controllers/mediaController');
const { requireAdmin } = require('../middleware/admin');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');
const env = require('../config/env');

const MAX_FILE_SIZE = env.UPLOAD.MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_BATCH_FILES = env.UPLOAD.MAX_BATCH_FILES;

const allowedTypes = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_BATCH_FILES,
  },
  fileFilter: (req, file, cb) => {
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Allowed: JPG, PNG, GIF, WEBP, MP4, WEBM, MOV'));
    }
    cb(null, true);
  },
});

const idsBody = [
  body('ids').isArray({ min: 1, max: 1000 }).withMessage('ids must be array of 1..1000 ids'),
  body('ids.*').isInt({ min: 1 }).withMessage('each id must be a positive integer'),
];
const optMetadata = [
  body('category_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('category_id must be positive int'),
  body('subcategory_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('subcategory_id must be positive int'),
  body('age_rating').optional({ nullable: true }).isInt({ min: 0, max: 21 }).withMessage('age_rating must be 0..21'),
];

router.get('/', MediaController.getAll);
router.get('/:id', [param('id').isInt().withMessage('id must be int'), validate], MediaController.getById);
router.post('/upload/single', requireAdmin, uploadLimiter, upload.single('file'), MediaController.uploadSingle);
router.post('/upload/multiple', requireAdmin, uploadLimiter, upload.array('files', MAX_BATCH_FILES), MediaController.uploadMultiple);
router.put('/batch-update', requireAdmin, [...idsBody, ...optMetadata, validate], MediaController.batchUpdate);
router.post('/batch-delete', requireAdmin, [...idsBody, validate], MediaController.batchDelete);
router.delete('/:id', requireAdmin, [param('id').isInt().withMessage('id must be int'), validate], MediaController.delete);

module.exports = router;
