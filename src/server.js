'use strict';

const { createApp } = require('./app');
const log = require('./lib/logger');

const port = Number(process.env.PORT) || 3000;
const server = createApp().listen(port, () => log.info('payflex-api listening', { port }));

function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
