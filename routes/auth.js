const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const AuthController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');

router.post('/login', authLimiter, [
  // Length + charset shape check. Full format check ("client_" / "admin_"
  // prefix + hex tail) is done in the controller because the error message
  // there is user-facing.
  body('token').isString().isLength({ min: 6, max: 128 }).withMessage('Invalid token'),
  validate,
], AuthController.login);
router.post('/logout', authLimiter, authenticateToken, AuthController.logout);

module.exports = router;
