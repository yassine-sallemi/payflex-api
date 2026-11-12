'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createStore } = require('../../src/store');
const { createPaymentService } = require('../../src/services/payments');
const { createStatementService } = require('../../src/services/statements');

function setup() {
  const store = createStore();
  const payments = createPaymentService(store);
  const statements = createStatementService(store);
  const alice = payments.openAccount({ owner: 'Alice', initialBalance: 1000 });
  const bob = payments.openAccount({ owner: 'Bob' });
  return { store, payments, statements, alice, bob };
}

describe('statement service', () => {
  test('summarizes incoming, outgoing and card movements', () => {
    const { payments, statements, alice, bob } = setup();
    payments.transfer({ from: alice.id, to: bob.id, amount: 200 });
    payments.cardTopUp({ accountId: bob.id, amount: 100, cardNumber: '4111111111111111' });
    payments.transfer({ from: bob.id, to: alice.id, amount: 50 });

    const s = statements.build(bob.id);
    expect(s).toMatchObject({ owner: 'Bob', currency: 'EUR', openingBalance: 0, closingBalance: 248.5 });
    expect(s.totals).toEqual({ in: 298.5, out: 50, fees: 1.5, count: 3 });
    expect(s.lines.map((l) => l.direction)).toEqual(['IN', 'IN', 'OUT']);
  });

  test('restricts to a period and recomputes opening/closing balances', () => {
    const { store, payments, statements, alice, bob } = setup();
    payments.transfer({ from: alice.id, to: bob.id, amount: 100 });
    payments.transfer({ from: alice.id, to: bob.id, amount: 30 });
    const [first, second] = store.listTransactions(bob.id);
    first.createdAt = '2026-01-15T10:00:00.000Z';
    second.createdAt = '2026-02-10T10:00:00.000Z';

    const january = statements.build(bob.id, { from: '2026-01-01', to: '2026-01-31' });
    expect(january.totals.count).toBe(1);
    expect(january.openingBalance).toBe(0);
    expect(january.closingBalance).toBe(100);

    const february = statements.build(bob.id, { from: '2026-02-01' });
    expect(february.openingBalance).toBe(100);
    expect(february.closingBalance).toBe(130);
    expect(february.period.to).toBeNull();
  });

  test('groups lines by month', () => {
    const { store, payments, statements, alice, bob } = setup();
    payments.transfer({ from: alice.id, to: bob.id, amount: 10 });
    payments.transfer({ from: bob.id, to: alice.id, amount: 4 });
    payments.transfer({ from: alice.id, to: bob.id, amount: 5 });
    const txs = store.listTransactions(bob.id);
    txs[0].createdAt = '2026-03-01T00:00:00.000Z';
    txs[1].createdAt = '2026-03-02T00:00:00.000Z';
    txs[2].createdAt = '2026-01-05T00:00:00.000Z';

    expect(statements.monthly(statements.build(bob.id))).toEqual([
      { month: '2026-01', in: 5, out: 0, fees: 0, count: 1 },
      { month: '2026-03', in: 10, out: 4, fees: 0, count: 2 },
    ]);
  });

  test('exports CSV without any card number', () => {
    const { payments, statements, bob } = setup();
    payments.cardTopUp({ accountId: bob.id, amount: 20, cardNumber: '5555555555554444' });
    const csv = statements.toCsv(statements.build(bob.id));
    const [header, row] = csv.split('\n');
    expect(header).toBe('date;type;direction;amount;fee;currency;reference');
    expect(row).toMatch(/;CARD_TOPUP;IN;19\.7;0\.3;EUR;/);
    expect(csv).not.toContain('5555555555554444');
  });

  test('validates account, dates and period', () => {
    const { statements, bob } = setup();
    expect(() => statements.build('nope')).toThrow('account not found');
    expect(() => statements.build(bob.id, { from: 'yesterday' })).toThrow('from must be an ISO date');
    expect(() => statements.build(bob.id, { from: '2026-02-01', to: '2026-01-01' })).toThrow('from must be before to');
  });
});

describe('statement routes', () => {
  let app;
  let alice;
  let bob;

  beforeEach(async () => {
    app = createApp();
    alice = (await request(app).post('/accounts').send({ owner: 'Alice', initialBalance: 500 })).body;
    bob = (await request(app).post('/accounts').send({ owner: 'Bob' })).body;
    await request(app).post('/transfers').send({ from: alice.id, to: bob.id, amount: 75 });
  });

  test('GET /accounts/:id/statement returns JSON', async () => {
    const res = await request(app).get(`/accounts/${bob.id}/statement`);
    expect(res.status).toBe(200);
    expect(res.body.closingBalance).toBe(75);
  });

  test('GET /accounts/:id/statement?format=csv returns a CSV attachment', async () => {
    const res = await request(app).get(`/accounts/${bob.id}/statement?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`statement-${bob.id}.csv`);
    expect(res.text.split('\n')).toHaveLength(2);
  });

  test('GET /accounts/:id/statement/monthly returns the monthly breakdown', async () => {
    const res = await request(app).get(`/accounts/${alice.id}/statement/monthly`);
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({ in: 0, out: 75, count: 1 });
  });

  test('invalid period returns 400', async () => {
    const res = await request(app).get(`/accounts/${bob.id}/statement?from=2026-02-01&to=2026-01-01`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PERIOD');
  });
});
