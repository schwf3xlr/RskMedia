const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

const bucket = process.env.S3_BUCKET;

async function uploadToS3(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  return `${process.env.S3_ENDPOINT}/${bucket}/${key}`;
}

async function deleteFromS3(key) {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  await s3Client.send(command);
}

const urlCache = new Map();

async function getSignedUrlForKey(key, expiresIn = 3600) {
  const cached = urlCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.url;
  }
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn });
  urlCache.set(key, { url, expiresAt: Date.now() + expiresIn * 1000 });
  return url;
}

module.exports = {
  s3Client,
  uploadToS3,
  deleteFromS3,
  getSignedUrlForKey,
  bucket,
};
