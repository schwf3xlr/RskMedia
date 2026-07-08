// In-process pub/sub for Server-Sent Events. Two indexes:
//   - byToken: fingerprint -> Set<res>   (targeted delivery, e.g. auth.revoked)
//   - broadcast: Set<res>                (global events, e.g. media.created)
//
// Kept in-process on purpose: this app runs as one node process behind pm2
// (single instance). If you fan out to multiple replicas later, swap this
// module for a Redis pub/sub without touching the callers — the surface is
// small: attach(res, tokenId), publishToToken, broadcast.
const logger = require('./logger');

const byToken = new Map();
const broadcast = new Set();

// SSE requires periodic writes or the intermediate proxies (nginx, cloud LB)
// will close the connection at their idle timeout. A comment line — the
// smallest legal SSE payload — costs almost nothing and keeps NAT open.
const KEEPALIVE_MS = 25000;

function attach(res, tokenId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disables buffering when behind nginx
  });
  res.write('retry: 5000\n\n');

  broadcast.add(res);
  if (tokenId) {
    if (!byToken.has(tokenId)) byToken.set(tokenId, new Set());
    byToken.get(tokenId).add(res);
  }

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* dead socket cleanup below */ }
  }, KEEPALIVE_MS);
  keepalive.unref();

  const cleanup = () => {
    clearInterval(keepalive);
    broadcast.delete(res);
    if (tokenId) {
      const set = byToken.get(tokenId);
      if (set) {
        set.delete(res);
        if (set.size === 0) byToken.delete(tokenId);
      }
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  logger.debug({ tokenId, clients: broadcast.size }, 'SSE client attached');
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    // socket half-open — attach()'s cleanup runs on the 'close' event
    return false;
  }
}

function publishToToken(tokenId, event, data, opts = {}) {
  const set = byToken.get(tokenId);
  if (!set) return 0;
  let count = 0;
  for (const res of set) {
    // exclude the caller's own socket by response reference — used for
    // "notify OTHER sessions of my token" (concurrent-login toast)
    if (opts.exceptRes && res === opts.exceptRes) continue;
    if (send(res, event, data)) count++;
  }
  return count;
}

function publishBroadcast(event, data) {
  let count = 0;
  for (const res of broadcast) {
    if (send(res, event, data)) count++;
  }
  return count;
}

module.exports = { attach, publishToToken, publishBroadcast };
