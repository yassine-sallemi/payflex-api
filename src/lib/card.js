'use strict';

const crypto = require('node:crypto');

// OWASP recommendation for PBKDF2-HMAC-SHA512.
const FINGERPRINT_ITERATIONS = 210_000;
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

/** Irreversible card fingerprint, used to detect the same card across top-ups. */
function fingerprint(digits) {
  return crypto.pbkdf2Sync(digits, FINGERPRINT_PEPPER, FINGERPRINT_ITERATIONS, 32, 'sha512').toString('hex');
}

module.exports = { luhnValid, normalize, brand, mask, fingerprint };
