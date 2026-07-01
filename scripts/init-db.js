const db = require('../config/database');
const { ensureDatabase } = require('../config/database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const HASH_ROUNDS = 12;

const initSQL = `
CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    jwt_hash VARCHAR(255),
    type VARCHAR(10) CHECK (type IN ('client', 'admin')) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subcategories (
    id SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(category_id, name)
);

CREATE TABLE IF NOT EXISTS media (
    id SERIAL PRIMARY KEY,
    type VARCHAR(5) CHECK (type IN ('photo', 'video')) NOT NULL,
    s3_key VARCHAR(500) NOT NULL,
    thumbnail_s3_key VARCHAR(500) NOT NULL,
    display_s3_key VARCHAR(500),
    file_size BIGINT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
    age_rating INTEGER CHECK (age_rating >= 0 AND age_rating <= 21),
    phash NUMERIC(20,0),
    uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(token_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at DESC);
-- Composite index covers "ORDER BY uploaded_at DESC, id DESC" used by every list query
CREATE INDEX IF NOT EXISTS idx_media_uploaded_id ON media(uploaded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_media_category_id ON media(category_id);
CREATE INDEX IF NOT EXISTS idx_media_subcategory_id ON media(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_media_age_rating ON media(age_rating);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
-- For sort=name (ORDER BY m.s3_key ASC)
CREATE INDEX IF NOT EXISTS idx_media_s3_key ON media(s3_key);
-- Composite for common WHERE+ORDER combinations
CREATE INDEX IF NOT EXISTS idx_media_subcategory_uploaded ON media(subcategory_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_age_uploaded ON media(age_rating, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_category_age ON media(category_id, age_rating, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_phash ON media(phash) WHERE phash IS NOT NULL;
-- idx_favorites_token_id covered by UNIQUE(token_id, media_id) which already creates an index on (token_id, media_id)
CREATE INDEX IF NOT EXISTS idx_favorites_media_id ON favorites(media_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_category_id ON subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_tokens_type ON tokens(type);
CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active);
`;

async function seedCategories() {
  const categories = ['Twinks', 'Guys', 'Other'];

  for (const catName of categories) {
    await db.query(
      'INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [catName]
    );
  }
  console.log('Categories seeded');
}

async function migrate() {
  await db.query('ALTER TABLE media ADD COLUMN IF NOT EXISTS phash NUMERIC(20,0)');
  await db.query('ALTER TABLE media ADD COLUMN IF NOT EXISTS display_s3_key VARCHAR(500)');
  await db.query('ALTER TABLE media ADD COLUMN IF NOT EXISTS file_size BIGINT');
  await db.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255)');
  await db.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS jwt_hash VARCHAR(255)');

  // Migrate existing plaintext tokens to bcrypt hashes before dropping the column
  const tokenColExists = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'tokens' AND column_name = 'token'`
  );
  if (tokenColExists.rows.length > 0) {
    const plainTokens = await db.query(
      `SELECT id, token FROM tokens WHERE token IS NOT NULL AND token_hash IS NULL`
    );
    for (const row of plainTokens.rows) {
      const hash = await bcrypt.hash(row.token, HASH_ROUNDS);
      await db.query('UPDATE tokens SET token_hash = $1 WHERE id = $2', [hash, row.id]);
      console.log(`Migrated token id=${row.id} to token_hash`);
    }
    await db.query('ALTER TABLE tokens DROP COLUMN IF EXISTS token');
  }
}

async function initDatabase() {
  try {
    await ensureDatabase();
    await db.query(initSQL);
    console.log('Database tables initialized successfully');
    await migrate();
    console.log('Migrations applied');

    const tokenResult = await db.query('SELECT COUNT(*) FROM tokens');
    const tokenCount = parseInt(tokenResult.rows[0].count, 10);

    if (tokenCount === 0) {
      const defaultToken = 'admin_' + uuidv4().replace(/-/g, '').substring(0, 16);
      const tokenHash = await bcrypt.hash(defaultToken, HASH_ROUNDS);
      await db.query(
        'INSERT INTO tokens (token_hash, type, is_active) VALUES ($1, $2, true)',
        [tokenHash, 'admin']
      );
      console.log('='.repeat(60));
      console.log('No tokens found. Default admin token created:');
      console.log(defaultToken);
      console.log('Use this token to log in and create more tokens.');
      console.log('='.repeat(60));
    }

    await seedCategories();
  } catch (err) {
    console.error('Database initialization failed:', err);
    throw err;
  }
}

if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = initDatabase;
