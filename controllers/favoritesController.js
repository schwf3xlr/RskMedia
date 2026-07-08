const path = require('path');
const archiver = require('archiver');
const FavoritesModel = require('../models/favorites');
const { TYPE_SORT_MAP } = require('../config/constants');
const { enrichMany } = require('../helpers/enrichUrls');
const { getObjectStream } = require('../config/s3');
const logger = require('../helpers/logger');
const db = require('../config/database');

// "Фото" / "Видео" sort options are type filters - translate to `type`
// param + default sort (newest) for the filtered slice.
function resolveSortAndType(sort) {
  if (TYPE_SORT_MAP[sort]) {
    return { type: TYPE_SORT_MAP[sort], sort: 'newest' };
  }
  return { type: undefined, sort };
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
    const favoritesWithUrls = await enrichMany(favorites, req);

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

  async exportZip(req, res) {
    // Stream a zip built on-the-fly. archiver pipes to res so we never buffer
    // the whole archive in memory — 500 favorites at ~3 MB each = 1.5 GB
    // that we're not holding. Compression level 0 (store) because the files
    // are already compressed formats (JPEG/PNG/WebP/MP4) — deflate on them
    // wastes CPU for near-zero size reduction.
    const result = await db.query(
      `SELECT m.id, m.type, m.s3_key
       FROM favorites f
       JOIN media m ON f.media_id = m.id
       WHERE f.token_id = $1
       ORDER BY f.added_at DESC`,
      [req.user.token_id]
    );

    const filename = `rskmedia_favorites_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 0 }, store: true });
    archive.on('error', (err) => {
      logger.error({ err }, 'favorites export archive error');
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    // If the client bails mid-download, kill the archive stream to release
    // its file handles/S3 streams promptly.
    res.on('close', () => archive.destroy());

    archive.pipe(res);

    for (const row of result.rows) {
      try {
        const { body, contentType } = await getObjectStream(row.s3_key);
        const ext = path.extname(row.s3_key) || '';
        // Prefix with id to guarantee uniqueness even when two favorites
        // share a filename (uuids are the s3 key already).
        const name = `${row.id}_${path.basename(row.s3_key) || `media${ext}`}`;
        archive.append(body, { name });
      } catch (err) {
        logger.warn({ err, id: row.id }, 'favorites export skipped item');
      }
    }
    await archive.finalize();
  },
};

module.exports = FavoritesController;
