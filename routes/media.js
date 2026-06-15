const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const MediaController = require('../controllers/mediaController');
const { requireAdmin } = require('../middleware/admin');
const { uploadLimiter } = require('../middleware/rateLimiter');

const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024;
const MAX_PHOTO_SIZE = (parseInt(process.env.MAX_PHOTO_SIZE_MB, 10) || 50) * 1024 * 1024;
const MAX_VIDEO_SIZE = (parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 500) * 1024 * 1024;
const MAX_BATCH_FILES = parseInt(process.env.MAX_BATCH_FILES, 10) || 100;

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

    const isImage = file.mimetype.startsWith('image/');
    const maxSize = isImage ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE;
    if (parseInt(req.headers['content-length'], 10) > maxSize) {
      return cb(new Error(`File too large. Max ${isImage ? 'photo' : 'video'} size: ${maxSize / 1024 / 1024} MB`));
    }

    cb(null, true);
  },
});

router.get('/', MediaController.getAll);
router.get('/search', MediaController.search);
router.get('/:id', MediaController.getById);
router.post('/upload/single', requireAdmin, uploadLimiter, upload.single('file'), MediaController.uploadSingle);
router.post('/upload/multiple', requireAdmin, uploadLimiter, upload.array('files', MAX_BATCH_FILES), MediaController.uploadMultiple);
router.put('/batch-update', requireAdmin, MediaController.batchUpdate);
router.post('/batch-delete', requireAdmin, MediaController.batchDelete);
router.delete('/:id', requireAdmin, MediaController.delete);

module.exports = router;
