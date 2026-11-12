'use strict';

const card = require('../../src/lib/card');

// Public test PANs published by card networks (not real cards).
const VISA_TEST = '4111111111111111';
const MC_TEST = '5555555555554444';
const AMEX_TEST = '378282246310005';

describe('card utilities', () => {
  test.each([VISA_TEST, MC_TEST, AMEX_TEST])('accepts valid Luhn number %s', (pan) => {
    expect(card.luhnValid(pan)).toBe(true);
  });

  test('rejects a number with a bad checksum', () => {
    expect(card.luhnValid('4111111111111112')).toBe(false);
  });

  test('rejects non-digit and too-short input', () => {
    expect(card.luhnValid('4111-abc')).toBe(false);
    expect(card.luhnValid('4111')).toBe(false);
  });

  test('normalizes spaces and dashes', () => {
    expect(card.normalize('4111 1111-1111 1111')).toBe(VISA_TEST);
    expect(card.normalize(undefined)).toBe('');
  });

  test('detects the brand', () => {
    expect(card.brand(VISA_TEST)).toBe('VISA');
    expect(card.brand(MC_TEST)).toBe('MASTERCARD');
    expect(card.brand(AMEX_TEST)).toBe('AMEX');
    expect(card.brand('6011111111111117')).toBe('UNKNOWN');
  });

  test('fingerprints are deterministic, distinct and never contain the PAN', () => {
    const fp = card.fingerprint(VISA_TEST);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(card.fingerprint(VISA_TEST)).toBe(fp);
    expect(card.fingerprint(MC_TEST)).not.toBe(fp);
    expect(fp).not.toContain(VISA_TEST);
  });

  test('masks all but the last 4 digits', () => {
    expect(card.mask(VISA_TEST)).toBe('**** **** **** 1111');
  });
});
