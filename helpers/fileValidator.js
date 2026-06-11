const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'video/mp4': [[0x00, 0x00, 0x00]],
  'video/webm': [[0x1A, 0x45, 0xDF, 0xA3]],
  'video/quicktime': [[0x00, 0x00, 0x00]],
};

function validateFileType(buffer, mimeType) {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;

  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    return buffer.includes('ftyp') && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x00;
  }

  if (mimeType === 'image/webp') {
    return buffer.includes('WEBP');
  }

  return signatures.some(sig =>
    sig.every((byte, i) => buffer[i] === byte)
  );
}

module.exports = { validateFileType };
