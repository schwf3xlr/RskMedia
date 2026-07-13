const db = require('../config/database');
const { SORT_MAP } = require('../config/constants');

// parseIds одинаковая логика с models/media.js — вычленяем в местную
// копию, чтобы не тянуть импорт (циркуляр не критичен, но проще).
function parseIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw).split(',').map(Number).filter(n => !Number.isNaN(n));
}

// Тот же трюк с seeded random, что и в media/favorites — иначе
// ORDER BY RANDOM() ломает пагинацию.
function buildOrderBy(sort, randomSeed, params, fallback) {
  if (sort === 'random' && Number.isFinite(randomSeed)) {
    params.push(String(randomSeed));
    return { order: `md5(m.id::text || $${params.length}), m.id`, idxOffset: 1 };
  }
  return { order: SORT_MAP[sort] || fallback, idxOffset: 0 };
}

// WHERE-фильтры для медиа внутри коллекции. Такая же логика как у
// media/favorites (comma-separated → IN), но начальный idx оставляет
// место для параметров WHERE выше (collectionId, tokenId).
function buildWhere({ categoryId, subcategoryId, age, type, params, idx = 3 }) {
  let query = '';
  const categoryIds = parseIds(categoryId);
  if (categoryIds.length > 0) {
    query += ` AND m.category_id IN (${categoryIds.map(() => `$${idx++}`).join(',')})`;
    params.push(...categoryIds);
  }
  const subcategoryIds = parseIds(subcategoryId);
  if (subcategoryIds.length > 0) {
    query += ` AND m.subcategory_id IN (${subcategoryIds.map(() => `$${idx++}`).join(',')})`;
    params.push(...subcategoryIds);
  }
  const ages = parseIds(age);
  if (ages.length > 0) {
    query += ` AND m.age_rating IN (${ages.map(() => `$${idx++}`).join(',')})`;
    params.push(...ages);
  }
  if (type === 'photo' || type === 'video') {
    query += ` AND m.type = $${idx++}`;
    params.push(type);
  }
  return { query, idx };
}

const CollectionModel = {
  // Список коллекций пользователя + для каждой — первые 3 миниатюры.
  // Делаем ДВА простых запроса вместо одного жирного с LATERAL joins,
  // потому что сложные JOIN'ы плохо кэшируются prepared statement'ом и
  // сложнее дебажить: первая версия с LATERAL молча возвращала пустой
  // набор из-за конфликта алиасов thumb1.id ↔ c.id при сериализации.
  async getAllForToken(tokenId) {
    const listRes = await db.query(
      `SELECT c.id, c.name, c.created_at,
              (SELECT COUNT(*)::int
               FROM collection_items ci
               WHERE ci.collection_id = c.id) AS count
       FROM collections c
       WHERE c.token_id = $1
       ORDER BY c.created_at DESC, c.id DESC`,
      [tokenId]
    );
    if (listRes.rows.length === 0) return [];

    // top-3 last-added items для КАЖДОЙ моей коллекции. row_number
    // partition-by гарантирует ровно ≤3 строки на коллекцию.
    const ids = listRes.rows.map(r => r.id);
    const thumbRes = await db.query(
      `WITH ranked AS (
         SELECT ci.collection_id,
                m.id AS media_id,
                m.thumbnail_s3_key,
                ROW_NUMBER() OVER (
                  PARTITION BY ci.collection_id
                  ORDER BY ci.added_at DESC, ci.media_id DESC
                ) AS rn
         FROM collection_items ci
         JOIN media m ON m.id = ci.media_id
         WHERE ci.collection_id = ANY($1::int[])
       )
       SELECT collection_id, media_id, thumbnail_s3_key, rn
       FROM ranked WHERE rn <= 3
       ORDER BY collection_id, rn`,
      [ids]
    );

    const thumbsByCollection = new Map();
    for (const row of thumbRes.rows) {
      if (!thumbsByCollection.has(row.collection_id)) {
        thumbsByCollection.set(row.collection_id, []);
      }
      thumbsByCollection.get(row.collection_id).push({
        media_id: row.media_id,
        thumbnail_s3_key: row.thumbnail_s3_key,
      });
    }

    return listRes.rows.map(c => ({
      ...c,
      thumbs: thumbsByCollection.get(c.id) || [],
    }));
  },

  async getById(id, tokenId) {
    const result = await db.query(
      `SELECT id, name, created_at,
        (SELECT COUNT(*)::int FROM collection_items ci WHERE ci.collection_id = collections.id) AS count
       FROM collections
       WHERE id = $1 AND token_id = $2`,
      [id, tokenId]
    );
    return result.rows[0];
  },

  async create(tokenId, name) {
    const result = await db.query(
      `INSERT INTO collections (token_id, name) VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [tokenId, name]
    );
    return result.rows[0];
  },

  async rename(id, tokenId, name) {
    const result = await db.query(
      `UPDATE collections SET name = $1
       WHERE id = $2 AND token_id = $3
       RETURNING id, name, created_at`,
      [name, id, tokenId]
    );
    return result.rows[0];
  },

  async delete(id, tokenId) {
    // ON DELETE CASCADE на collection_items — items удалятся вместе.
    const result = await db.query(
      `DELETE FROM collections WHERE id = $1 AND token_id = $2 RETURNING id`,
      [id, tokenId]
    );
    return result.rowCount > 0;
  },

  // Кладём media_ids в коллекцию пачкой. ON CONFLICT DO NOTHING на
  // UNIQUE(collection_id, media_id) — повторное добавление no-op.
  // FK на media гарантирует, что несуществующие id вылетят с 23503,
  // контроллер преобразует в 400.
  async addItems(collectionId, tokenId, mediaIds) {
    // Убеждаемся, что коллекция принадлежит именно этому token_id —
    // одним запросом с проверкой.
    const own = await db.query(
      `SELECT 1 FROM collections WHERE id = $1 AND token_id = $2`,
      [collectionId, tokenId]
    );
    if (own.rowCount === 0) return { added: 0, notOwned: true };

    if (mediaIds.length === 0) return { added: 0 };
    // ARRAY[$2::int, $3::int, ...] заменяет N inserts на один — важно
    // для batch-add из "Выбрать всё" в галерее (может быть 200+ id).
    const values = mediaIds.map((_, i) => `($1, $${i + 2})`).join(',');
    const result = await db.query(
      `INSERT INTO collection_items (collection_id, media_id) VALUES ${values}
       ON CONFLICT (collection_id, media_id) DO NOTHING
       RETURNING media_id`,
      [collectionId, ...mediaIds]
    );
    return { added: result.rowCount };
  },

  async removeItems(collectionId, tokenId, mediaIds) {
    const own = await db.query(
      `SELECT 1 FROM collections WHERE id = $1 AND token_id = $2`,
      [collectionId, tokenId]
    );
    if (own.rowCount === 0) return { removed: 0, notOwned: true };

    const result = await db.query(
      `DELETE FROM collection_items
       WHERE collection_id = $1 AND media_id = ANY($2::int[])`,
      [collectionId, mediaIds]
    );
    return { removed: result.rowCount };
  },

  // "В каких МОИХ коллекциях лежит это медиа" — для чекбоксов в модалке.
  async getContainingCollections(tokenId, mediaId) {
    const result = await db.query(
      `SELECT c.id, c.name
       FROM collections c
       JOIN collection_items ci ON ci.collection_id = c.id
       WHERE c.token_id = $1 AND ci.media_id = $2
       ORDER BY c.name`,
      [tokenId, mediaId]
    );
    return result.rows;
  },

  // Медиа внутри коллекции с полной поддержкой фильтров и сортировки.
  // Ownership check ($2 = tokenId) — иначе клиент по чужому collectionId
  // мог бы прочесть содержимое чужой коллекции.
  async getMediaWithCount(collectionId, tokenId, { categoryId, subcategoryId, age, type, sort, randomSeed, limit = 20, offset = 0 }) {
    const params = [collectionId, tokenId];
    const where = buildWhere({ categoryId, subcategoryId, age, type, params });
    let idx = where.idx;
    // Дефолт-сорт для коллекции — "добавлены недавно", как у favorites.
    const { order, idxOffset } = buildOrderBy(sort, randomSeed, params, 'ci.added_at DESC, m.id DESC');
    idx += idxOffset;

    const sql = `
      SELECT m.*, c.name AS category_name, s.name AS subcategory_name,
             COUNT(*) OVER() AS total_count
      FROM collection_items ci
      JOIN collections col ON col.id = ci.collection_id AND col.token_id = $2
      JOIN media m ON m.id = ci.media_id
      LEFT JOIN categories c ON m.category_id = c.id
      LEFT JOIN subcategories s ON m.subcategory_id = s.id
      WHERE ci.collection_id = $1 ${where.query}
      ORDER BY ${order}
      LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(sql, params);
    return result.rows;
  },

  // Уникальные значения фильтров для конкретной коллекции — чтобы UI
  // показал в multi-select только те опции, что реально встречаются в
  // этой коллекции. Один запрос по трём измерениям + типам.
  async getAvailableFilters(collectionId, tokenId) {
    // Проверяем ownership отдельно — если возвращать значения по чужому
    // id, злоумышленник может пробить существование пар category/subcategory
    // в чужих коллекциях (тайминг + различие пустых наборов).
    const own = await db.query(
      `SELECT 1 FROM collections WHERE id = $1 AND token_id = $2`,
      [collectionId, tokenId]
    );
    if (own.rowCount === 0) return null;

    const [cats, subs, ages, types] = await Promise.all([
      db.query(
        `SELECT DISTINCT c.id, c.name
         FROM collection_items ci JOIN media m ON m.id = ci.media_id
         JOIN categories c ON c.id = m.category_id
         WHERE ci.collection_id = $1
         ORDER BY c.name`,
        [collectionId]
      ),
      // Подкатегории уникальны по имени между категориями (пользователь
      // так сказал в §multi-select) — группируем и склеиваем id
      // через запятую, повторяем поведение UI для галереи.
      db.query(
        `SELECT MIN(s.id::text) AS id, s.name,
                STRING_AGG(DISTINCT s.id::text, ',') AS ids
         FROM collection_items ci JOIN media m ON m.id = ci.media_id
         JOIN subcategories s ON s.id = m.subcategory_id
         WHERE ci.collection_id = $1
         GROUP BY s.name
         ORDER BY s.name`,
        [collectionId]
      ),
      db.query(
        `SELECT DISTINCT m.age_rating
         FROM collection_items ci JOIN media m ON m.id = ci.media_id
         WHERE ci.collection_id = $1 AND m.age_rating IS NOT NULL
         ORDER BY m.age_rating`,
        [collectionId]
      ),
      db.query(
        `SELECT DISTINCT m.type
         FROM collection_items ci JOIN media m ON m.id = ci.media_id
         WHERE ci.collection_id = $1
         ORDER BY m.type`,
        [collectionId]
      ),
    ]);

    return {
      categories: cats.rows,
      subcategories: subs.rows.map(r => ({ id: r.ids, name: r.name })),
      ages: ages.rows.map(r => r.age_rating),
      types: types.rows.map(r => r.type),
    };
  },
};

module.exports = CollectionModel;
