'use strict';

const { createStore } = require('../../src/store');
const { createPaymentService, PaymentError, MAX_TRANSFER } = require('../../src/services/payments');

function setup() {
  const store = createStore();
  const service = createPaymentService(store);
  const alice = service.openAccount({ owner: 'Alice', currency: 'EUR', initialBalance: 500 });
  const bob = service.openAccount({ owner: 'Bob', currency: 'EUR', initialBalance: 0 });
  return { store, service, alice, bob };
}

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe('openAccount', () => {
  test('defaults currency to EUR and balance to 0', () => {
    const { service } = setup();
    const acc = service.openAccount({ owner: '  Carol  ' });
    expect(service.balanceOf(acc)).toMatchObject({ owner: 'Carol', currency: 'EUR', balance: 0 });
  });

  test.each([
    [{ owner: 'A' }, 'INVALID_OWNER'],
    [{ owner: 42 }, 'INVALID_OWNER'],
    [{ owner: 'Dan', currency: 'JPY' }, 'UNSUPPORTED_CURRENCY'],
    [{ owner: 'Dan', initialBalance: -1 }, 'INVALID_AMOUNT'],
    [{ owner: 'Dan', initialBalance: '10' }, 'INVALID_AMOUNT'],
  ])('rejects %j', (input, code) => {
    const { service } = setup();
    expectError(() => service.openAccount(input), code);
  });
});

describe('transfer', () => {
  test('moves money between accounts', () => {
    const { service, store, alice, bob } = setup();
    const tx = service.transfer({ from: alice.id, to: bob.id, amount: 120.5 });
    expect(tx).toMatchObject({ type: 'TRANSFER', amount: 120.5, currency: 'EUR' });
    expect(service.balanceOf(store.getAccount(alice.id)).balance).toBe(379.5);
    expect(service.balanceOf(store.getAccount(bob.id)).balance).toBe(120.5);
    expect(store.listTransactions(bob.id)).toHaveLength(1);
  });

  test('avoids floating point drift', () => {
    const { service, store, alice, bob } = setup();
    service.transfer({ from: alice.id, to: bob.id, amount: 0.1 });
    service.transfer({ from: alice.id, to: bob.id, amount: 0.2 });
    expect(service.balanceOf(store.getAccount(bob.id)).balance).toBe(0.3);
  });

  test('rejects insufficient funds', () => {
    const { service, alice, bob } = setup();
    expectError(() => service.transfer({ from: bob.id, to: alice.id, amount: 1 }), 'INSUFFICIENT_FUNDS');
  });

  test.each([0, -5, Number.NaN, '10', undefined])('rejects invalid amount %p', (amount) => {
    const { service, alice, bob } = setup();
    expectError(() => service.transfer({ from: alice.id, to: bob.id, amount }), 'INVALID_AMOUNT');
  });

  test('enforces the transfer limit', () => {
    const { service, alice, bob } = setup();
    expectError(() => service.transfer({ from: alice.id, to: bob.id, amount: MAX_TRANSFER + 1 }), 'LIMIT_EXCEEDED');
  });

  test('rejects same account, unknown account and currency mismatch', () => {
    const { service, alice } = setup();
    const usd = service.openAccount({ owner: 'Eve', currency: 'USD' });
    expectError(() => service.transfer({ from: alice.id, to: alice.id, amount: 1 }), 'SAME_ACCOUNT');
    expectError(() => service.transfer({ from: 'nope', to: alice.id, amount: 1 }), 'ACCOUNT_NOT_FOUND');
    expectError(() => service.transfer({ from: alice.id, to: 'nope', amount: 1 }), 'ACCOUNT_NOT_FOUND');
    expectError(() => service.transfer({ from: alice.id, to: usd.id, amount: 1 }), 'CURRENCY_MISMATCH');
  });
});

describe('cardTopUp', () => {
  test('credits the account minus the 1.5% fee and stores only the masked PAN', () => {
    const { service, store, bob } = setup();
    const tx = service.cardTopUp({ accountId: bob.id, amount: 100, cardNumber: '4111 1111 1111 1111' });
    expect(tx).toMatchObject({ fee: 1.5, credited: 98.5, card: { brand: 'VISA', masked: '**** **** **** 1111' } });
    expect(JSON.stringify(tx)).not.toContain('4111111111111111');
    expect(service.balanceOf(store.getAccount(bob.id)).balance).toBe(98.5);
  });

  test('rejects an invalid card', () => {
    const { service, bob } = setup();
    expectError(() => service.cardTopUp({ accountId: bob.id, amount: 10, cardNumber: '1234' }), 'INVALID_CARD');
  });

  test('rejects an unknown account', () => {
    const { service } = setup();
    expectError(() => service.cardTopUp({ accountId: 'nope', amount: 10, cardNumber: '4111111111111111' }), 'ACCOUNT_NOT_FOUND');
  });
});
