#!/usr/bin/env node
// Concatenate + minimally-minify base.css + layout.css + components.css +
// pages.css + style.css into a single public/css/style.min.css. No external
// deps — just fs and a light regex pass to strip comments and collapse
// whitespace. Good enough to save 4 round-trips + reduce transfer by ~35%
// without pulling in postcss/cssnano.
const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const ORDER = ['base.css', 'layout.css', 'components.css', 'pages.css', 'style.css'];
const OUT = path.join(CSS_DIR, 'style.min.css');

function minify(css) {
  return css
    // block comments — keep license /*! */ comments intact
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, '')
    // collapse whitespace between tokens (crude but safe for our stylesheet)
    .replace(/\s+/g, ' ')
    // tighten around delimiters
    .replace(/\s*([{};:,>+~])\s*/g, '$1')
    // drop trailing semicolons before }
    .replace(/;}/g, '}')
    .trim();
}

const chunks = [];
for (const name of ORDER) {
  const p = path.join(CSS_DIR, name);
  if (!fs.existsSync(p)) {
    console.warn(`build-css: skipping missing ${name}`);
    continue;
  }
  chunks.push(`/* ${name} */\n` + fs.readFileSync(p, 'utf-8'));
}
const combined = chunks.join('\n');
const minified = minify(combined);
fs.writeFileSync(OUT, minified, 'utf-8');
console.log(`build-css: wrote ${OUT} (${(minified.length / 1024).toFixed(1)} KB, from ${(combined.length / 1024).toFixed(1)} KB source)`);
