import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const OUT = __ENV.SUMMARY_FILE || 'reports/k6-summary.json';
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  scenarios: {
    payments: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  // Critical thresholds (Étape 3): breaching them stops the test and fails the stage.
  // The 200 ms target is evaluated afterwards by the quality gate as a WARNING band.
  thresholds: {
    http_req_duration: [{ threshold: 'p(95)<500', abortOnFail: true, delayAbortEval: '10s' }],
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '10s' }],
  },
};

export function setup() {
  const res = http.post(`${BASE_URL}/accounts`, JSON.stringify({ owner: 'LoadTest', initialBalance: 10000 }), JSON_HEADERS);
  const target = http.post(`${BASE_URL}/accounts`, JSON.stringify({ owner: 'Merchant' }), JSON_HEADERS);
  return { source: res.json('id'), target: target.json('id') };
}

export default function (data) {
  const health = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
  check(health, { 'health 200': (r) => r.status === 200 });

  const transfer = http.post(
    `${BASE_URL}/transfers`,
    JSON.stringify({ from: data.source, to: data.target, amount: 0.01 }),
    { ...JSON_HEADERS, tags: { name: 'transfer' } },
  );
  check(transfer, { 'transfer 201': (r) => r.status === 201 });

  const topUp = http.post(
    `${BASE_URL}/payments/card`,
    JSON.stringify({ accountId: data.target, amount: 5, cardNumber: '4111111111111111' }),
    { ...JSON_HEADERS, tags: { name: 'card' } },
  );
  check(topUp, { 'card 201': (r) => r.status === 201 });

  const account = http.get(`${BASE_URL}/accounts/${data.source}`, { tags: { name: 'account' } });
  check(account, { 'account 200': (r) => r.status === 200 });

  sleep(0.2);
}

export function handleSummary(data) {
  const m = data.metrics;
  const summary = {
    p95_ms: m.http_req_duration.values['p(95)'],
    avg_ms: m.http_req_duration.values.avg,
    error_rate: m.http_req_failed.values.rate,
    requests: m.http_reqs.values.count,
    rps: m.http_reqs.values.rate,
    checks_rate: m.checks ? m.checks.values.rate : null,
    thresholds_ok: Object.values(m).every((metric) => !metric.thresholds || Object.values(metric.thresholds).every((t) => t.ok)),
  };
  return {
    stdout: `\nk6 summary: p95=${summary.p95_ms.toFixed(1)}ms errors=${(summary.error_rate * 100).toFixed(2)}% requests=${summary.requests}\n`,
    [OUT]: JSON.stringify(summary, null, 2),
  };
}
