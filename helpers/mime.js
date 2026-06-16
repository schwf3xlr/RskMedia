const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

function getExtensionFromMimeType(mimeType) {
  return MIME_TO_EXT[mimeType] || '';
}

module.exports = { getExtensionFromMimeType };
