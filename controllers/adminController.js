const crypto = require('crypto');
const UserModel = require('../models/user');
const MediaModel = require('../models/media');
const { getSignedUrlForKey } = require('../config/s3');
const db = require('../config/database');

const BACKUP_TABLES = ['categories', 'subcategories', 'tokens', 'media', 'favorites'];

const AdminController = {
  async getTokens(req, res) {
    const tokens = await UserModel.getAllTokens();
    res.json(tokens);
  },

  async createToken(req, res) {
    const { type, expires_at } = req.body;
    if (!type || !['client', 'admin'].includes(type)) {
      return res.status(400).json({ error: 'Invalid token type' });
    }

    const randomPart = crypto.randomBytes(16).toString('hex');
    const token = `${type}_${randomPart}`;
    const expiresAt = expires_at || null;

    const newToken = await UserModel.createToken(token, type, expiresAt);
    res.status(201).json(newToken);
  },

  async updateToken(req, res) {
    const { id } = req.params;
    const { is_active } = req.body;
    const updates = {};
    if (is_active !== undefined) updates.is_active = is_active;

    const token = await UserModel.updateToken(id, updates);
    res.json(token);
  },

  async deleteToken(req, res) {
    const { id } = req.params;
    await UserModel.deleteToken(id);
    res.json({ message: 'Токен удалён' });
  },

  async getMedia(req, res) {
    const { page = 1, limit = 50, missing } = req.query;
    const offset = (page - 1) * limit;

    const missingFields = missing
      ? missing.split(',').map(f => f.trim()).filter(f => ['category_id', 'subcategory_id', 'age_rating'].includes(f))
      : undefined;

    const media = await MediaModel.getAll({
      missingFields,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await MediaModel.getTotalCount({ missingFields });

    const mediaWithUrls = await Promise.all(
      media.map(async (m) => ({
        ...m,
        url: await getSignedUrlForKey(m.s3_key),
        thumbnail_url: await getSignedUrlForKey(m.thumbnail_s3_key),
      }))
    );

    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async backup(req, res) {
    const data = {};
    for (const table of BACKUP_TABLES) {
      const result = await db.query(`SELECT * FROM ${table} ORDER BY id`);
      data[table] = result.rows;
    }

    const filename = `rskmedia_backup_${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(data);
  },

  async restore(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    let data;
    try {
      data = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      return res.status(400).json({ error: 'Неверный формат файла. Ожидается JSON' });
    }

    for (const table of BACKUP_TABLES) {
      if (!Array.isArray(data[table])) {
        return res.status(400).json({ error: `Отсутствуют данные для таблицы ${table}` });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query('TRUNCATE TABLE favorites, media, subcategories, categories, tokens CASCADE');

      const insertOrder = ['categories', 'tokens', 'subcategories', 'media', 'favorites'];
      for (const table of insertOrder) {
        const rows = data[table];
        if (rows.length === 0) continue;

        const columns = Object.keys(rows[0]);
        const colNames = columns.join(', ');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

        for (const row of rows) {
          const values = columns.map(c => row[c]);
          await client.query(
            `INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`,
            values
          );
        }

        const seqResult = await client.query(
          `SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 1))`
        );
      }

      await client.query('COMMIT');
      res.json({ message: 'База данных успешно восстановлена' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Restore error:', err);
      res.status(500).json({ error: 'Ошибка восстановления базы данных' });
    } finally {
      client.release();
    }
  },
};

module.exports = AdminController;
