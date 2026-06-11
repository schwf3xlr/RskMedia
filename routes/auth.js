const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { apiLimiter } = require('../middleware/rateLimiter');

router.post('/login', apiLimiter, AuthController.login);
router.post('/logout', apiLimiter, AuthController.logout);

module.exports = router;
