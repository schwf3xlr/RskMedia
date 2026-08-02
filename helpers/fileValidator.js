// JPEG-подсигнатура — ослаблена до FF D8 (было FF D8 FF). Формально по
// стандарту JPEG обязано начинаться с FF D8 FF <marker>, но реальность
// шире: Samsung Motion Photo и некоторые обработчики иногда вставляют
// прокладки между SOI (FF D8) и первым сегментом. FF D8 сама по себе
// уникальна для JPEG (SOI marker), false-positive'ов быть не должно.
const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8]],
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

// HEIC/HEIF использует ISO BMFF-контейнер (тот же формат-семейство, что и
// MP4): байты 4-7 = 'ftyp', далее brand в 8-11 (heic/heix/mif1/msf1/hevc и
// т.п.). iOS и некоторые Android-камеры сохраняют HEIC под именем .jpg с
// mime image/jpeg — принимаем такие файлы как JPEG-совместимые (sharp
// умеет их читать, если libvips собран с libheif; иначе выкинет позже).
function looksLikeHeic(buffer) {
  if (!hasFtypAt(buffer, 4)) return false;
  if (buffer.length < 12) return false;
  const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

// WebP: RIFF ....size.... WEBP. Android часто сохраняет чат-картинки как
// WebP, но браузер при drag&drop даёт им mime image/jpeg по расширению.
function looksLikeWebp(buffer) {
  if (buffer.length < 12) return false;
  return buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
         buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
}

// PNG-signature: телефоны иногда шлют скриншоты как .jpg.
function looksLikePng(buffer) {
  return checkSignature(buffer, MAGIC_BYTES['image/png']);
}

// GIF: тоже встречается под именем .jpg.
function looksLikeGif(buffer) {
  return checkSignature(buffer, MAGIC_BYTES['image/gif']);
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

  // JPEG: mime image/jpeg часто ставится по расширению .jpg, а внутри
  // может лежать что угодно из "картиночных" форматов. Принимаем любой
  // формат, который наш image-pipeline (sharp через libvips) точно
  // умеет читать: JPEG, HEIC, WebP, PNG, GIF. Это уводит проблему из
  // валидатора magic bytes в валидатор sharp'а — если sharp не осилит,
  // упадёт с осмысленным сообщением ниже по стеку.
  if (mimeType === 'image/jpeg') {
    return checkSignature(buffer, MAGIC_BYTES['image/jpeg'])
      || looksLikeHeic(buffer)
      || looksLikeWebp(buffer)
      || looksLikePng(buffer)
      || looksLikeGif(buffer);
  }

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;
  return checkSignature(buffer, signatures);
}

module.exports = { validateFileType };
