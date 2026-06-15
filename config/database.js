const { Pool } = require('pg');
require('dotenv').config();

const password = process.env.DB_PASSWORD || '';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rskmedia',
  user: process.env.DB_USER || 'postgres',
  password: String(password),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // Do not kill the server; log and let the pool recover
});

async function query(text, params, options = {}) {
  const client = await pool.connect();
  try {
    if (options.timeout) {
      await client.query(`SET statement_timeout = ${options.timeout}`);
    }
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query,
  transaction,
  pool,
};
