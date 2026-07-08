// Read from the <meta name="app-config"> emitted by views/partials/header.ejs.
// The server-side value in config/constants.js is authoritative — this used
// to be a hardcoded copy that drifted when someone changed one side and
// forgot the other (13-19 vs. 13-18 mid-2025 was one such incident).
const fallback = { ageRatings: [13, 14, 15, 16, 17, 18, 19] };

function readConfig() {
  try {
    const raw = document.querySelector('meta[name="app-config"]')?.content;
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const APP_CONFIG = readConfig();

export const AGE_RATINGS = APP_CONFIG.ageRatings || fallback.ageRatings;
export const MAX_PHOTO_SIZE_MB = APP_CONFIG.maxPhotoSizeMb || 50;
export const MAX_VIDEO_SIZE_MB = APP_CONFIG.maxVideoSizeMb || 500;
export const MAX_FILE_SIZE_MB = APP_CONFIG.maxFileSizeMb || 500;
export const MAX_BATCH_FILES = APP_CONFIG.maxBatchFiles || 100;
