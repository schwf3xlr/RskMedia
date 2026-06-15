const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const initSQL = `
CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    token VARCHAR(255) UNIQUE,
    token_hash VARCHAR(255),
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
CREATE INDEX IF NOT EXISTS idx_media_category_id ON media(category_id);
CREATE INDEX IF NOT EXISTS idx_media_subcategory_id ON media(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_media_age_rating ON media(age_rating);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_phash ON media(phash) WHERE phash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_favorites_token_id ON favorites(token_id);
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
  await db.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR(255)');
  await db.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS jwt_hash VARCHAR(255)');
}

async function initDatabase() {
  try {
    await db.query(initSQL);
    console.log('Database tables initialized successfully');
    await migrate();
    console.log('Migrations applied');

    const tokenResult = await db.query('SELECT COUNT(*) FROM tokens');
    const tokenCount = parseInt(tokenResult.rows[0].count, 10);

    if (tokenCount === 0) {
      const defaultToken = 'admin_' + uuidv4().replace(/-/g, '').substring(0, 16);
      await db.query(
        'INSERT INTO tokens (token, type, is_active) VALUES ($1, $2, true)',
        [defaultToken, 'admin']
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
