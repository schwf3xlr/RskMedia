#!/usr/bin/env node
// Run ANALYZE on the media-heavy tables so the planner has up-to-date row
// statistics. After a bulk upload or restore, PostgreSQL may still pick
// Seq Scan over the (uploaded_at DESC, id DESC) index because it hasn't
// re-sampled the table yet. Meant to be called periodically (cron) or
// after a big import.
require('dotenv').config();
const db = require('../config/database');

const TABLES = ['media', 'favorites', 'categories', 'subcategories', 'tokens'];

(async () => {
  let ok = true;
  for (const t of TABLES) {
    const start = Date.now();
    try {
      await db.query(`ANALYZE ${t}`);
      console.log(`ANALYZE ${t} ok (${Date.now() - start}ms)`);
    } catch (err) {
      ok = false;
      console.error(`ANALYZE ${t} failed:`, err.message);
    }
  }
  await db.pool.end();
  process.exit(ok ? 0 : 1);
})();
