const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const unzipper = require('unzipper');
const { processFile } = require('./mediaController');
const sseBroker = require('../helpers/sseBroker');
const logger = require('../helpers/logger');
const ApiError = require('../helpers/apiError');
const env = require('../config/env');

const ALLOWED_MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

// Cap per-entry to the same MAX_FILE_SIZE_MB the regular upload path uses.
// Without this, a small zip can hide multi-GB entries and blow disk.
const MAX_ENTRY_BYTES = env.UPLOAD.MAX_FILE_SIZE_MB * 1024 * 1024;

// Guard against pathological zips (nested infinite dirs, symlinks). unzipper
// walks entries lazily so we just count as we go and abort on limit.
const MAX_ENTRIES = env.UPLOAD.MAX_BATCH_FILES * 5;

async function extractEntries(zipPath, workDir) {
  const results = [];
  const directory = await unzipper.Open.file(zipPath);
  if (directory.files.length > MAX_ENTRIES) {
    throw ApiError.badRequest(`Слишком много файлов в архиве (>${MAX_ENTRIES})`);
  }
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    // Zip-slip: reject any entry whose path escapes workDir. Even though we
    // build our own filename below (uuid-based), unzipper.Open.file uses the
    // entry name for the extraction stream — treat the input as hostile.
    const safeName = path.basename(entry.path);
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_MIME_BY_EXT[ext]) {
      logger.debug({ entry: entry.path }, 'skip zip entry (unsupported extension)');
      continue;
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      results.push({ originalname: safeName, skipped: 'too_large' });
      continue;
    }

    const outName = `${crypto.randomBytes(8).toString('hex')}${ext}`;
    const outPath = path.join(workDir, outName);
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(fsSync.createWriteStream(outPath))
        .on('finish', resolve)
        .on('error', reject);
    });
    const stat = await fs.stat(outPath);
    results.push({
      originalname: safeName,
      path: outPath,
      size: stat.size,
      mimetype: ALLOWED_MIME_BY_EXT[ext],
    });
  }
  return results;
}

// Progress reporting fans out via broadcast SSE. Admins watching /admin get
// a live counter without needing an XHR upload progress event (the zip may
// live on disk from a browser upload, then unpacking happens on the server).
function broadcastProgress(state) {
  sseBroker.publishBroadcast('zip.progress', state);
}

async function uploadZip(req, res) {
  const file = req.file;
  if (!file) throw ApiError.badRequest('Не загружен ZIP-файл');
  const { category_id, subcategory_id, age_rating } = req.body;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rskmedia-zip-'));
  const uploaded = [];
  const errors = [];

  try {
    const entries = await extractEntries(file.path, workDir);
    const usable = entries.filter(e => !e.skipped);
    const skipped = entries.filter(e => e.skipped);
    for (const s of skipped) errors.push({ file: s.originalname, error: s.skipped });

    broadcastProgress({ phase: 'started', total: usable.length, done: 0 });

    // Serial rather than parallel: processFile does ffmpeg + sharp which are
    // heavy; parallelizing here on top of the media controller's own upload
    // concurrency would overload the CPU on a modest VPS.
    for (let i = 0; i < usable.length; i++) {
      const e = usable[i];
      try {
        const result = await processFile(e, { category_id, subcategory_id, age_rating });
        uploaded.push({ id: result.id, name: e.originalname });
      } catch (err) {
        logger.error({ err, file: e.originalname }, 'zip entry processing failed');
        errors.push({ file: e.originalname, error: err.message });
      } finally {
        await fs.unlink(e.path).catch(() => {});
      }
      broadcastProgress({ phase: 'progress', total: usable.length, done: i + 1 });
    }

    if (uploaded.length > 0) {
      sseBroker.publishBroadcast('media.created', { ids: uploaded.map(u => u.id) });
    }
    broadcastProgress({ phase: 'done', total: usable.length, done: uploaded.length, errors: errors.length });

    res.status(201).json({ uploaded: uploaded.length, errors: errors.length, media: uploaded, errorDetails: errors });
  } finally {
    // Best-effort cleanup — leaving stray files in tmp is harmless but
    // clutters and eventually eats disk.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(file.path).catch(() => {});
  }
}

module.exports = { uploadZip };
