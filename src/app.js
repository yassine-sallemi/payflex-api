'use strict';

const express = require('express');
const { createStore } = require('./store');
const { createPaymentService, PaymentError } = require('./services/payments');
const { createMetrics } = require('./metrics');
const log = require('./lib/logger');

function createApp({ store = createStore() } = {}) {
  const app = express();
  const payments = createPaymentService(store);
  const metrics = createMetrics();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(metrics.middleware);

  app.get('/health', (req, res) => {
    res.json({ status: 'UP', service: 'payflex-api', version: process.env.APP_VERSION || 'dev' });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  app.post('/accounts', (req, res) => {
    const account = payments.openAccount(req.body ?? {});
    log.info('account opened', { accountId: account.id });
    res.status(201).json(payments.balanceOf(account));
  });

  app.get('/accounts', (req, res) => {
    res.json(store.listAccounts().map((a) => payments.balanceOf(a)));
  });

  app.get('/accounts/:id', (req, res) => {
    const account = store.getAccount(req.params.id);
    if (!account) throw new PaymentError(404, 'ACCOUNT_NOT_FOUND', 'account not found');
    res.json(payments.balanceOf(account));
  });

  app.get('/accounts/:id/transactions', (req, res) => {
    if (!store.getAccount(req.params.id)) throw new PaymentError(404, 'ACCOUNT_NOT_FOUND', 'account not found');
    res.json(store.listTransactions(req.params.id));
  });

  app.post('/transfers', (req, res) => {
    try {
      const tx = payments.transfer(req.body ?? {});
      metrics.paymentsTotal.inc({ type: 'transfer', outcome: 'success' });
      log.info('transfer completed', { txId: tx.id, amount: tx.amount });
      res.status(201).json(tx);
    } catch (err) {
      metrics.paymentsTotal.inc({ type: 'transfer', outcome: 'rejected' });
      throw err;
    }
  });

  app.post('/payments/card', (req, res) => {
    try {
      const tx = payments.cardTopUp(req.body ?? {});
      metrics.paymentsTotal.inc({ type: 'card', outcome: 'success' });
      log.info('card top-up completed', { txId: tx.id, card: tx.card.masked });
      res.status(201).json(tx);
    } catch (err) {
      metrics.paymentsTotal.inc({ type: 'card', outcome: 'rejected' });
      throw err;
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: `${req.method} ${req.path} does not exist` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof PaymentError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'INVALID_JSON', message: 'request body is not valid JSON' });
    }
    log.error('unhandled error', { error: err.message });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'unexpected error' });
  });

  return app;
}

module.exports = { createApp };
