const FavoritesModel = require('../models/favorites');
const { getSignedUrlForKey } = require('../config/s3');

const FavoritesController = {
  async getAll(req, res) {
    const { category_id, subcategory_id, age, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const favorites = await FavoritesModel.getByTokenId(req.user.token_id, {
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      sort,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const favoritesWithUrls = await Promise.all(
      favorites.map(async (f) => ({
        ...f,
        url: await getSignedUrlForKey(f.s3_key),
        thumbnail_url: await getSignedUrlForKey(f.thumbnail_s3_key),
      }))
    );

    res.json(favoritesWithUrls);
  },

  async add(req, res) {
    const { media_id } = req.params;
    const favorite = await FavoritesModel.add(req.user.token_id, media_id);
    res.status(201).json({ message: 'Added to favorites', favorite });
  },

  async remove(req, res) {
    const { media_id } = req.params;
    await FavoritesModel.remove(req.user.token_id, media_id);
    res.json({ message: 'Removed from favorites' });
  },

  async check(req, res) {
    const { media_id } = req.params;
    const isFav = await FavoritesModel.isFavorite(req.user.token_id, media_id);
    res.json({ isFavorite: isFav });
  },
};

module.exports = FavoritesController;
