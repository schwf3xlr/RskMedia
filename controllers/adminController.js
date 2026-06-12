const crypto = require('crypto');
const sharp = require('sharp');
const UserModel = require('../models/user');
const MediaModel = require('../models/media');
const { getSignedUrlForKey, getObjectBuffer } = require('../config/s3');
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
  async findDuplicates(req, res) {
    try {
      await db.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'media' AND column_name = 'phash'
          ) THEN
            ALTER TABLE media ADD COLUMN phash NUMERIC(20, 0);
          ELSE
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'media' AND column_name = 'phash' AND data_type = 'bigint'
            ) THEN
              ALTER TABLE media ALTER COLUMN phash TYPE NUMERIC(20, 0);
            END IF;
          END IF;
        END $$;
      `);

      const nullHash = await db.query(
        'SELECT id, type, s3_key, thumbnail_s3_key FROM media WHERE phash IS NULL'
      );

      if (nullHash.rows.length > 0) {
        for (const row of nullHash.rows) {
          try {
            const buf = await getObjectBuffer(row.thumbnail_s3_key);
            const hash = await computeDHash(buf);
            await db.query('UPDATE media SET phash = $1 WHERE id = $2', [hash.toString(), row.id]);
          } catch (err) {
            console.error(`Failed to compute hash for media ${row.id}:`, err.message);
          }
        }
      }

      const allHashed = await db.query(
        'SELECT id, type, s3_key, thumbnail_s3_key, age_rating, phash::TEXT AS phash_str FROM media WHERE phash IS NOT NULL ORDER BY uploaded_at DESC'
      );

      const groups = [];
      const threshold = 10;

      for (const item of allHashed.rows) {
        const hash = BigInt(item.phash_str);
        let added = false;
        for (const group of groups) {
          if (hammingDistance(hash, group.rep) < threshold) {
            group.items.push(item);
            added = true;
            break;
          }
        }
        if (!added) {
          groups.push({ rep: hash, items: [item] });
        }
      }

      const duplicateGroups = groups.filter(g => g.items.length > 1);

      const result = await Promise.all(
        duplicateGroups.map(async (group) => {
          const items = await Promise.all(
            group.items.map(async (item) => ({
              id: item.id,
              type: item.type,
              age_rating: item.age_rating,
              url: await getSignedUrlForKey(item.s3_key),
              thumbnail_url: await getSignedUrlForKey(item.thumbnail_s3_key),
            }))
          );
          return { items };
        })
      );

      res.json({ groups: result, totalDuplicates: result.reduce((s, g) => s + g.length, 0) });
    } catch (err) {
      console.error('findDuplicates error:', err);
      res.status(500).json({ error: 'Ошибка поиска дубликатов' });
    }
  },
};

async function computeDHash(buffer) {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      if (left > right) {
        hash |= (1n << BigInt(y * 8 + x));
      }
    }
  }
  return hash;
}

function hammingDistance(a, b) {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

module.exports = AdminController;
