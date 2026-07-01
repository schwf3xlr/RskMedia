const FavoritesModel = require('../models/favorites');
const { getSignedUrlForKey } = require('../config/s3');
const { SIGN_URL_EXPIRES, TYPE_SORT_MAP } = require('../config/constants');

const USE_PROXY = process.env.USE_MEDIA_PROXY !== 'false';

function proxyUrl(req, type, id) {
  return `${req.protocol}://${req.get('host')}/media/${type}/${id}`;
}

// "Фото" / "Видео" sort options are type filters - translate to `type`
// param + default sort (newest) for the filtered slice.
function resolveSortAndType(sort) {
  if (TYPE_SORT_MAP[sort]) {
    return { type: TYPE_SORT_MAP[sort], sort: 'newest' };
  }
  return { type: undefined, sort };
}

async function enrichFavorites(favorites, req) {
  return Promise.all(
    favorites.map(async (f) => {
      if (USE_PROXY) {
        const result = {
          ...f,
          url: proxyUrl(req, 'original', f.id),
          thumbnail_url: proxyUrl(req, 'thumb', f.id),
        };
        if (f.display_s3_key) {
          result.display_url = proxyUrl(req, 'display', f.id);
        }
        return result;
      }
      const result = {
        ...f,
        url: await getSignedUrlForKey(f.s3_key, SIGN_URL_EXPIRES),
        thumbnail_url: await getSignedUrlForKey(f.thumbnail_s3_key, SIGN_URL_EXPIRES),
      };
      if (f.display_s3_key) {
        result.display_url = await getSignedUrlForKey(f.display_s3_key, SIGN_URL_EXPIRES);
      }
      return result;
    })
  );
}

const FavoritesController = {
  async getAll(req, res) {
    const { category_id, subcategory_id, age, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const { type, sort: effectiveSort } = resolveSortAndType(sort);

    const favorites = await FavoritesModel.getByTokenIdWithCount(req.user.token_id, {
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      type,
      sort: effectiveSort,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = favorites.length > 0 ? parseInt(favorites[0].total_count, 10) : 0;
    const favoritesWithUrls = await enrichFavorites(favorites, req);

    res.json({
      media: favoritesWithUrls,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  },

  async add(req, res) {
    const { media_id } = req.params;
    try {
      const favorite = await FavoritesModel.add(req.user.token_id, media_id);
      if (!favorite) {
        return res.status(200).json({ message: 'Already in favorites' });
      }
      res.status(201).json({ message: 'Added to favorites', favorite });
    } catch (err) {
      // FK violation on media_id (23503) -> media doesn't exist
      if (err.code === '23503') {
        return res.status(404).json({ error: 'Media not found' });
      }
      throw err;
    }
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

  async batchCheck(req, res) {
    const { ids } = req.body;
    const result = await FavoritesModel.batchCheck(req.user.token_id, ids);
    res.json(result);
  },
};

module.exports = FavoritesController;
