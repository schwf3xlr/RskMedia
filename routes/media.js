const express = require('express');
const router = express.Router();
const multer = require('multer');
const MediaController = require('../controllers/mediaController');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { uploadLimiter } = require('../middleware/rateLimiter');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

router.get('/', authenticateToken, MediaController.getAll);
router.get('/:id', authenticateToken, MediaController.getById);
router.post('/upload/single', authenticateToken, requireAdmin, uploadLimiter, upload.single('file'), MediaController.uploadSingle);
router.post('/upload/multiple', authenticateToken, requireAdmin, uploadLimiter, upload.array('files', 200), MediaController.uploadMultiple);
router.put('/batch-update', authenticateToken, requireAdmin, MediaController.batchUpdate);
router.post('/batch-delete', authenticateToken, requireAdmin, MediaController.batchDelete);
router.delete('/:id', authenticateToken, requireAdmin, MediaController.delete);

module.exports = router;
