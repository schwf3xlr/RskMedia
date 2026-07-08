// Shared URL enrichment for media rows. Extracted from mediaController /
// adminController / favoritesController which each carried near-identical
// copies — the three drifted (favorites lost parallelism, admin returned an
// awkward inline result) and the drift is exactly the kind of thing that
// bites when someone flips USE_MEDIA_PROXY at deploy time and only one of
// the three controllers respects it correctly.
const env = require('../config/env');
const { getSignedUrlForKey } = require('../config/s3');

const USE_PROXY = env.USE_MEDIA_PROXY;
const SIGN_EXPIRES = env.SIGN_URL_EXPIRES;

function proxyUrl(req, type, id) {
  return `${req.protocol}://${req.get('host')}/media/${type}/${id}`;
}

function enrichProxy(row, req) {
  const out = {
    ...row,
    url: proxyUrl(req, 'original', row.id),
    thumbnail_url: proxyUrl(req, 'thumb', row.id),
  };
  if (row.display_s3_key) out.display_url = proxyUrl(req, 'display', row.id);
  if (row.preview_s3_key) out.preview_url = proxyUrl(req, 'preview', row.id);
  return out;
}

async function enrichSigned(row) {
  const [url, thumbnail_url, display_url, preview_url] = await Promise.all([
    getSignedUrlForKey(row.s3_key, SIGN_EXPIRES),
    getSignedUrlForKey(row.thumbnail_s3_key, SIGN_EXPIRES),
    row.display_s3_key ? getSignedUrlForKey(row.display_s3_key, SIGN_EXPIRES) : null,
    row.preview_s3_key ? getSignedUrlForKey(row.preview_s3_key, SIGN_EXPIRES) : null,
  ]);
  return { ...row, url, thumbnail_url, display_url, preview_url };
}

async function enrichOne(row, req) {
  if (USE_PROXY) return enrichProxy(row, req);
  return enrichSigned(row);
}

async function enrichMany(rows, req) {
  if (USE_PROXY) return rows.map(r => enrichProxy(r, req));
  return Promise.all(rows.map(enrichSigned));
}

module.exports = { enrichOne, enrichMany, proxyUrl };
