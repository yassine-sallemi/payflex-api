'use strict';

const { randomUUID } = require('node:crypto');

/** In-memory persistence. Enough for a test target; swap for a DB in real life. */
function createStore() {
  const accounts = new Map();
  const transactions = [];

  return {
    createAccount({ owner, currency, balance }) {
      const account = { id: randomUUID(), owner, currency, balance, createdAt: new Date().toISOString() };
      accounts.set(account.id, account);
      return account;
    },
    getAccount(id) {
      return accounts.get(id) ?? null;
    },
    listAccounts() {
      return [...accounts.values()];
    },
    addTransaction(tx) {
      const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...tx };
      transactions.push(record);
      return record;
    },
    listTransactions(accountId) {
      return transactions.filter((t) => t.from === accountId || t.to === accountId || t.accountId === accountId);
    },
  };
}

module.exports = { createStore };
