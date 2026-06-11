const express = require('express');
const router = express.Router();
const FavoritesController = require('../controllers/favoritesController');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, FavoritesController.getAll);
router.post('/:media_id', authenticateToken, FavoritesController.add);
router.delete('/:media_id', authenticateToken, FavoritesController.remove);
router.get('/check/:media_id', authenticateToken, FavoritesController.check);

module.exports = router;
