const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const { createReadStream } = require('fs');
const { Upload } = require('@aws-sdk/lib-storage');
const { v4: uuidv4 } = require('uuid');
const MediaModel = require('../models/media');
const { deleteFromS3, s3Client, bucket } = require('../config/s3');
const { validateFileType } = require('../helpers/fileValidator');
const { getExtensionFromMimeType } = require('../helpers/mime');
const { enrichOne, enrichMany } = require('../helpers/enrichUrls');
const { TYPE_SORT_MAP } = require('../config/constants');
const env = require('../config/env');
const sseBroker = require('../helpers/sseBroker');
const logger = require('../helpers/logger');
const db = require('../config/database');

const UPLOAD_CONCURRENCY = 3;

// "Фото" / "Видео" sort options in the dropdown are actually type filters -
// translate them to a `type` query parameter and fall back to the default
// (newest) sort for the filtered slice.
function resolveSortAndType(sort) {
  if (TYPE_SORT_MAP[sort]) {
    return { type: TYPE_SORT_MAP[sort], sort: 'newest' };
  }
  return { type: undefined, sort };
}

// Tune sharp cache for media-heavy workload
sharp.cache({ memory: 100, items: 200, files: 0 });

const MediaController = {
  async getAll(req, res) {
    const { category_id, subcategory_id, age, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const { type, sort: effectiveSort } = resolveSortAndType(sort);
    const media = await MediaModel.getAllWithCount({
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      type,
      sort: effectiveSort,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    const total = media.length > 0 ? parseInt(media[0].total_count, 10) : 0;
    const mediaWithUrls = await enrichMany(media, req);
    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async getById(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });
    const enriched = await enrichOne(media, req);
    res.json(enriched);
  },

  async uploadSingle(req, res) {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const result = await processFile(file, req.body);
      sseBroker.publishBroadcast('media.created', { id: result.id });
      res.status(201).json(result);
    } catch (err) {
      logger.error({ err, file: file.originalname }, 'Upload error');
      res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
    } finally {
      await cleanupTempFiles([file.path]);
    }
  },

  async uploadMultiple(req, res) {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const { category_id, subcategory_id, age_rating } = req.body;
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
      const batch = files.slice(i, i + UPLOAD_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          try {
            const result = await processFile(file, { category_id, subcategory_id, age_rating });
            return { ok: result };
          } catch (err) {
            logger.error({ err, file: file.originalname }, 'Batch upload item error');
            return { err: { file: file.originalname, error: err.message } };
          }
        })
      );
      for (const r of batchResults) {
        if (r.ok) results.push(r.ok);
        else errors.push(r.err);
      }
      // Clean up multer temp files for the just-processed batch
      await Promise.all(batch.map(f => cleanupTempFiles([f.path])));
    }

    if (results.length > 0) {
      sseBroker.publishBroadcast('media.created', { ids: results.map(r => r.id) });
    }
    res.status(201).json({ uploaded: results.length, errors: errors.length, media: results, errorDetails: errors });
  },

  async batchUpdate(req, res) {
    const { ids, category_id, subcategory_id, age_rating } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    const updates = {};
    if (category_id !== undefined) updates.categoryId = category_id;
    if (subcategory_id !== undefined) updates.subcategoryId = subcategory_id;
    if (age_rating !== undefined) updates.ageRating = age_rating;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    await db.transaction(async (client) => {
      // When changing category without explicit subcategory, clear stale subcategory references
      // that don't belong to the new category (in one query instead of N).
      if (category_id !== undefined && subcategory_id === undefined) {
        await client.query(`
          UPDATE media m
          SET subcategory_id = NULL
          WHERE m.id = ANY($1::int[])
            AND m.subcategory_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM subcategories s
              WHERE s.id = m.subcategory_id AND s.category_id = $2
            )
        `, [ids, category_id]);
      }

      const sets = [];
      const params = [];
      let idx = 1;
      if (category_id !== undefined) { sets.push(`category_id = $${idx++}`); params.push(category_id); }
      if (subcategory_id !== undefined) { sets.push(`subcategory_id = $${idx++}`); params.push(subcategory_id); }
      if (age_rating !== undefined) { sets.push(`age_rating = $${idx++}`); params.push(age_rating); }
      params.push(ids);

      await client.query(
        `UPDATE media SET ${sets.join(', ')} WHERE id = ANY($${idx}::int[])`,
        params
      );
    });

    sseBroker.publishBroadcast('media.updated', { ids });
    res.json({ message: 'Batch update completed', updated: ids.length });
  },

  async delete(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    await db.query('DELETE FROM media WHERE id = $1', [id]);

    const deletePromises = [deleteFromS3(media.s3_key), deleteFromS3(media.thumbnail_s3_key)];
    if (media.display_s3_key) deletePromises.push(deleteFromS3(media.display_s3_key));
    if (media.preview_s3_key) deletePromises.push(deleteFromS3(media.preview_s3_key));
    await Promise.all(deletePromises);

    sseBroker.publishBroadcast('media.deleted', { ids: [Number(id)] });
    res.json({ message: 'Media deleted' });
  },

  async batchDelete(req, res) {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    const rows = await db.query(
      'SELECT id, s3_key, thumbnail_s3_key, display_s3_key, preview_s3_key FROM media WHERE id = ANY($1::int[])',
      [ids]
    );

    await db.query('DELETE FROM media WHERE id = ANY($1::int[])', [ids]);

    const allDeletes = [];
    for (const m of rows.rows) {
      allDeletes.push(deleteFromS3(m.s3_key));
      allDeletes.push(deleteFromS3(m.thumbnail_s3_key));
      if (m.display_s3_key) allDeletes.push(deleteFromS3(m.display_s3_key));
      if (m.preview_s3_key) allDeletes.push(deleteFromS3(m.preview_s3_key));
    }
    await Promise.all(allDeletes);

    sseBroker.publishBroadcast('media.deleted', { ids: rows.rows.map(r => r.id) });
    res.json({ message: 'Batch delete completed', deleted: rows.rows.length });
  },
};

// Streams a file from disk to S3 using multipart upload (no full file in memory).
async function streamToS3(key, filePath, contentType) {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });
  await upload.done();
}

async function processFile(file, { category_id, subcategory_id, age_rating } = {}) {
  const MAX_PHOTO_SIZE = env.UPLOAD.MAX_PHOTO_SIZE_MB * 1024 * 1024;
  const MAX_VIDEO_SIZE = env.UPLOAD.MAX_VIDEO_SIZE_MB * 1024 * 1024;
  const isImage = file.mimetype.startsWith('image/');
  const maxSize = isImage ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE;

  // Check size BEFORE reading buffer into memory
  if (file.size > maxSize) {
    const err = new Error(`Файл слишком большой. Максимум ${maxSize / 1024 / 1024} МБ`);
    err.status = 400;
    throw err;
  }

  const type = isImage ? 'photo' : 'video';
  const ext = getExtensionFromMimeType(file.mimetype);
  const mediaId = uuidv4();
  const s3Key = `media/${mediaId}${ext}`;
  const thumbnailKey = `thumbnails/${mediaId}_thumb.jpg`;
  const displayKey = isImage ? `display/${mediaId}_display.jpg` : null;
  const previewKey = isImage ? null : `previews/${mediaId}_preview.webp`;
  const filePath = file.path;

  let buffer = null;
  let fileSize = file.size;

  // For images: read buffer once for content validation + sharp processing.
  // For videos: validate via ffprobe on the multer temp file, no buffer needed.
  if (isImage) {
    buffer = await fs.readFile(filePath);
    if (!validateFileType(buffer, file.mimetype)) {
      const err = new Error('Содержимое файла не соответствует его типу');
      err.status = 400;
      throw err;
    }
    fileSize = buffer.length;
  } else {
    await validateVideoFile(filePath);
  }

  // Generate thumbnail + display in parallel for images.
  // For videos, thumbnail + animated preview both come from the same source
  // file, so we run them together.
  let thumbnailBuffer;
  let displayBuffer = null;
  let previewBuffer = null;
  if (isImage) {
    [thumbnailBuffer, displayBuffer] = await Promise.all([
      sharp(buffer).resize(400, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(),
      sharp(buffer).resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(),
    ]);
  } else {
    // Preview generation can fail on codecs ffmpeg refuses (rare) — treat it
    // as best-effort so the upload still lands. Thumbnail failure IS fatal,
    // because gallery cards require it.
    thumbnailBuffer = await generateVideoThumbnail(filePath);
    try {
      previewBuffer = await generateVideoPreview(filePath);
    } catch (err) {
      logger.warn({ err: err.message, file: file.originalname }, 'video preview generation failed');
    }
  }

  // Upload original + thumbnail + display/preview in parallel
  const uploadOps = [
    streamToS3(s3Key, filePath, file.mimetype),
    uploadBufferToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg'),
  ];
  if (displayBuffer && displayKey) {
    uploadOps.push(uploadBufferToS3(displayKey, displayBuffer, 'image/jpeg'));
  }
  if (previewBuffer && previewKey) {
    uploadOps.push(uploadBufferToS3(previewKey, previewBuffer, 'image/webp'));
  }
  await Promise.all(uploadOps);

  const media = await MediaModel.create({
    type,
    s3Key,
    thumbnailS3Key: thumbnailKey,
    displayS3Key: displayKey,
    previewS3Key: previewBuffer ? previewKey : null,
    fileSize,
    categoryId: category_id || null,
    subcategoryId: subcategory_id || null,
    ageRating: age_rating || null,
  });

  return await enrichOne(media, { protocol: 'http', get: () => 'localhost' });
}

async function uploadBufferToS3(key, buffer, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

async function cleanupTempFiles(paths) {
  await Promise.all(paths.map(async (p) => {
    try { await fs.unlink(p); } catch {}
  }));
}

function validateVideoFile(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err) => {
      if (err) return reject(new Error('Файл повреждён или имеет неподдерживаемый видеоформат'));
      resolve();
    });
  });
}

async function generateVideoThumbnail(videoPath) {
  await validateVideoFile(videoPath);
  return new Promise((resolve, reject) => {
    const thumbPath = videoPath + '_thumb.jpg';
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['1'],
        filename: path.basename(thumbPath),
        folder: path.dirname(thumbPath),
        size: '400x?',
      })
      .on('end', async () => {
        try {
          const buffer = await fs.readFile(thumbPath);
          await fs.unlink(thumbPath);
          resolve(buffer);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', reject);
  });
}

// 5-second animated WebP shown on hover in the gallery card. Samples 10fps
// (light on the eyes, keeps file size in the 30-80KB range for most clips)
// and scales width to 400px to match card size. `-loop 0` is default for
// libwebp anim; explicit here as documentation.
async function generateVideoPreview(videoPath) {
  const previewPath = videoPath + '_preview.webp';
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noAudio()
      .setStartTime(0)
      .setDuration(5)
      .outputOptions([
        '-vf', 'scale=400:-2,fps=10',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '4',
        '-q:v', '55',
        '-loop', '0',
        '-an', '-vsync', '0',
      ])
      .output(previewPath)
      .on('end', async () => {
        try {
          const buffer = await fs.readFile(previewPath);
          await fs.unlink(previewPath).catch(() => {});
          resolve(buffer);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', async (err) => {
        await fs.unlink(previewPath).catch(() => {});
        reject(err);
      })
      .run();
  });
}

module.exports = MediaController;
// Exposed for zipUploadController — it reuses the same photo/video processing
// pipeline as the multipart endpoints (validation, thumbnail, preview, S3
// upload, DB insert) instead of forking a parallel copy.
module.exports.processFile = processFile;
