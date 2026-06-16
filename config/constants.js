const SORT_MAP = {
  newest: 'm.uploaded_at DESC',
  oldest: 'm.uploaded_at ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC',
  photo_first: "m.type = 'photo' DESC, m.uploaded_at DESC",
  video_first: "m.type = 'video' DESC, m.uploaded_at DESC",
  name: 'm.s3_key ASC',
};

const AGE_RATINGS = [13, 14, 15, 16, 17, 18, 19];

const SIGN_URL_EXPIRES = parseInt(process.env.SIGN_URL_EXPIRES, 10) || 3600;

module.exports = { SORT_MAP, AGE_RATINGS, SIGN_URL_EXPIRES };
