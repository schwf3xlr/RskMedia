const db = require('../config/database');
const { getObjectSize } = require('../config/s3');

const CONCURRENCY = 20;

async function processBatch(rows) {
  return Promise.all(rows.map(async (row) => {
    try {
      const size = await getObjectSize(row.s3_key);
      await db.query('UPDATE media SET file_size = $1 WHERE id = $2', [size, row.id]);
      return { success: true, id: row.id };
    } catch (err) {
      console.error(`Failed to get size for id=${row.id}, key=${row.s3_key}: ${err.message}`);
      return { success: false, id: row.id };
    }
  }));
}

async function main() {
  try {
    const result = await db.query(`
      SELECT id, s3_key FROM media
      WHERE file_size IS NULL
      ORDER BY id
    `);

    if (result.rows.length === 0) {
      console.log('No files need size update');
      process.exit(0);
    }

    console.log(`Found ${result.rows.length} files without file_size`);
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
      const batch = result.rows.slice(i, i + CONCURRENCY);
      const results = await processBatch(batch);
      results.forEach(r => {
        if (r.success) updated++;
        else errors++;
      });
      if (updated % 100 === 0 || updated === result.rows.length) {
        console.log(`Updated ${updated}/${result.rows.length}, errors: ${errors}`);
      }
    }

    console.log(`Done. Updated: ${updated}, Errors: ${errors}`);
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
