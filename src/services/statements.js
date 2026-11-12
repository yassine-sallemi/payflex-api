'use strict';

const { PaymentError } = require('./payments');

const CSV_HEADER = ['date', 'type', 'direction', 'amount', 'fee', 'currency', 'reference'];

function parseDate(value, name) {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PaymentError(400, 'INVALID_DATE', `${name} must be an ISO date`);
  }
  return date;
}

function direction(tx, accountId) {
  if (tx.type === 'CARD_TOPUP') return 'IN';
  return tx.to === accountId ? 'IN' : 'OUT';
}

function signedAmount(tx, accountId) {
  if (tx.type === 'CARD_TOPUP') return tx.credited;
  return direction(tx, accountId) === 'IN' ? tx.amount : -tx.amount;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function createStatementService(store) {
  return {
    build(accountId, { from, to } = {}) {
      const account = store.getAccount(accountId);
      if (!account) throw new PaymentError(404, 'ACCOUNT_NOT_FOUND', 'account not found');
      const start = parseDate(from, 'from');
      const end = parseDate(to, 'to');
      if (start && end && start > end) {
        throw new PaymentError(400, 'INVALID_PERIOD', 'from must be before to');
      }

      const all = store.listTransactions(accountId);
      const inPeriod = all.filter((tx) => {
        const at = new Date(tx.createdAt);
        return (!start || at >= start) && (!end || at <= end);
      });
      const after = all.filter((tx) => end && new Date(tx.createdAt) > end);

      const closing = round(account.balance / 100 - after.reduce((sum, tx) => sum + signedAmount(tx, accountId), 0));
      const movement = inPeriod.reduce((sum, tx) => sum + signedAmount(tx, accountId), 0);
      const totalIn = inPeriod.filter((tx) => direction(tx, accountId) === 'IN')
        .reduce((sum, tx) => sum + signedAmount(tx, accountId), 0);
      const totalOut = inPeriod.filter((tx) => direction(tx, accountId) === 'OUT')
        .reduce((sum, tx) => sum - signedAmount(tx, accountId), 0);
      const fees = inPeriod.reduce((sum, tx) => sum + (tx.fee || 0), 0);

      return {
        accountId,
        owner: account.owner,
        currency: account.currency,
        period: { from: start ? start.toISOString() : null, to: end ? end.toISOString() : null },
        openingBalance: round(closing - movement),
        closingBalance: closing,
        totals: { in: round(totalIn), out: round(totalOut), fees: round(fees), count: inPeriod.length },
        lines: inPeriod.map((tx) => ({
          date: tx.createdAt,
          type: tx.type,
          direction: direction(tx, accountId),
          amount: round(Math.abs(signedAmount(tx, accountId))),
          fee: tx.fee || 0,
          currency: tx.currency,
          reference: tx.id,
        })),
      };
    },

    monthly(statement) {
      const months = new Map();
      for (const line of statement.lines) {
        const key = line.date.slice(0, 7);
        const month = months.get(key) || { month: key, in: 0, out: 0, fees: 0, count: 0 };
        if (line.direction === 'IN') month.in = round(month.in + line.amount);
        else month.out = round(month.out + line.amount);
        month.fees = round(month.fees + line.fee);
        month.count += 1;
        months.set(key, month);
      }
      return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
    },

    toCsv(statement) {
      const rows = statement.lines.map((line) => CSV_HEADER.map((key) => String(line[key])).join(';'));
      return [CSV_HEADER.join(';'), ...rows].join('\n');
    },
  };
}

module.exports = { createStatementService };
