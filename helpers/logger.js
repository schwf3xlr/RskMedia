// Structured logger. In production emits JSON lines that log aggregators
// (Loki, Datadog, etc.) can parse without a regex; in dev pretty-prints so
// tailing the process is readable. Downstream code should prefer
// logger.info/warn/error over console.* — console goes uncorrelated
// straight to stdout, but pino attaches pid, hostname, timestamp, and lets
// child() carry request-scoped context (token_id, request id) without
// re-passing it through every call.
const pino = require('pino');
const env = require('../config/env');

// pino-pretty is a peer dep only worth pulling in for dev. Feature-detect it
// so a prod deploy that trims devDependencies doesn't crash at boot on a
// missing transport.
let transport;
if (!env.isProd) {
  try {
    require.resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } };
  } catch {
    // No pretty printer available — fall through to JSON, still readable.
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || (env.isProd ? 'info' : 'debug'),
  base: { app: 'rskmedia' },
  redact: {
    // Never let a JWT or bcrypt hash land in the logs. redact walks the log
    // object at write time and blanks these keys wherever they appear.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.token',
      'password',
      'jwt_hash',
      'token_hash',
    ],
    censor: '[REDACTED]',
  },
  transport,
});

module.exports = logger;
