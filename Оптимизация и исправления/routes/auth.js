const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

router.post('/login', authLimiter, AuthController.login);
router.post('/logout', authLimiter, authenticateToken, AuthController.logout);

module.exports = router;
