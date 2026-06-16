const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { param, body } = require('express-validator');
const AdminController = require('../controllers/adminController');
const { adminLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');

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

router.use(adminLimiter);

router.get('/tokens', AdminController.getTokens);
router.post('/tokens', AdminController.createToken);
router.put('/tokens/:id', [
  param('id').isInt().withMessage('id must be an integer'),
  body('is_active').optional().isBoolean().withMessage('is_active must be boolean'),
  body('expires_at').optional({ nullable: true }).isISO8601().withMessage('expires_at must be a date'),
  validate,
], AdminController.updateToken);
router.delete('/tokens/:id', AdminController.deleteToken);
router.get('/media', AdminController.getMedia);
router.get('/backup', AdminController.backup);
router.post('/restore', upload.single('file'), AdminController.restore);
router.post('/find-duplicates', AdminController.findDuplicates);

module.exports = router;
