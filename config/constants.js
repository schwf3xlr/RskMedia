// Secondary sort key (m.id DESC) is required for stable pagination. When many
// records share the same `uploaded_at` (batch uploads land in the same ms),
// PostgreSQL doesn't guarantee order for ties — without a tiebreaker, the
// same row can appear on adjacent pages (visible duplicates in the gallery)
// or get skipped entirely. `id DESC` is a fixed, unique column, so it gives
// a deterministic order that never shifts between LIMIT/OFFSET queries.
//
// `random` is special-cased in the model — a raw `RANDOM()` re-shuffles on
// every query, so LIMIT/OFFSET pagination overlaps between pages (item X
// lands on page 1 in one shuffle and page 2 in the next → visible duplicates
// in the gallery and looping in the modal). The model builds a seeded
// deterministic random via `md5(id::text || seed)` when the caller passes
// a `randomSeed`, so all pages of one "session" share one ordering.
const SORT_MAP = {
  newest: 'm.uploaded_at DESC, m.id DESC',
  oldest: 'm.uploaded_at ASC, m.id ASC',
  age_desc: 'm.age_rating DESC NULLS LAST, m.uploaded_at DESC, m.id DESC',
  age_asc: 'm.age_rating ASC NULLS LAST, m.uploaded_at DESC, m.id DESC',
  random: 'RANDOM()',
  name: 'm.s3_key ASC, m.id DESC',
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
