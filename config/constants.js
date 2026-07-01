const SORT_MAP = {
  newest: 'm.uploaded_at DESC',
  oldest: 'm.uploaded_at ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC',
  random: 'RANDOM()',
  name: 'm.s3_key ASC',
};

// When the user picks "Фото" or "Видео" in the sort dropdown, we treat
// it as a type FILTER (not just an ORDER BY) - the controller translates
// these sort keys into a `type` query parameter + the default sort.
const TYPE_SORT_MAP = {
  photos: 'photo',
  videos: 'video',
};

const AGE_RATINGS = [13, 14, 15, 16, 17, 18, 19];

const SIGN_URL_EXPIRES = parseInt(process.env.SIGN_URL_EXPIRES, 10) || 3600;

module.exports = { SORT_MAP, TYPE_SORT_MAP, AGE_RATINGS, SIGN_URL_EXPIRES };
