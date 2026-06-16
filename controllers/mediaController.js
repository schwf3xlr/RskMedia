const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const MediaModel = require('../models/media');
const { uploadToS3, deleteFromS3, getSignedUrlForKey } = require('../config/s3');
const { validateFileType } = require('../helpers/fileValidator');
const { getExtensionFromMimeType } = require('../helpers/mime');
const { SIGN_URL_EXPIRES } = require('../config/constants');
const db = require('../config/database');

async function enrichMediaUrls(media) {
  const mediaWithUrls = await Promise.all(
    media.map(async (m) => ({
      ...m,
      url: await getSignedUrlForKey(m.s3_key, SIGN_URL_EXPIRES),
      thumbnail_url: await getSignedUrlForKey(m.thumbnail_s3_key, SIGN_URL_EXPIRES),
    }))
  );
  return mediaWithUrls;
}

const MediaController = {
  async getAll(req, res) {
    const { category_id, subcategory_id, age, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const media = await MediaModel.getAll({
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      sort,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await MediaModel.getTotalCount({
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
    });

    const mediaWithUrls = await enrichMediaUrls(media);

    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async search(req, res) {
    const { q, category_id, subcategory_id, age, sort, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const media = await MediaModel.search({
      query: q,
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
      sort,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await MediaModel.getSearchCount({
      query: q,
      categoryId: category_id,
      subcategoryId: subcategory_id,
      age,
    });

    const mediaWithUrls = await enrichMediaUrls(media);

    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async getById(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    media.url = await getSignedUrlForKey(media.s3_key, SIGN_URL_EXPIRES);
    media.thumbnail_url = await getSignedUrlForKey(media.thumbnail_s3_key, SIGN_URL_EXPIRES);

    res.json(media);
  },

  async uploadSingle(req, res) {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const MAX_PHOTO_SIZE = (parseInt(process.env.MAX_PHOTO_SIZE_MB, 10) || 50) * 1024 * 1024;
    const MAX_VIDEO_SIZE = (parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 500) * 1024 * 1024;

    const tempPaths = [];
    try {
      const buffer = await fs.readFile(file.path);
      const isImage = file.mimetype.startsWith('image/');
      const maxSize = isImage ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE;
      if (buffer.length > maxSize) {
        return res.status(400).json({ error: `Файл слишком большой. Максимум ${maxSize / 1024 / 1024} МБ` });
      }
      if (!validateFileType(buffer, file.mimetype)) {
        return res.status(400).json({ error: 'Содержимое файла не соответствует его типу' });
      }

      const { category_id, subcategory_id, age_rating } = req.body;
      const type = isImage ? 'photo' : 'video';
      const ext = getExtensionFromMimeType(file.mimetype);
      const mediaId = uuidv4();
      const s3Key = `media/${mediaId}${ext}`;
      const thumbnailKey = `thumbnails/${mediaId}_thumb.jpg`;
      const displayKey = isImage ? `display/${mediaId}_display.jpg` : null;

      await uploadToS3(s3Key, buffer, file.mimetype);

      let thumbnailBuffer;
      let displayBuffer = null;
      if (type === 'photo') {
        thumbnailBuffer = await sharp(buffer)
          .resize(400, null, { withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        displayBuffer = await sharp(buffer)
          .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } else {
        const tempPath = path.join(__dirname, '../uploads', `${mediaId}_temp${ext}`);
        await fs.writeFile(tempPath, buffer);
        tempPaths.push(tempPath);
        thumbnailBuffer = await generateVideoThumbnail(tempPath);
      }

      await uploadToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg');
      if (displayBuffer && displayKey) {
        await uploadToS3(displayKey, displayBuffer, 'image/jpeg');
      }

      const media = await MediaModel.create({
        type,
        s3Key,
        thumbnailS3Key: thumbnailKey,
        displayS3Key: displayKey,
        fileSize: buffer.length,
        categoryId: category_id || null,
        subcategoryId: subcategory_id || null,
        ageRating: age_rating || null,
      });

      media.url = await getSignedUrlForKey(media.s3_key, SIGN_URL_EXPIRES);
      media.thumbnail_url = await getSignedUrlForKey(media.thumbnail_s3_key, SIGN_URL_EXPIRES);
      media.display_url = displayKey ? await getSignedUrlForKey(media.display_s3_key, SIGN_URL_EXPIRES) : null;

      res.status(201).json(media);
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    } finally {
      tempPaths.push(file.path);
      await cleanupTempFiles(tempPaths);
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

    for (const file of files) {
      try {
        const buffer = await fs.readFile(file.path);
        if (!validateFileType(buffer, file.mimetype)) {
          errors.push({ file: file.originalname, error: 'Invalid content' });
          await cleanupTempFiles([file.path]);
          continue;
        }

        const result = await processFile(buffer, file, { category_id, subcategory_id, age_rating });
        results.push(result);
      } catch (err) {
        console.error('Batch upload item error:', err);
        errors.push({ file: file.originalname, error: err.message });
      } finally {
        await cleanupTempFiles([file.path]);
      }
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
      for (const id of ids) {
        const itemUpdates = {};
        if (category_id !== undefined) itemUpdates.categoryId = category_id;
        if (subcategory_id !== undefined) itemUpdates.subcategoryId = subcategory_id;
        if (age_rating !== undefined) itemUpdates.ageRating = age_rating;

        if (category_id !== undefined && subcategory_id === undefined) {
          const mediaResult = await client.query(
            'SELECT subcategory_id FROM media WHERE id = $1',
            [id]
          );
          const media = mediaResult.rows[0];
          if (media && media.subcategory_id) {
            const subResult = await client.query(
              `SELECT * FROM subcategories WHERE category_id = $1 AND name = (
                SELECT name FROM subcategories WHERE id = $2
              )`,
              [category_id, media.subcategory_id]
            );
            if (subResult.rows.length === 0) {
              itemUpdates.subcategoryId = null;
            }
          }
        }

        if (Object.keys(itemUpdates).length === 0) continue;

        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, value] of Object.entries(itemUpdates)) {
          const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
          fields.push(`${dbField} = $${idx}`);
          values.push(value);
          idx++;
        }
        values.push(id);
        await client.query(
          `UPDATE media SET ${fields.join(', ')} WHERE id = $${idx}`,
          values
        );
      }
    });

    res.json({ message: 'Batch update completed', updated: ids.length });
  },

  async delete(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    await db.transaction(async (client) => {
      await client.query('DELETE FROM media WHERE id = $1', [id]);
      await deleteFromS3(media.s3_key);
      await deleteFromS3(media.thumbnail_s3_key);
    });

    res.json({ message: 'Media deleted' });
  },

  async batchDelete(req, res) {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    await db.transaction(async (client) => {
      for (const id of ids) {
        const mediaResult = await client.query(
          'SELECT s3_key, thumbnail_s3_key FROM media WHERE id = $1',
          [id]
        );
        const media = mediaResult.rows[0];
        if (media) {
          await client.query('DELETE FROM media WHERE id = $1', [id]);
          await deleteFromS3(media.s3_key);
          await deleteFromS3(media.thumbnail_s3_key);
        }
      }
    });

    res.json({ message: 'Batch delete completed', deleted: ids.length });
  },
};

async function processFile(buffer, file, { category_id, subcategory_id, age_rating }) {
  const MAX_PHOTO_SIZE = (parseInt(process.env.MAX_PHOTO_SIZE_MB, 10) || 50) * 1024 * 1024;
  const MAX_VIDEO_SIZE = (parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 500) * 1024 * 1024;
  const isImage = file.mimetype.startsWith('image/');
  const maxSize = isImage ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE;
  if (buffer.length > maxSize) {
    throw new Error(`Файл слишком большой. Максимум ${maxSize / 1024 / 1024} МБ`);
  }
  const type = isImage ? 'photo' : 'video';
  const ext = getExtensionFromMimeType(file.mimetype);
  const mediaId = uuidv4();
  const s3Key = `media/${mediaId}${ext}`;
  const thumbnailKey = `thumbnails/${mediaId}_thumb.jpg`;
  const displayKey = isImage ? `display/${mediaId}_display.jpg` : null;
  const tempPaths = [];

  try {
    await uploadToS3(s3Key, buffer, file.mimetype);

    let thumbnailBuffer;
    let displayBuffer = null;
    if (type === 'photo') {
      thumbnailBuffer = await sharp(buffer)
        .resize(400, null, { withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      displayBuffer = await sharp(buffer)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      const tempPath = path.join(__dirname, '../uploads', `${mediaId}_temp${ext}`);
      await fs.writeFile(tempPath, buffer);
      tempPaths.push(tempPath);
      thumbnailBuffer = await generateVideoThumbnail(tempPath);
    }

    await uploadToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg');
    if (displayBuffer && displayKey) {
      await uploadToS3(displayKey, displayBuffer, 'image/jpeg');
    }

    const media = await MediaModel.create({
      type,
      s3Key,
      thumbnailS3Key: thumbnailKey,
      displayS3Key: displayKey,
      fileSize: buffer.length,
      categoryId: category_id || null,
      subcategoryId: subcategory_id || null,
      ageRating: age_rating || null,
    });

    media.url = await getSignedUrlForKey(media.s3_key, SIGN_URL_EXPIRES);
    media.thumbnail_url = await getSignedUrlForKey(media.thumbnail_s3_key, SIGN_URL_EXPIRES);
    media.display_url = displayKey ? await getSignedUrlForKey(media.display_s3_key, SIGN_URL_EXPIRES) : null;

    return media;
  } finally {
    await cleanupTempFiles(tempPaths);
  }
}

async function cleanupTempFiles(paths) {
  for (const p of paths) {
    try {
      await fs.unlink(p);
    } catch {
      // ignore
    }
  }
}

function validateVideoFile(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err) => {
      if (err) {
        return reject(new Error('Файл повреждён или имеет неподдерживаемый видеоформат'));
      }
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

module.exports = MediaController;
