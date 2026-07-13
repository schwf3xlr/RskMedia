const path = require('path');
const archiver = require('archiver');
const CollectionModel = require('../models/collection');
const { TYPE_SORT_MAP } = require('../config/constants');
const { enrichMany } = require('../helpers/enrichUrls');
const { getObjectStream } = require('../config/s3');
const ApiError = require('../helpers/apiError');
const logger = require('../helpers/logger');
const env = require('../config/env');
const db = require('../config/database');

const USE_PROXY = env.USE_MEDIA_PROXY;

function proxyUrl(req, type, id) {
  return `${req.protocol}://${req.get('host')}/media/${type}/${id}`;
}

// Preview URL для превью-thumbnail'ов на карточке коллекции (не
// enrichOne, потому что там нет полного media row — только id + s3_key).
function previewThumbUrl(row, req, prefix) {
  const id = row[`${prefix}_media_id`];
  if (!id) return null;
  if (USE_PROXY) return proxyUrl(req, 'thumb', id);
  // Direct S3 не поддерживаем на preview (нет getSignedUrl без модели медиа);
  // деплой с USE_MEDIA_PROXY=false → thumbs просто не покажутся.
  return null;
}

// Sort-фильтры "Фото"/"Видео" в UI на самом деле трансформируются в type.
function resolveSortAndType(sort) {
  if (TYPE_SORT_MAP[sort]) return { type: TYPE_SORT_MAP[sort], sort: 'newest' };
  return { type: undefined, sort };
}

const MAX_NAME_LEN = 100;

const CollectionController = {
  async getAll(req, res) {
    const rows = await CollectionModel.getAllForToken(req.user.token_id);
    // Обогащаем каждую коллекцию URL'ами превью-миниатюр.
    const collections = rows.map(r => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      count: r.count,
      thumbs: [
        previewThumbUrl(r, req, 'thumb1'),
        previewThumbUrl(r, req, 'thumb2'),
        previewThumbUrl(r, req, 'thumb3'),
      ].filter(Boolean),
    }));
    res.json(collections);
  },

  async create(req, res) {
    const name = String(req.body.name || '').trim();
    if (!name) throw ApiError.badRequest('Название коллекции обязательно');
    if (name.length > MAX_NAME_LEN) throw ApiError.badRequest(`Название до ${MAX_NAME_LEN} символов`);
    try {
      const created = await CollectionModel.create(req.user.token_id, name);
      logger.info({ token_id: req.user.token_id, collection_id: created.id }, 'collection created');
      res.status(201).json(created);
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Коллекция с таким названием уже есть');
      throw err;
    }
  },

  async rename(req, res) {
    const { id } = req.params;
    const name = String(req.body.name || '').trim();
    if (!name) throw ApiError.badRequest('Название обязательно');
    if (name.length > MAX_NAME_LEN) throw ApiError.badRequest(`Название до ${MAX_NAME_LEN} символов`);
    try {
      const updated = await CollectionModel.rename(id, req.user.token_id, name);
      if (!updated) throw ApiError.notFound('Коллекция не найдена');
      res.json(updated);
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Коллекция с таким названием уже есть');
      throw err;
    }
  },

  async delete(req, res) {
    const { id } = req.params;
    const ok = await CollectionModel.delete(id, req.user.token_id);
    if (!ok) throw ApiError.notFound('Коллекция не найдена');
    res.json({ message: 'Коллекция удалена' });
  },

  async getOne(req, res) {
    const { id } = req.params;
    const c = await CollectionModel.getById(id, req.user.token_id);
    if (!c) throw ApiError.notFound('Коллекция не найдена');
    res.json(c);
  },

  async getMedia(req, res) {
    const { id } = req.params;
    const { category_id, subcategory_id, age, sort, random_seed, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const { type, sort: effectiveSort } = resolveSortAndType(sort);
    const seedNum = Number(random_seed);
    const seed = Number.isFinite(seedNum) ? Math.abs(seedNum) & 0x7fffffff : undefined;

    // Ownership check: если коллекция не наша, getById вернёт null.
    // getMediaWithCount повторяет проверку через JOIN col.token_id = $2,
    // но без явного 404 клиент получил бы пустой список и не понял бы,
    // почему.
    const owner = await CollectionModel.getById(id, req.user.token_id);
    if (!owner) throw ApiError.notFound('Коллекция не найдена');

    const media = await CollectionModel.getMediaWithCount(id, req.user.token_id, {
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      type,
      sort: effectiveSort,
      randomSeed: seed,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    const total = media.length > 0 ? parseInt(media[0].total_count, 10) : 0;
    const mediaWithUrls = await enrichMany(media, req);
    res.json({
      collection: { id: owner.id, name: owner.name, count: owner.count },
      media: mediaWithUrls,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  },

  async getFilters(req, res) {
    const { id } = req.params;
    const filters = await CollectionModel.getAvailableFilters(id, req.user.token_id);
    if (!filters) throw ApiError.notFound('Коллекция не найдена');
    res.json(filters);
  },

  async addItems(req, res) {
    const { id } = req.params;
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.filter(v => Number.isInteger(v) && v > 0)
      : (Number.isInteger(req.body.media_id) ? [req.body.media_id] : []);
    if (ids.length === 0) throw ApiError.badRequest('Не переданы media_id');
    try {
      const { added, notOwned } = await CollectionModel.addItems(id, req.user.token_id, ids);
      if (notOwned) throw ApiError.notFound('Коллекция не найдена');
      res.json({ added });
    } catch (err) {
      if (err.code === '23503') throw ApiError.badRequest('Одно или несколько медиа не существуют');
      throw err;
    }
  },

  async removeItems(req, res) {
    const { id } = req.params;
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter(v => Number.isInteger(v) && v > 0)
      : (req.params.media_id ? [Number(req.params.media_id)] : []);
    if (ids.length === 0) throw ApiError.badRequest('Не переданы media_id');
    const { removed, notOwned } = await CollectionModel.removeItems(id, req.user.token_id, ids);
    if (notOwned) throw ApiError.notFound('Коллекция не найдена');
    res.json({ removed });
  },

  // "В каких МОИХ коллекциях лежит это медиа" — для чекбоксов в модалке
  // при нажатии на "+".
  async getForMedia(req, res) {
    const mediaId = Number(req.params.media_id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) throw ApiError.badRequest('media_id');
    const rows = await CollectionModel.getContainingCollections(req.user.token_id, mediaId);
    res.json(rows);
  },

  // Экспорт коллекции как zip. Такая же логика, как у favorites.exportZip.
  async exportZip(req, res) {
    const { id } = req.params;
    const owner = await CollectionModel.getById(id, req.user.token_id);
    if (!owner) throw ApiError.notFound('Коллекция не найдена');

    const result = await db.query(
      `SELECT m.id, m.type, m.s3_key
       FROM collection_items ci JOIN media m ON m.id = ci.media_id
       WHERE ci.collection_id = $1
       ORDER BY ci.added_at DESC, m.id DESC`,
      [id]
    );

    const safeName = owner.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'collection';
    const filename = `rskmedia_${safeName}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 0 }, store: true });
    let clientGone = false;
    res.on('close', () => { clientGone = true; try { archive.destroy(); } catch {} });
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') logger.warn({ err }, 'collection export archive warning');
    });
    archive.on('error', (err) => {
      logger.error({ err }, 'collection export archive error');
      if (!res.headersSent) { try { res.status(500).end(); } catch {} }
      else { try { res.destroy(err); } catch {} }
    });
    archive.pipe(res);

    try {
      for (const row of result.rows) {
        if (clientGone) break;
        let body;
        try {
          const streamRes = await getObjectStream(row.s3_key);
          body = streamRes.body;
        } catch (err) {
          logger.warn({ err, id: row.id }, 'collection export s3 stream failed');
          continue;
        }
        body.on('error', (err) => {
          logger.warn({ err, id: row.id }, 'collection export item stream error');
          try { body.destroy(); } catch {}
        });
        const ext = path.extname(row.s3_key) || '';
        const name = `${row.id}_${path.basename(row.s3_key) || `media${ext}`}`;
        archive.append(body, { name });
      }
      if (!clientGone) await archive.finalize();
    } catch (err) {
      logger.debug({ err }, 'collection export finalize aborted');
      try { archive.destroy(); } catch {}
    }
  },
};

module.exports = CollectionController;
