'use strict';

// Anti-fraud check before each transfer.
// Uses the vendor's legacy *synchronous* SDK: each call blocks for ~80 ms
// while waiting for the scoring service.
const lock = new Int32Array(new SharedArrayBuffer(4));
const SCORING_LATENCY_MS = 80;

function scoreTransfer({ amount }) {
  Atomics.wait(lock, 0, 0, SCORING_LATENCY_MS); // blocking call (legacy SDK)
  return amount > 5000 ? 'REVIEW' : 'ACCEPT';
}

module.exports = { scoreTransfer };
