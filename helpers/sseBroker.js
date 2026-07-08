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
// The keepalive also serves as a dead-socket probe: if the client's tab
// closed but the OS hasn't told us via FIN yet, the next write throws and
// cleanup() runs. 10s balances quick eviction against wasted bytes.
const KEEPALIVE_MS = 10000;

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

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepalive);
    broadcast.delete(res);
    if (tokenId) {
      const set = byToken.get(tokenId);
      if (set) {
        set.delete(res);
        if (set.size === 0) byToken.delete(tokenId);
      }
    }
    // Force socket teardown in case Node didn't notice the peer FIN yet.
    // Without this, a stale connection sits in broadcast (until GC) and
    // counts against the browser's 6-per-origin HTTP/1.1 cap on the next
    // page load, which manifests as "site hangs" while the browser waits
    // for a connection slot.
    try { res.end(); } catch {}
    try { res.destroy(); } catch {}
    logger.debug({ tokenId, clients: broadcast.size }, 'SSE client detached');
  };

  const keepalive = setInterval(() => {
    // A failed write means the socket is half-open; trigger cleanup
    // immediately instead of waiting for another event loop turn.
    try { res.write(': keepalive\n\n'); }
    catch { cleanup(); }
  }, KEEPALIVE_MS);
  keepalive.unref();

  res.on('close', cleanup);
  res.on('error', cleanup);
  res.req?.on('close', cleanup);
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
