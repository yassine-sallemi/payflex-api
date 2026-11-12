'use strict';

// Last line of defense: anything that looks like a card number (PAN) is
// masked before it reaches stdout, so logs never carry raw PII.
const PAN_PATTERN = /\b(?:\d[ -]?){12,18}(\d{4})\b/g;

function redact(value) {
  return value.replace(PAN_PATTERN, '****$1');
}

function write(level, message, fields = {}) {
  if (process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  process.stdout.write(`${redact(line)}\n`);
}

module.exports = {
  redact,
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
