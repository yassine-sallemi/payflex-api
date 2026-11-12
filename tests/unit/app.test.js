'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('HTTP API', () => {
  let app;
  let alice;
  let bob;

  beforeEach(async () => {
    app = createApp();
    alice = (await request(app).post('/accounts').send({ owner: 'Alice', initialBalance: 1000 })).body;
    bob = (await request(app).post('/accounts').send({ owner: 'Bob' })).body;
  });

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'UP', service: 'payflex-api' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('GET /metrics exposes Prometheus metrics', async () => {
    await request(app).get('/health');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('payflex_http_request_duration_seconds');
  });

  test('accounts can be created, listed and read', async () => {
    expect(alice).toMatchObject({ owner: 'Alice', balance: 1000, currency: 'EUR' });
    const list = await request(app).get('/accounts');
    expect(list.body).toHaveLength(2);
    const one = await request(app).get(`/accounts/${bob.id}`);
    expect(one.body.owner).toBe('Bob');
  });

  test('POST /accounts validates input', async () => {
    const res = await request(app).post('/accounts').send({ owner: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_OWNER');
  });

  test('unknown account returns 404', async () => {
    expect((await request(app).get('/accounts/nope')).status).toBe(404);
    expect((await request(app).get('/accounts/nope/transactions')).status).toBe(404);
  });

  test('transfer flow updates balances and history', async () => {
    const tx = await request(app).post('/transfers').send({ from: alice.id, to: bob.id, amount: 250 });
    expect(tx.status).toBe(201);
    expect((await request(app).get(`/accounts/${bob.id}`)).body.balance).toBe(250);
    const history = await request(app).get(`/accounts/${alice.id}/transactions`);
    expect(history.body).toHaveLength(1);
  });

  test('rejected transfer returns a business error', async () => {
    const res = await request(app).post('/transfers').send({ from: bob.id, to: alice.id, amount: 5 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
  });

  test('card top-up never echoes the full card number', async () => {
    const res = await request(app).post('/payments/card').send({ accountId: bob.id, amount: 50, cardNumber: '5555555555554444' });
    expect(res.status).toBe(201);
    expect(res.text).not.toContain('5555555555554444');
    expect(res.body.card.masked).toBe('**** **** **** 4444');
  });

  test('invalid card is rejected', async () => {
    const res = await request(app).post('/payments/card').send({ accountId: bob.id, amount: 50, cardNumber: '1111' });
    expect(res.status).toBe(400);
  });

  test('malformed JSON returns 400', async () => {
    const res = await request(app).post('/transfers').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_JSON');
  });

  test('unknown route returns 404', async () => {
    const res = await request(app).get('/nothing');
    expect(res.status).toBe(404);
  });

  test('unexpected errors return 500 without leaking details', async () => {
    const brokenStore = { listAccounts: () => { throw new Error('db down'); } };
    const res = await request(createApp({ store: brokenStore })).get('/accounts');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'unexpected error' });
  });
});
