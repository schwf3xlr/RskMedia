const crypto = require('crypto');
const sharp = require('sharp');
const fs = require('fs').promises;
const UserModel = require('../models/user');
const MediaModel = require('../models/media');
const { getSignedUrlForKey, getObjectBuffer } = require('../config/s3');
const { SIGN_URL_EXPIRES } = require('../config/constants');
const db = require('../config/database');

const BACKUP_TABLES = ['categories', 'subcategories', 'tokens', 'media', 'favorites'];
const BACKUP_SENSITIVE_COLUMNS = {
  tokens: ['jwt_hash'],
};

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
    res.status(201).json({ ...newToken, token });
  },

  async updateToken(req, res) {
    const { id } = req.params;
    const tokenId = parseInt(id, 10);
    if (tokenId === req.user.token_id) {
      return res.status(403).json({ error: 'Нельзя изменить текущий токен' });
    }

    const { is_active, expires_at } = req.body;
    const updates = {};
    if (is_active !== undefined) updates.is_active = is_active;
    if (expires_at !== undefined) updates.expires_at = expires_at || null;

    const token = await UserModel.updateToken(id, updates);
    res.json(token);
  },

  async deleteToken(req, res) {
    const { id } = req.params;
    const tokenId = parseInt(id, 10);
    if (tokenId === req.user.token_id) {
      return res.status(403).json({ error: 'Нельзя удалить текущий токен' });
    }
    await UserModel.deleteToken(tokenId);
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
        url: await getSignedUrlForKey(m.s3_key, SIGN_URL_EXPIRES),
        thumbnail_url: await getSignedUrlForKey(m.thumbnail_s3_key, SIGN_URL_EXPIRES),
      }))
    );

    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async backup(req, res) {
    const filename = `rskmedia_backup_${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('{');

    for (let i = 0; i < BACKUP_TABLES.length; i++) {
      const table = BACKUP_TABLES[i];
      const sensitive = BACKUP_SENSITIVE_COLUMNS[table] || [];
      const columns = (await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      )).rows.map(r => r.column_name).filter(c => !sensitive.includes(c));
      const colList = columns.length > 0 ? columns.join(', ') : '*';
      const result = await db.query(`SELECT ${colList} FROM ${table} ORDER BY id`);
      res.write(`${i === 0 ? '' : ','}"${table}":${JSON.stringify(result.rows)}`);
    }

    res.write('}');
    res.end();
  },

  async restore(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const filePath = req.file.path;
    let data;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(content);
    } catch {
      await cleanup(filePath);
      return res.status(400).json({ error: 'Неверный формат файла. Ожидается JSON' });
    } finally {
      await cleanup(filePath);
    }

    const client = await db.pool.connect();
    try {
      const tableColumns = {};
      for (const table of BACKUP_TABLES) {
        const colResult = await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [table]
        );
        tableColumns[table] = colResult.rows.map(r => r.column_name);
      }

      // Validate top-level structure
      for (const table of BACKUP_TABLES) {
        if (!Array.isArray(data[table])) {
          return res.status(400).json({ error: `Отсутствуют данные для таблицы ${table}` });
        }
      }
      const unknownTables = Object.keys(data).filter(t => !BACKUP_TABLES.includes(t));
      if (unknownTables.length > 0) {
        return res.status(400).json({ error: `Неизвестные таблицы в бэкапе: ${unknownTables.join(', ')}` });
      }

      // Validate each row
      const validators = {
        categories: {
          required: ['name'],
          allowed: ['id', 'name', 'created_at'],
          types: { id: 'int', name: 'string', created_at: 'datetime' },
        },
        subcategories: {
          required: ['category_id', 'name'],
          allowed: ['id', 'category_id', 'name', 'created_at'],
          types: { id: 'int', category_id: 'int', name: 'string', created_at: 'datetime' },
        },
        tokens: {
          required: ['token_hash', 'type'],
          allowed: ['id', 'token_hash', 'type', 'created_at', 'expires_at', 'is_active'],
          types: { id: 'int', token_hash: 'string', type: 'enum:client,admin', created_at: 'datetime', expires_at: 'datetime', is_active: 'bool' },
        },
        media: {
          required: ['type', 's3_key', 'thumbnail_s3_key'],
          allowed: ['id', 'type', 's3_key', 'thumbnail_s3_key', 'display_s3_key', 'category_id', 'subcategory_id', 'age_rating', 'phash', 'uploaded_at'],
          types: { id: 'int', type: 'enum:photo,video', s3_key: 'string', thumbnail_s3_key: 'string', display_s3_key: 'string', category_id: 'int', subcategory_id: 'int', age_rating: 'int', phash: 'string', uploaded_at: 'datetime' },
        },
        favorites: {
          required: ['token_id', 'media_id'],
          allowed: ['id', 'token_id', 'media_id', 'added_at'],
          types: { id: 'int', token_id: 'int', media_id: 'int', added_at: 'datetime' },
        },
      };

      const validateValue = (value, type) => {
        if (value === null || value === undefined) return true;
        if (type.startsWith('enum:')) {
          const allowed = type.split(':')[1].split(',');
          return allowed.includes(value);
        }
        switch (type) {
          case 'int': return Number.isInteger(Number(value)) && !isNaN(value);
          case 'string': return typeof value === 'string';
          case 'bool': return typeof value === 'boolean';
          case 'datetime': return !isNaN(Date.parse(value));
          default: return true;
        }
      };

      for (const table of BACKUP_TABLES) {
        const rules = validators[table];
        const existingColumns = tableColumns[table];
        for (let i = 0; i < data[table].length; i++) {
          const row = data[table][i];
          if (row === null || typeof row !== 'object') {
            return res.status(400).json({ error: `Строка ${i} в таблице ${table} не является объектом` });
          }
          const rowColumns = Object.keys(row);
          const unexpected = rowColumns.filter(c => !rules.allowed.includes(c) || !existingColumns.includes(c));
          if (unexpected.length > 0) {
            return res.status(400).json({ error: `Таблица ${table}, строка ${i}: неизвестные колонки ${unexpected.join(', ')}` });
          }
          for (const reqField of rules.required) {
            if (row[reqField] === undefined || row[reqField] === null || row[reqField] === '') {
              return res.status(400).json({ error: `Таблица ${table}, строка ${i}: отсутствует обязательное поле ${reqField}` });
            }
          }
          for (const [col, value] of Object.entries(row)) {
            const type = rules.types[col];
            if (type && !validateValue(value, type)) {
              return res.status(400).json({ error: `Таблица ${table}, строка ${i}: неверное значение для ${col}` });
            }
          }
        }
      }

      await client.query('BEGIN');
      await client.query('TRUNCATE TABLE favorites, media, subcategories, categories, tokens CASCADE');

      const insertOrder = ['categories', 'tokens', 'subcategories', 'media', 'favorites'];
      for (const table of insertOrder) {
        const rows = data[table];
        if (rows.length === 0) continue;

        const existingColumns = tableColumns[table];
        const rules = validators[table];
        const columns = Object.keys(rows[0]).filter(c => rules.allowed.includes(c) && existingColumns.includes(c));
        if (columns.length === 0) continue;

        const colNames = columns.join(', ');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const insertQuery = `INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`;

        for (const row of rows) {
          const values = columns.map(c => row[c]);
          await client.query(insertQuery, values);
        }

        const seqName = await client.query(
          `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
          [table]
        );
        if (seqName.rows[0]?.seq) {
          await client.query(
            `SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${table}), 1))`,
            [seqName.rows[0].seq]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ message: 'База данных успешно восстановлена' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
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

      const threshold = 10;
      const itemHashes = allHashed.rows.map(item => ({
        ...item,
        hash: BigInt(item.phash_str),
      }));

      // Locality-sensitive hashing: group by 16-bit segments to reduce comparisons
      const buckets = new Map();
      for (const item of itemHashes) {
        for (let shift = 0; shift < 4; shift++) {
          const segment = Number((item.hash >> BigInt(shift * 16)) & 0xFFFFn);
          const key = `${shift}:${segment}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(item);
        }
      }

      const visited = new Set();
      const groups = [];
      for (const bucketItems of buckets.values()) {
        if (bucketItems.length < 2) continue;
        for (let i = 0; i < bucketItems.length; i++) {
          const item = bucketItems[i];
          if (visited.has(item.id)) continue;
          const group = [item];
          visited.add(item.id);
          for (let j = i + 1; j < bucketItems.length; j++) {
            const candidate = bucketItems[j];
            if (visited.has(candidate.id)) continue;
            if (hammingDistance(item.hash, candidate.hash) <= threshold) {
              group.push(candidate);
              visited.add(candidate.id);
            }
          }
          if (group.length > 1) {
            groups.push(group);
          }
        }
      }

      const result = await Promise.all(
        groups.map(async (group) => {
          const items = await Promise.all(
            group.map(async (item) => ({
              id: item.id,
              type: item.type,
              age_rating: item.age_rating,
              url: await getSignedUrlForKey(item.s3_key, SIGN_URL_EXPIRES),
              thumbnail_url: await getSignedUrlForKey(item.thumbnail_s3_key, SIGN_URL_EXPIRES),
            }))
          );
          return { items };
        })
      );

      const totalDuplicates = result.reduce((s, g) => s + g.items.length, 0);
      res.json({ groups: result, totalDuplicates });
    } catch (err) {
      console.error('findDuplicates error:', err);
      res.status(500).json({ error: 'Ошибка поиска дубликатов' });
    }
  },
};

async function cleanup(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

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
