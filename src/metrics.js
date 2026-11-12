'use strict';

const client = require('prom-client');

function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'payflex_' });

  const httpDuration = new client.Histogram({
    name: 'payflex_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [registry],
  });

  const paymentsTotal = new client.Counter({
    name: 'payflex_payments_total',
    help: 'Payment operations by type and outcome',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  });

  function middleware(req, res, next) {
    const end = httpDuration.startTimer({ method: req.method });
    res.on('finish', () => {
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      end({ route, status: res.statusCode });
    });
    next();
  }

  return { registry, middleware, paymentsTotal };
}

module.exports = { createMetrics };
