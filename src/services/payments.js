'use strict';

const card = require('../lib/card');

const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'TND'];
const MAX_TRANSFER = 10_000;
const CARD_FEE_RATE = 0.015;

class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Amounts are handled in cents to avoid floating point drift. */
function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
  return cents / 100;
}

function assertAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError(400, 'INVALID_AMOUNT', 'amount must be a positive number');
  }
  if (amount > MAX_TRANSFER) {
    throw new PaymentError(422, 'LIMIT_EXCEEDED', `amount exceeds the ${MAX_TRANSFER} limit`);
  }
}

function createPaymentService(store) {
  function requireAccount(id, role) {
    const account = store.getAccount(id);
    if (!account) throw new PaymentError(404, 'ACCOUNT_NOT_FOUND', `${role} account not found`);
    return account;
  }

  return {
    openAccount({ owner, currency = 'EUR', initialBalance = 0 }) {
      if (typeof owner !== 'string' || owner.trim().length < 2) {
        throw new PaymentError(400, 'INVALID_OWNER', 'owner must be at least 2 characters');
      }
      if (!SUPPORTED_CURRENCIES.includes(currency)) {
        throw new PaymentError(400, 'UNSUPPORTED_CURRENCY', `currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}`);
      }
      if (typeof initialBalance !== 'number' || initialBalance < 0) {
        throw new PaymentError(400, 'INVALID_AMOUNT', 'initialBalance must be a non-negative number');
      }
      return store.createAccount({ owner: owner.trim(), currency, balance: toCents(initialBalance) });
    },

    transfer({ from, to, amount }) {
      assertAmount(amount);
      if (from === to) throw new PaymentError(400, 'SAME_ACCOUNT', 'cannot transfer to the same account');
      const source = requireAccount(from, 'source');
      const target = requireAccount(to, 'target');
      if (source.currency !== target.currency) {
        throw new PaymentError(422, 'CURRENCY_MISMATCH', 'accounts use different currencies');
      }
      const cents = toCents(amount);
      if (source.balance < cents) throw new PaymentError(422, 'INSUFFICIENT_FUNDS', 'insufficient funds');

      source.balance -= cents;
      target.balance += cents;
      return store.addTransaction({ type: 'TRANSFER', from, to, amount, currency: source.currency });
    },

    cardTopUp({ accountId, amount, cardNumber }) {
      assertAmount(amount);
      const account = requireAccount(accountId, 'target');
      const digits = card.normalize(cardNumber);
      if (!card.luhnValid(digits)) throw new PaymentError(400, 'INVALID_CARD', 'card number is invalid');

      const fee = Math.ceil(toCents(amount) * CARD_FEE_RATE);
      const credited = toCents(amount) - fee;
      account.balance += credited;
      // Only the masked PAN is ever stored or returned.
      return store.addTransaction({
        type: 'CARD_TOPUP',
        accountId,
        amount,
        fee: fromCents(fee),
        credited: fromCents(credited),
        currency: account.currency,
        card: { brand: card.brand(digits), masked: card.mask(digits) },
      });
    },

    balanceOf(account) {
      return { ...account, balance: fromCents(account.balance) };
    },
  };
}

module.exports = { createPaymentService, PaymentError, SUPPORTED_CURRENCIES, MAX_TRANSFER, CARD_FEE_RATE };
