'use strict';

/*
 * Pipeline exporter: GitHub Actions runners are ephemeral, Prometheus cannot scrape them.
 * This exporter polls the GitHub API, downloads the "quality-gate-report" artifact of each
 * workflow run (gate-report.json produced by scripts/quality-gate.js) and exposes the
 * indicators in Prometheus format on :9300/metrics.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const PORT = Number(process.env.PORT || 9300);
const INTERVAL = Number(process.env.POLL_SECONDS || 60) * 1000;
const MAX_RUNS = Number(process.env.MAX_RUNS || 30);
const STATUS_VALUE = { PASS: 0, WARNING: 1, CRITICAL: 2 };

if (!REPO || !TOKEN) {
  console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  process.exit(1);
}

const cache = new Map(); // runId -> { run, report }
let lastPoll = 0;
let pollErrors = 0;

async function gh(url, raw = false) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'payflex-pipeline-exporter' },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function loadReport(run) {
  const { artifacts } = await gh(`/repos/${REPO}/actions/runs/${run.id}/artifacts`);
  const artifact = artifacts.find((a) => a.name === 'quality-gate-report' && !a.expired);
  if (!artifact) return null;
  const zip = await gh(artifact.archive_download_url, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.zip'), zip);
    execFileSync('unzip', ['-o', '-q', 'a.zip'], { cwd: dir });
    return JSON.parse(fs.readFileSync(path.join(dir, 'gate-report.json'), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function poll() {
  try {
    const { workflow_runs: runs } = await gh(`/repos/${REPO}/actions/runs?per_page=${MAX_RUNS}`);
    for (const run of runs) {
      if (run.status !== 'completed') continue;
      if (cache.has(run.id)) continue;
      const report = await loadReport(run).catch((e) => { console.error(e.message); return null; });
      cache.set(run.id, { run, report });
      console.log(`run #${run.run_number} ${run.conclusion} -> ${report ? report.status : 'no report'}`);
    }
    lastPoll = Date.now() / 1000;
  } catch (err) {
    pollErrors += 1;
    console.error('poll failed:', err.message);
  }
}

function esc(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function labels(obj) {
  return `{${Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
}

function render() {
  const out = [];
  const families = {};
  const add = (name, help, lbls, value) => {
    if (value === undefined || value === null || Number.isNaN(Number(value))) return;
    if (!families[name]) {
      families[name] = true;
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    }
    out.push(`${name}${labels(lbls)} ${Number(value)}`);
  };

  const entries = [...cache.values()].sort((a, b) => a.run.run_number - b.run.run_number);
  const withReport = entries.filter((e) => e.report);

  for (const { run, report } of withReport) {
    const base = { run: String(run.run_number).padStart(3, '0'), sha: run.head_sha.slice(0, 7), commit: run.display_title.slice(0, 60) };
    const m = report.metrics;
    add('payflex_pipeline_gate_status', 'Quality gate result (0=PASS,1=WARNING,2=CRITICAL)', base, STATUS_VALUE[report.status]);
    add('payflex_pipeline_findings', 'Findings by severity', { ...base, severity: 'critical' }, report.counts.critical);
    add('payflex_pipeline_findings', 'Findings by severity', { ...base, severity: 'warning' }, report.counts.warning);
    add('payflex_pipeline_coverage_pct', 'Line coverage (%)', base, m.coverage_lines_pct);
    add('payflex_pipeline_unit_tests_failed', 'Failed unit tests', base, m.unit_tests_failed);
    add('payflex_pipeline_sonar_code_smells', 'SonarQube code smells', base, m.sonar_code_smells);
    add('payflex_pipeline_sonar_bugs', 'SonarQube bugs', base, m.sonar_bugs);
    add('payflex_pipeline_it_failed', 'Failed integration assertions', base, m.it_failed);
    add('payflex_pipeline_perf_p95_ms', 'k6 p95 latency (ms)', base, m.perf_p95_ms);
    add('payflex_pipeline_perf_error_rate_pct', 'k6 HTTP error rate (%)', base, m.perf_error_rate_pct);
    add('payflex_pipeline_leaks_total', 'Detected leaks (secrets + PII)', base, m.leaks_total);
    add('payflex_pipeline_confidentiality_rate_pct', 'Confidentiality rate (%)', base, m.confidentiality_rate_pct);
    const duration = (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000;
    add('payflex_pipeline_duration_seconds', 'Workflow duration', base, duration);
    for (const job of report.jobs) {
      add('payflex_pipeline_job_success', 'Job result (1=success,0=failure,-1=skipped)', { ...base, job: job.name },
        job.result === 'success' ? 1 : job.result === 'failure' ? 0 : -1);
    }
  }

  const last = withReport.at(-1);
  if (last) {
    const m = last.report.metrics;
    add('payflex_pipeline_last_run_number', 'Last evaluated run', {}, last.run.run_number);
    add('payflex_pipeline_last_gate_status', 'Last quality gate result (0=PASS,1=WARNING,2=CRITICAL)', {}, STATUS_VALUE[last.report.status]);
    add('payflex_pipeline_last_coverage_pct', 'Last coverage', {}, m.coverage_lines_pct);
    add('payflex_pipeline_last_perf_p95_ms', 'Last p95', {}, m.perf_p95_ms);
    add('payflex_pipeline_last_perf_error_rate_pct', 'Last error rate', {}, m.perf_error_rate_pct);
    add('payflex_pipeline_last_confidentiality_rate_pct', 'Last confidentiality rate', {}, m.confidentiality_rate_pct);
    add('payflex_pipeline_last_leaks_total', 'Last leaks', {}, m.leaks_total);
  }

  const byStatus = { PASS: 0, WARNING: 0, CRITICAL: 0 };
  for (const e of withReport) byStatus[e.report.status] += 1;
  for (const [status, n] of Object.entries(byStatus)) add('payflex_pipeline_runs', 'Evaluated runs by gate result', { status }, n);
  add('payflex_exporter_last_poll_timestamp_seconds', 'Last successful poll', {}, lastPoll);
  add('payflex_exporter_poll_errors', 'Poll errors', {}, pollErrors);
  return `${out.join('\n')}\n`;
}

http.createServer((req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    return res.end(render());
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`pipeline exporter on :${PORT} for ${REPO}`));

poll();
setInterval(poll, INTERVAL);
