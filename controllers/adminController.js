const crypto = require('crypto');
const sharp = require('sharp');
const fs = require('fs').promises;
const UserModel = require('../models/user');
const MediaModel = require('../models/media');
const { getSignedUrlForKey, getObjectBuffer } = require('../config/s3');
const { SIGN_URL_EXPIRES } = require('../config/constants');
const { enrichMany } = require('../helpers/enrichUrls');
const { invalidateAuthCache } = require('../middleware/auth');
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
    invalidateAuthCache(tokenId);
    res.json(token);
  },

  async deleteToken(req, res) {
    const { id } = req.params;
    const tokenId = parseInt(id, 10);
    if (tokenId === req.user.token_id) {
      return res.status(403).json({ error: 'Нельзя удалить текущий токен' });
    }
    await UserModel.deleteToken(tokenId);
    invalidateAuthCache(tokenId);
    res.json({ message: 'Токен удалён' });
  },

  async getMedia(req, res) {
    const { page = 1, limit = 50, missing } = req.query;
    const offset = (page - 1) * limit;

    const missingFields = missing
      ? missing.split(',').map(f => f.trim()).filter(f => ['category_id', 'subcategory_id', 'age_rating'].includes(f))
      : undefined;

    const media = await MediaModel.getAllWithCount({
      missingFields,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = media.length > 0 ? parseInt(media[0].total_count, 10) : 0;
    const mediaWithUrls = await enrichMany(media, req);

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
    // Advisory lock — key 1 is reserved for the restore operation. Two admins
    // clicking "Restore" simultaneously would otherwise race on TRUNCATE +
    // INSERT and produce a mixed final state. pg_try_advisory_lock() returns
    // false immediately if held; the lock is auto-released when the session
    // (this client) is released back to the pool.
    let restoreLockHeld = false;
    try {
      const lockResult = await client.query('SELECT pg_try_advisory_lock(1) AS locked');
      if (!lockResult.rows[0].locked) {
        return res.status(409).json({ error: 'Восстановление уже выполняется' });
      }
      restoreLockHeld = true;
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
          allowed: ['id', 'type', 's3_key', 'thumbnail_s3_key', 'display_s3_key', 'file_size', 'category_id', 'subcategory_id', 'age_rating', 'phash', 'uploaded_at'],
          types: { id: 'int', type: 'enum:photo,video', s3_key: 'string', thumbnail_s3_key: 'string', display_s3_key: 'string', file_size: 'int', category_id: 'int', subcategory_id: 'int', age_rating: 'int', phash: 'string', uploaded_at: 'datetime' },
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

        // Bulk-insert in chunks. A single INSERT with N rows is one round
        // trip; the old per-row loop was ~10s per 10K media on a warm
        // connection. PostgreSQL limits placeholders to 65535, and chunks
        // of 200 rows keep prepared-statement caching hot without blowing
        // the client-side memory when a wide row (media) has ~11 columns.
        const CHUNK = 200;
        const colNames = columns.join(', ');
        for (let start = 0; start < rows.length; start += CHUNK) {
          const chunk = rows.slice(start, start + CHUNK);
          const values = [];
          const placeholders = chunk.map((row, r) => {
            const rowPh = columns.map((c, i) => {
              values.push(row[c]);
              return `$${r * columns.length + i + 1}`;
            });
            return `(${rowPh.join(', ')})`;
          }).join(', ');
          await client.query(
            `INSERT INTO ${table} (${colNames}) VALUES ${placeholders}`,
            values
          );
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
      if (restoreLockHeld) {
        await client.query('SELECT pg_advisory_unlock(1)').catch(() => {});
      }
      client.release();
    }
  },

  async getStats(req, res) {
    try {
      // Total and average by type
      const typeStats = await db.query(`
        SELECT
          type,
          COUNT(*) as count,
          ROUND(AVG(file_size)) as avg_size,
          COALESCE(SUM(file_size), 0) as total_size
        FROM media
        GROUP BY type
      `);

      // Age rating distribution
      const ageStats = await db.query(`
        SELECT
          COALESCE(age_rating::text, 'Не указан') as age,
          COUNT(*) as count
        FROM media
        GROUP BY age_rating
        ORDER BY age_rating NULLS FIRST
      `);

      // Category / subcategory distribution
      const categoryStats = await db.query(`
        SELECT
          c.name as category,
          COALESCE(s.name, 'Без подкатегории') as subcategory,
          COUNT(m.id) as count
        FROM media m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN subcategories s ON m.subcategory_id = s.id
        GROUP BY c.name, s.name
        ORDER BY c.name, s.name
      `);

      // Missing metadata
      const missingMetadata = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE category_id IS NULL) as missing_category,
          COUNT(*) FILTER (WHERE subcategory_id IS NULL) as missing_subcategory,
          COUNT(*) FILTER (WHERE age_rating IS NULL) as missing_age
        FROM media
      `);

      // Missing processing
      const missingProcessing = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE thumbnail_s3_key IS NULL OR thumbnail_s3_key = '') as missing_thumbnail,
          COUNT(*) FILTER (WHERE display_s3_key IS NULL OR display_s3_key = '') as missing_display,
          COUNT(*) FILTER (WHERE phash IS NULL) as missing_phash
        FROM media
      `);

      // Recent uploads
      const recentUploads = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE uploaded_at >= NOW() - INTERVAL '24 hours') as last_24h,
          COUNT(*) FILTER (WHERE uploaded_at >= NOW() - INTERVAL '7 days') as last_7d,
          COUNT(*) FILTER (WHERE uploaded_at >= NOW() - INTERVAL '30 days') as last_30d
        FROM media
      `);

      res.json({
        typeStats: typeStats.rows,
        ageStats: ageStats.rows,
        categoryStats: categoryStats.rows,
        missingMetadata: missingMetadata.rows[0],
        missingProcessing: missingProcessing.rows[0],
        recentUploads: recentUploads.rows[0],
      });
    } catch (err) {
      console.error('Stats error:', err);
      res.status(500).json({ error: 'Failed to load statistics' });
    }
  },

  async findDuplicates(req, res) {
    try {
      // If client supplied retry_ids, only re-hash those (otherwise process everything missing)
      const retryIds = Array.isArray(req.body?.retry_ids)
        ? req.body.retry_ids.filter(id => Number.isInteger(id) && id > 0)
        : null;

      const HASH_CONCURRENCY = 10;
      const HASH_TIMEOUT_MS = 10000;
      const MAX_GROUPS = 200; // cap to keep response small on large galleries

      const computeHashes = async (rows) => {
        const failed = [];
        if (rows.length === 0) return failed;

        const queue = rows.slice();
        const workers = Array.from(
          { length: Math.min(HASH_CONCURRENCY, queue.length) },
          async () => {
            while (queue.length > 0) {
              const row = queue.shift();
              try {
                const buf = await getObjectBuffer(row.thumbnail_s3_key, HASH_TIMEOUT_MS);
                const hash = await computeDHash(buf);
                await db.query(
                  'UPDATE media SET phash = $1 WHERE id = $2',
                  [hash.toString(), row.id]
                );
              } catch (err) {
                console.error(`Failed to compute hash for media ${row.id}:`, err.message);
                failed.push(row.id);
              }
            }
          }
        );
        await Promise.all(workers);
        return failed;
      };

      let failedIds = [];
      if (retryIds && retryIds.length > 0) {
        const targets = await db.query(
          'SELECT id, type, s3_key, thumbnail_s3_key FROM media WHERE id = ANY($1::int[])',
          [retryIds]
        );
        failedIds = await computeHashes(targets.rows);
      } else {
        const nullHash = await db.query(
          'SELECT id, type, s3_key, thumbnail_s3_key FROM media WHERE phash IS NULL'
        );
        failedIds = await computeHashes(nullHash.rows);
      }

      const allHashed = await db.query(
        'SELECT id, type, s3_key, thumbnail_s3_key, age_rating, phash::TEXT AS phash_str FROM media WHERE phash IS NOT NULL ORDER BY uploaded_at DESC LIMIT 50000'
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
          if (groups.length >= MAX_GROUPS) break;
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
        if (groups.length >= MAX_GROUPS) break;
      }

      const result = await Promise.all(
        groups.map(async (group) => {
          const items = await Promise.all(
            group.map(async (item) => {
              const [url, thumbnail_url] = await Promise.all([
                getSignedUrlForKey(item.s3_key, SIGN_URL_EXPIRES),
                getSignedUrlForKey(item.thumbnail_s3_key, SIGN_URL_EXPIRES),
              ]);
              return {
                id: item.id,
                type: item.type,
                age_rating: item.age_rating,
                url,
                thumbnail_url,
              };
            })
          );
          return { items };
        })
      );

      const totalDuplicates = result.reduce((s, g) => s + g.items.length, 0);
      res.json({
        groups: result,
        totalDuplicates,
        failedIds,
        truncated: groups.length >= MAX_GROUPS,
      });
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
