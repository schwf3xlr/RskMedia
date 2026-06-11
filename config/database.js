const { Pool } = require('pg');
require('dotenv').config();

const password = process.env.DB_PASSWORD || '';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rskmedia',
  user: process.env.DB_USER || 'postgres',
  password: String(password),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
