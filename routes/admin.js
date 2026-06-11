const express = require('express');
const router = express.Router();
const multer = require('multer');
const AdminController = require('../controllers/adminController');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get('/tokens', authenticateToken, requireAdmin, AdminController.getTokens);
router.post('/tokens', authenticateToken, requireAdmin, AdminController.createToken);
router.put('/tokens/:id', authenticateToken, requireAdmin, AdminController.updateToken);
router.delete('/tokens/:id', authenticateToken, requireAdmin, AdminController.deleteToken);
router.get('/media', authenticateToken, requireAdmin, AdminController.getMedia);
router.get('/backup', authenticateToken, requireAdmin, AdminController.backup);
router.post('/restore', authenticateToken, requireAdmin, upload.single('file'), AdminController.restore);

module.exports = router;
