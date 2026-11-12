'use strict';

const crypto = require('node:crypto');

const FINGERPRINT_PEPPER = process.env.CARD_PEPPER || 'payflex-dev-pepper';

/** Luhn checksum for a string of digits. */
function luhnValid(digits) {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function normalize(cardNumber) {
  return String(cardNumber ?? '').replace(/[\s-]/g, '');
}

function brand(digits) {
  if (/^4/.test(digits)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'MASTERCARD';
  if (/^3[47]/.test(digits)) return 'AMEX';
  return 'UNKNOWN';
}

/** PCI-DSS style masking: keep only the last 4 digits. */
function mask(digits) {
  return `**** **** **** ${digits.slice(-4)}`;
}

/**
 * Irreversible card fingerprint, used to detect the same card across top-ups.
 * Keyed hash (HMAC-SHA256 + secret pepper): irreversible without the key and
 * computed in microseconds. A slow KDF (PBKDF2) is meant for passwords, not for
 * a hot request path: it blocked the event loop (p95 > 500 ms, pipeline #8).
 */
function fingerprint(digits) {
  return crypto.createHmac('sha256', FINGERPRINT_PEPPER).update(digits).digest('hex');
}

module.exports = { luhnValid, normalize, brand, mask, fingerprint };
