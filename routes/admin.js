const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { param, body } = require('express-validator');
const AdminController = require('../controllers/adminController');
const { uploadZip } = require('../controllers/zipUploadController');
const { adminLimiter, uploadLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');
const asyncHandler = require('../helpers/asyncHandler');
const env = require('../config/env');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
    filename: (req, file, cb) => cb(null, `restore-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are allowed'));
    }
  },
});

// Separate multer instance for ZIPs — bigger size limit (each file inside
// still enforced by zipUploadController against MAX_FILE_SIZE_MB), narrow
// mime filter.
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
    filename: (req, file, cb) => cb(null, `zip-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: (env.UPLOAD.MAX_FILE_SIZE_MB * env.UPLOAD.MAX_BATCH_FILES) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files are allowed'));
  },
});

router.use(adminLimiter);

router.get('/tokens', AdminController.getTokens);
router.post('/tokens', [
  body('type').isIn(['client', 'admin']).withMessage('type must be client or admin'),
  body('expires_at').optional({ nullable: true }).isISO8601().withMessage('expires_at must be ISO8601'),
  validate,
], AdminController.createToken);
router.put('/tokens/:id', [
  param('id').isInt().withMessage('id must be an integer'),
  body('is_active').optional().isBoolean().withMessage('is_active must be boolean'),
  body('expires_at').optional({ nullable: true }).isISO8601().withMessage('expires_at must be a date'),
  validate,
], AdminController.updateToken);
router.delete('/tokens/:id', [
  param('id').isInt().withMessage('id must be an integer'),
  validate,
], AdminController.deleteToken);
router.get('/media', AdminController.getMedia);
router.get('/stats', AdminController.getStats);
router.get('/backup', AdminController.backup);
router.post('/restore', upload.single('file'), AdminController.restore);
router.post('/find-duplicates', AdminController.findDuplicates);

// Mass ZIP upload — pipes through the same processFile pipeline as
// multipart. Progress fans out via SSE (zip.progress event).
router.post(
  '/upload-zip',
  uploadLimiter,
  zipUpload.single('archive'),
  asyncHandler(uploadZip),
);

module.exports = router;
