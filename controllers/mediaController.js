const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const MediaModel = require('../models/media');
const { uploadToS3, deleteFromS3, getSignedUrlForKey } = require('../config/s3');
const { validateFileType } = require('../helpers/fileValidator');

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
      sort,
    });

    const mediaWithUrls = await Promise.all(
      media.map(async (m) => ({
        ...m,
        url: await getSignedUrlForKey(m.s3_key),
        thumbnail_url: await getSignedUrlForKey(m.thumbnail_s3_key),
      }))
    );

    res.json({ media: mediaWithUrls, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  },

  async getById(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    media.url = await getSignedUrlForKey(media.s3_key);
    media.thumbnail_url = await getSignedUrlForKey(media.thumbnail_s3_key);

    res.json(media);
  },

  async uploadSingle(req, res) {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });
      if (!validateFileType(file.buffer, file.mimetype)) {
        return res.status(400).json({ error: 'Содержимое файла не соответствует его типу' });
      }

      const { category_id, subcategory_id, age_rating } = req.body;
      const type = file.mimetype.startsWith('image/') ? 'photo' : 'video';
      const ext = path.extname(file.originalname);
      const mediaId = uuidv4();
      const s3Key = `media/${mediaId}${ext}`;
      const thumbnailKey = `thumbnails/${mediaId}_thumb.jpg`;

      await uploadToS3(s3Key, file.buffer, file.mimetype);

      let thumbnailBuffer;
      if (type === 'photo') {
        thumbnailBuffer = await sharp(file.buffer)
          .resize(400, null, { withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      } else {
        const tempPath = path.join(__dirname, '../uploads', `${mediaId}_temp${ext}`);
        await fs.writeFile(tempPath, file.buffer);
        thumbnailBuffer = await generateVideoThumbnail(tempPath);
        await fs.unlink(tempPath);
      }

      await uploadToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg');

      const media = await MediaModel.create({
        type,
        s3Key,
        thumbnailS3Key: thumbnailKey,
        categoryId: category_id || null,
        subcategoryId: subcategory_id || null,
        ageRating: age_rating || null,
      });

      res.status(201).json(media);
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  },

  async uploadMultiple(req, res) {
    try {
      const files = req.files;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      for (const file of files) {
        if (!validateFileType(file.buffer, file.mimetype)) {
          return res.status(400).json({ error: `Файл ${file.originalname} не соответствует своему типу` });
        }
      }

      const { category_id, subcategory_id, age_rating } = req.body;
      const results = [];

      for (let i = 0; i < files.length; i += 2) {
        const batch = files.slice(i, i + 2);
        const batchPromises = batch.map(file => processFile(file, { category_id, subcategory_id, age_rating }));
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }

      res.status(201).json({ uploaded: results.length, media: results });
    } catch (err) {
      console.error('Batch upload error:', err);
      res.status(500).json({ error: 'Batch upload failed' });
    }
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

    if (category_id !== undefined && subcategory_id === undefined) {
      for (const id of ids) {
        const media = await MediaModel.getById(id);
        if (media && media.subcategory_id) {
          const db = require('../config/database');
          const subResult = await db.query(
            'SELECT * FROM subcategories WHERE category_id = $1 AND name = (SELECT name FROM subcategories WHERE id = $2)',
            [category_id, media.subcategory_id]
          );
          if (subResult.rows.length === 0) {
            updates.subcategoryId = null;
          }
        }
        await MediaModel.update(id, updates);
      }
    } else {
      for (const id of ids) {
        await MediaModel.update(id, updates);
      }
    }

    res.json({ message: 'Batch update completed', updated: ids.length });
  },

  async delete(req, res) {
    const { id } = req.params;
    const media = await MediaModel.getById(id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    await deleteFromS3(media.s3_key);
    await deleteFromS3(media.thumbnail_s3_key);

    await MediaModel.delete(id);

    res.json({ message: 'Media deleted' });
  },

  async batchDelete(req, res) {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    for (const id of ids) {
      const media = await MediaModel.getById(id);
      if (media) {
        await deleteFromS3(media.s3_key);
        await deleteFromS3(media.thumbnail_s3_key);
        await MediaModel.delete(id);
      }
    }

    res.json({ message: 'Batch delete completed', deleted: ids.length });
  },
};

async function processFile(file, { category_id, subcategory_id, age_rating }) {
  const type = file.mimetype.startsWith('image/') ? 'photo' : 'video';
  const ext = path.extname(file.originalname);
  const mediaId = uuidv4();
  const s3Key = `media/${mediaId}${ext}`;
  const thumbnailKey = `thumbnails/${mediaId}_thumb.jpg`;

  await uploadToS3(s3Key, file.buffer, file.mimetype);

  let thumbnailBuffer;
  if (type === 'photo') {
    thumbnailBuffer = await sharp(file.buffer)
      .resize(400, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } else {
    const tempPath = path.join(__dirname, '../uploads', `${mediaId}_temp${ext}`);
    await fs.writeFile(tempPath, file.buffer);
    thumbnailBuffer = await generateVideoThumbnail(tempPath);
    await fs.unlink(tempPath);
  }

  await uploadToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg');

  const media = await MediaModel.create({
    type,
    s3Key,
    thumbnailS3Key: thumbnailKey,
    categoryId: category_id || null,
    subcategoryId: subcategory_id || null,
    ageRating: age_rating || null,
  });

  return media;
}

function generateVideoThumbnail(videoPath) {
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
        const buffer = await fs.readFile(thumbPath);
        await fs.unlink(thumbPath);
        resolve(buffer);
      })
      .on('error', reject);
  });
}

module.exports = MediaController;
