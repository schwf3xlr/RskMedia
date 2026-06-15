const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'video/webm': [[0x1A, 0x45, 0xDF, 0xA3]],
};

function checkSignature(buffer, signatures) {
  return signatures.some(sig =>
    sig.every((byte, i) => buffer[i] === byte)
  );
}

function hasFtypAt(buffer, offset) {
  if (offset + 4 > buffer.length) return false;
  return buffer[offset] === 0x66 && buffer[offset + 1] === 0x74 &&
         buffer[offset + 2] === 0x79 && buffer[offset + 3] === 0x70;
}

function validateFileType(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;

  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    // ISO base media file format: starts with 4-byte size, then 'ftyp' at offset 4
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x00 && buffer[3] === 0x00) {
      return hasFtypAt(buffer, 4);
    }
    return hasFtypAt(buffer, 4);
  }

  if (mimeType === 'image/webp') {
    if (!checkSignature(buffer, MAGIC_BYTES['image/webp'])) return false;
    // RIFF....WEBP
    return buffer.length >= 12 &&
           buffer[8] === 0x57 && buffer[9] === 0x45 &&
           buffer[10] === 0x42 && buffer[11] === 0x50;
  }

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;
  return checkSignature(buffer, signatures);
}

module.exports = { validateFileType };
