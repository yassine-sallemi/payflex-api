#!/usr/bin/env node
'use strict';

/*
 * PayFlex Quality Gate — classifies every collected indicator as
 *   PASS      : within target
 *   WARNING   : non-critical (pipeline continues, alert is raised)
 *   CRITICAL  : blocking (stage fails -> Fail Fast, no deployment)
 *
 * Usage:
 *   node scripts/quality-gate.js unit
 *   node scripts/quality-gate.js sonar
 *   node scripts/quality-gate.js integration
 *   node scripts/quality-gate.js perf
 *   node scripts/quality-gate.js confidentiality <scope> [<scope> ...]   (reads reports/gitleaks-<scope>.json)
 *   node scripts/quality-gate.js report                                  (aggregates reports/gate/*.json)
 *
 * Each stage writes reports/gate/<id>.json, a Markdown table to $GITHUB_STEP_SUMMARY,
 * GitHub annotations (::warning:: / ::error::) and exits 1 on CRITICAL.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const GATE_DIR = path.join(REPORTS, 'gate');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'quality-gate.config.json'), 'utf8'));

const SEVERITY_RANK = { PASS: 0, WARNING: 1, CRITICAL: 2 };
const ICON = { PASS: '🟢', WARNING: '🟡', CRITICAL: '🔴' };
const LABEL = { PASS: 'OK', WARNING: 'Non-critique', CRITICAL: 'Critique' };

const SCOPE_LABEL = {
  source: 'Code source & configuration',
  history: 'Historique Git (commits poussés)',
  artifact: 'Artefact de build (image Docker)',
  logs: "Logs d'exécution (tests d'intégration)",
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readJson(file, fallback = undefined) {
  const full = path.isAbsolute(file) ? file : path.join(REPORTS, file);
  if (!fs.existsSync(full)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`rapport introuvable : ${path.relative(ROOT, full)}`);
  }
  const raw = fs.readFileSync(full, 'utf8').trim();
  return raw ? JSON.parse(raw) : fallback;
}

function finding(indicator, severity, value, expected, message) {
  return { indicator, severity, value, expected, message };
}

function worst(findings) {
  return findings.reduce((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'PASS');
}

const pct = (v) => `${Number(v).toFixed(1)} %`;
const ms = (v) => `${Number(v).toFixed(1)} ms`;

// ---------------------------------------------------------------------------
// stage evaluators — each returns { title, findings, metrics }
// ---------------------------------------------------------------------------
const evaluators = {
  unit() {
    const results = readJson('jest-results.json');
    const summary = readJson('coverage/coverage-summary.json');
    const coverage = summary.total.lines.pct;
    const { warningBelow, criticalBelow } = CONFIG.coverage;
    const findings = [];

    const failed = results.numFailedTests;
    findings.push(failed > 0
      ? finding('Tests unitaires', 'CRITICAL', `${failed}/${results.numTotalTests} en échec`, '0 échec',
        `Régression détectée : ${failedTestNames(results).slice(0, 5).join(' ; ')}`)
      : finding('Tests unitaires', 'PASS', `${results.numPassedTests}/${results.numTotalTests} réussis`, '0 échec', 'Aucune régression'));

    if (coverage < criticalBelow) {
      findings.push(finding('Couverture de code', 'CRITICAL', pct(coverage), `≥ ${criticalBelow} %`,
        `Couverture à ${pct(coverage)}, sous le seuil critique de ${criticalBelow} %`));
    } else if (coverage < warningBelow) {
      findings.push(finding('Couverture de code', 'WARNING', pct(coverage), `≥ ${warningBelow} %`,
        `Attention, couverture à ${pct(coverage)} (objectif ${warningBelow} %)`));
    } else {
      findings.push(finding('Couverture de code', 'PASS', pct(coverage), `≥ ${warningBelow} %`, 'Objectif de couverture atteint'));
    }

    return {
      title: 'Tests unitaires & couverture',
      findings,
      metrics: {
        unit_tests_total: results.numTotalTests,
        unit_tests_failed: failed,
        coverage_lines_pct: coverage,
        coverage_branches_pct: summary.total.branches.pct,
      },
    };
  },

  sonar() {
    const sonar = readJson('sonar.json');
    const m = Object.fromEntries(sonar.measures.map((x) => [x.metric, x.value]));
    const findings = [];

    const failing = (sonar.qualityGate.conditions || []).filter((c) => c.status === 'ERROR');
    findings.push(sonar.qualityGate.status === 'OK'
      ? finding('SonarQube Quality Gate', 'PASS', 'OK', 'OK', 'Quality Gate SonarQube validé')
      : finding('SonarQube Quality Gate', 'CRITICAL', sonar.qualityGate.status, 'OK',
        `Conditions en échec : ${failing.map((c) => `${c.metricKey} = ${c.actualValue} (seuil ${c.comparator} ${c.errorThreshold})`).join(', ')}`));

    const reliability = JSON.parse(m.reliability_issues || '{}');
    const blocking = Number(m.software_quality_blocker_issues || 0) + Number(reliability.HIGH || 0);
    const minorBugs = Number(reliability.LOW || 0) + Number(reliability.MEDIUM || 0);
    if (blocking > 0) {
      findings.push(finding('Bugs bloquants', 'CRITICAL', blocking, '0',
        `${blocking} bug(s) bloquant(s)/majeur(s) (ex. accès à une valeur null potentielle)`));
    } else if (minorBugs > 0) {
      findings.push(finding('Bugs mineurs', 'WARNING', minorBugs, '0', `${minorBugs} bug(s) mineur(s) à corriger`));
    } else {
      findings.push(finding('Bugs', 'PASS', 0, '0', 'Aucun bug détecté'));
    }

    const smells = Number(m.code_smells || 0);
    findings.push(smells > CONFIG.sonar.codeSmellsWarningAbove
      ? finding('Code smells (dette technique)', 'WARNING', smells, '0',
        `${smells} code smell(s), dette technique ${m.sqale_index || 0} min`)
      : finding('Code smells (dette technique)', 'PASS', smells, '0', 'Pas de dette technique'));

    const vulns = Number(m.software_quality_security_issues || 0);
    if (vulns > 0) findings.push(finding('Vulnérabilités', 'WARNING', vulns, '0', `${vulns} problème(s) de sécurité signalé(s)`));

    return {
      title: 'Analyse statique SonarQube',
      findings,
      metrics: {
        sonar_gate_ok: sonar.qualityGate.status === 'OK' ? 1 : 0,
        sonar_bugs: Number(m.bugs || 0),
        sonar_code_smells: smells,
        sonar_blocker_issues: Number(m.software_quality_blocker_issues || 0),
        sonar_coverage_pct: Number(m.coverage || 0),
        sonar_debt_minutes: Number(m.sqale_index || 0),
      },
      links: sonar.dashboard ? { SonarQube: sonar.dashboard } : undefined,
    };
  },

  integration() {
    const newman = readJson('newman.json');
    const { stats, failures, timings } = newman.run;
    const failed = stats.assertions.failed + stats.requests.failed;
    const findings = [failed > 0
      ? finding('Scénario API (Newman)', 'CRITICAL', `${failed} échec(s)`, '0 échec',
        `Contrat d'API rompu : ${failures.slice(0, 5).map((f) => `[${f.source.name}] ${f.error.message}`).join(' ; ')}`)
      : finding('Scénario API (Newman)', 'PASS', `${stats.assertions.total} assertions OK`, '0 échec',
        `${stats.requests.total} requêtes, contrat respecté`)];

    return {
      title: "Tests d'intégration (conteneur éphémère + Newman)",
      findings,
      metrics: {
        it_requests: stats.requests.total,
        it_assertions: stats.assertions.total,
        it_failed: failed,
        it_avg_response_ms: timings.responseAverage,
      },
    };
  },

  perf() {
    const s = readJson('k6-summary.json', null);
    if (!s) {
      return {
        title: 'Tests de performance (k6)',
        findings: [finding('Tir de charge k6', 'CRITICAL', 'aucun résultat', 'rapport k6', "k6 n'a produit aucun résultat (crash de l'application ?)")],
        metrics: {},
      };
    }
    const P = CONFIG.performance;
    const findings = [];

    if (s.p95_ms > P.p95CriticalMs) {
      findings.push(finding('Latence p95', 'CRITICAL', ms(s.p95_ms), `≤ ${P.p95CriticalMs} ms`,
        `Chute de performance : p95 = ${ms(s.p95_ms)} > ${P.p95CriticalMs} ms`));
    } else if (s.p95_ms > P.p95WarningMs) {
      findings.push(finding('Latence p95', 'WARNING', ms(s.p95_ms), `≤ ${P.p95WarningMs} ms`,
        `Attention, latence p95 à ${ms(s.p95_ms)} (objectif ${P.p95WarningMs} ms)`));
    } else {
      findings.push(finding('Latence p95', 'PASS', ms(s.p95_ms), `≤ ${P.p95WarningMs} ms`, 'Latence conforme'));
    }

    const rate = s.error_rate * 100;
    if (s.error_rate > P.errorRateCritical) {
      findings.push(finding("Taux d'erreur HTTP", 'CRITICAL', pct(rate), `≤ ${P.errorRateCritical * 100} %`,
        `Taux d'erreur ${pct(rate)} > ${P.errorRateCritical * 100} %`));
    } else if (s.error_rate > P.errorRateWarning) {
      findings.push(finding("Taux d'erreur HTTP", 'WARNING', pct(rate), `< ${P.errorRateWarning * 100} %`,
        `Attention, taux d'erreur à ${pct(rate)}`));
    } else {
      findings.push(finding("Taux d'erreur HTTP", 'PASS', pct(rate), `< ${P.errorRateWarning * 100} %`, "Taux d'erreur conforme"));
    }

    if (s.thresholds_ok === false) {
      findings.push(finding('Seuils k6', 'CRITICAL', 'abortOnFail', 'seuils respectés',
        'Tir interrompu par k6 : un seuil critique a été franchi'));
    }

    return {
      title: 'Tests de performance (k6)',
      findings,
      metrics: {
        perf_p95_ms: s.p95_ms,
        perf_avg_ms: s.avg_ms,
        perf_error_rate_pct: rate,
        perf_requests: s.requests,
        perf_rps: s.rps,
      },
    };
  },

  confidentiality(scopes) {
    if (scopes.length === 0) throw new Error('confidentiality : préciser au moins un scope');
    const { maxToleratedLeaks, requiredRate } = CONFIG.confidentiality;
    const findings = [];
    const metrics = {};
    let total = 0;

    for (const scope of scopes) {
      const leaks = readJson(`gitleaks-${scope}.json`, []);
      total += leaks.length;
      metrics[`leaks_${scope}`] = leaks.length;
      const label = SCOPE_LABEL[scope] || scope;
      if (leaks.length === 0) {
        findings.push(finding(`Fuites : ${label}`, 'PASS', '0', '0', 'Aucune donnée sensible détectée'));
      } else {
        const detail = leaks.slice(0, 8).map((l) => `${l.RuleID} → ${l.File}:${l.StartLine}${l.Commit ? ` (commit ${l.Commit.slice(0, 7)})` : ''}`);
        findings.push(finding(`Fuites : ${label}`, 'CRITICAL', String(leaks.length), '0',
          `Donnée sensible détectée : ${detail.join(' ; ')}`));
      }
    }

    const rate = confidentialityRate(total, maxToleratedLeaks);
    findings.push(finding('Taux de Confidentialité', rate >= requiredRate ? 'PASS' : 'CRITICAL', pct(rate), `= ${requiredRate} %`,
      rate >= requiredRate ? 'Aucune fuite' : `${total} fuite(s) détectée(s), taux ${pct(rate)} < ${requiredRate} %`));

    return {
      id: `confidentiality-${scopes.join('-')}`,
      title: `Confidentialité (${scopes.map((s) => SCOPE_LABEL[s] || s).join(', ')})`,
      findings,
      metrics: { ...metrics, leaks_total: total, confidentiality_rate_pct: rate },
    };
  },
};

/**
 * Taux = (1 - fuites / seuil toléré) × 100. Le seuil toléré est 0 dans le sujet,
 * ce qui rend la formule indéfinie : on borne le dénominateur à 1 et le résultat à [0, 100].
 * => 0 fuite = 100 %, toute fuite = 0 % (avec seuil 0).
 */
function confidentialityRate(leaks, tolerated) {
  return 100 * (1 - Math.min(1, leaks / Math.max(tolerated, 1)));
}

function failedTestNames(results) {
  return results.testResults.flatMap((file) =>
    file.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
function escapeCell(v) {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function stageMarkdown(r) {
  const lines = [
    `### ${ICON[r.status]} ${r.title} — ${LABEL[r.status]}`,
    '',
    '| Indicateur | Valeur | Attendu | Classification | Détail |',
    '|---|---|---|---|---|',
    ...r.findings.map((f) => `| ${escapeCell(f.indicator)} | ${escapeCell(f.value)} | ${escapeCell(f.expected)} | ${ICON[f.severity]} ${LABEL[f.severity]} | ${escapeCell(f.message)} |`),
    '',
  ];
  if (r.links) lines.push(...Object.entries(r.links).map(([k, v]) => `- ${k} : ${v}`), '');
  return lines.join('\n');
}

function annotate(r) {
  if (!process.env.GITHUB_ACTIONS) return;
  for (const f of r.findings) {
    if (f.severity === 'WARNING') console.log(`::warning title=Quality Gate (non-critique) - ${f.indicator}::${f.message}`);
    if (f.severity === 'CRITICAL') console.log(`::error title=Quality Gate (CRITIQUE) - ${f.indicator}::${f.message}`);
  }
}

function appendSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

function runStage(stage, args) {
  let result;
  try {
    result = evaluators[stage](args);
  } catch (err) {
    // A missing/corrupted report is itself a blocking problem: never deploy blind.
    result = {
      title: stage,
      findings: [finding(`Évaluation ${stage}`, 'CRITICAL', 'erreur', 'rapport valide', err.message)],
      metrics: {},
    };
  }
  const id = result.id || stage;
  const record = {
    id,
    stage,
    title: result.title,
    status: worst(result.findings),
    findings: result.findings,
    metrics: result.metrics,
    links: result.links,
    evaluatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(GATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(GATE_DIR, `${id}.json`), JSON.stringify(record, null, 2));

  const md = stageMarkdown(record);
  console.log(md);
  appendSummary(md);
  annotate(record);
  return record;
}

// ---------------------------------------------------------------------------
// final report (aggregation + incident report)
// ---------------------------------------------------------------------------
const PIPELINE_STAGES = [
  ['secrets-scan', 'Scan de confidentialité (source)'],
  ['unit-tests', 'Tests unitaires'],
  ['sonarqube', 'SonarQube'],
  ['build', 'Build & scan artefact'],
  ['integration-tests', "Tests d'intégration"],
  ['performance-tests', 'Tests de performance'],
];

function runReport() {
  const records = fs.existsSync(GATE_DIR)
    ? fs.readdirSync(GATE_DIR).filter((f) => f.endsWith('.json') && f !== 'gate-report.json')
      .map((f) => JSON.parse(fs.readFileSync(path.join(GATE_DIR, f), 'utf8')))
    : [];
  const needs = process.env.NEEDS_JSON ? JSON.parse(process.env.NEEDS_JSON) : {};
  const jobs = PIPELINE_STAGES.map(([id, name]) => ({ id, name, result: needs[id]?.result ?? 'unknown' }));

  const all = records.flatMap((r) => r.findings.map((f) => ({ ...f, stage: r.title })));
  const critical = all.filter((f) => f.severity === 'CRITICAL');
  const warnings = all.filter((f) => f.severity === 'WARNING');
  const failedJobs = jobs.filter((j) => j.result === 'failure');
  const skippedJobs = jobs.filter((j) => ['skipped', 'cancelled'].includes(j.result));

  let status = worst(all);
  if (failedJobs.length > 0 || records.length === 0) status = 'CRITICAL';

  const metrics = Object.assign({}, ...records.map((r) => r.metrics));
  const leaks = records.filter((r) => r.stage === 'confidentiality').reduce((n, r) => n + (r.metrics.leaks_total || 0), 0);
  metrics.leaks_total = leaks;
  metrics.confidentiality_rate_pct = confidentialityRate(leaks, CONFIG.confidentiality.maxToleratedLeaks);

  const run = {
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF_NAME,
    actor: process.env.GITHUB_ACTOR,
    runId: process.env.GITHUB_RUN_ID,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    url: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
  };

  const report = {
    status,
    decision: status === 'CRITICAL' ? 'DÉPLOIEMENT BLOQUÉ' : 'DÉPLOIEMENT AUTORISÉ',
    run,
    counts: { critical: critical.length, warning: warnings.length, pass: all.length - critical.length - warnings.length },
    jobs,
    metrics,
    critical,
    warnings,
    stages: records,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(GATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'gate-report.json'), JSON.stringify(report, null, 2));

  const md = reportMarkdown(report, failedJobs, skippedJobs);
  fs.writeFileSync(path.join(REPORTS, status === 'CRITICAL' ? 'incident-report.md' : 'gate-report.md'), md);
  console.log(md);
  appendSummary(md);
  if (process.env.GITHUB_ACTIONS) {
    for (const w of warnings) console.log(`::warning title=Alerte non-critique (${w.stage})::${w.message}`);
    if (status === 'CRITICAL') console.log(`::error title=Pipeline bloqué::${critical.map((c) => c.message).join(' | ') || 'étape en échec'}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\nwarnings=${warnings.length}\ncritical=${critical.length}\n`);
  }
  return report;
}

function reportMarkdown(r, failedJobs, skippedJobs) {
  const L = [];
  if (r.status === 'CRITICAL') {
    L.push('# 🚨 Rapport d\'incident — Pipeline interrompu (Fail Fast)', '');
    L.push(`> **Décision : ${r.decision}.** Les étapes suivantes ont été annulées, aucun déploiement n'a eu lieu.`, '');
    L.push('## Cause(s) exacte(s) du blocage', '');
    if (r.critical.length) {
      L.push('| Étape | Indicateur | Valeur | Attendu | Cause |', '|---|---|---|---|---|');
      for (const c of r.critical) L.push(`| ${escapeCell(c.stage)} | ${escapeCell(c.indicator)} | ${escapeCell(c.value)} | ${escapeCell(c.expected)} | ${escapeCell(c.message)} |`);
    } else {
      L.push(`Étape(s) en échec sans rapport d'évaluation : ${failedJobs.map((j) => j.name).join(', ')} (voir les logs du job).`);
    }
    L.push('');
  } else {
    const head = r.status === 'WARNING' ? '🟡 Pipeline validé avec alertes non-critiques' : '🟢 Pipeline validé — tous les critères au vert';
    L.push(`# ${head}`, '', `> **Décision : ${r.decision}.**`, '');
  }

  L.push('## Synthèse des indicateurs', '');
  L.push('| Indicateur | Valeur |', '|---|---|');
  const m = r.metrics;
  const rows = [
    ['Tests unitaires', m.unit_tests_total !== undefined ? `${m.unit_tests_total - m.unit_tests_failed}/${m.unit_tests_total}` : 'n/a'],
    ['Couverture (lignes)', m.coverage_lines_pct !== undefined ? pct(m.coverage_lines_pct) : 'n/a'],
    ['SonarQube : bugs / code smells', m.sonar_bugs !== undefined ? `${m.sonar_bugs} / ${m.sonar_code_smells}` : 'n/a'],
    ['Intégration : assertions en échec', m.it_failed !== undefined ? `${m.it_failed}/${m.it_assertions}` : 'n/a'],
    ['Performance : p95', m.perf_p95_ms !== undefined ? ms(m.perf_p95_ms) : 'n/a'],
    ["Performance : taux d'erreur", m.perf_error_rate_pct !== undefined ? pct(m.perf_error_rate_pct) : 'n/a'],
    ['Fuites détectées', String(m.leaks_total)],
    ['**Taux de Confidentialité**', `**${pct(m.confidentiality_rate_pct)}**`],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push('');

  if (r.warnings.length) {
    L.push('## Alertes non-critiques (le pipeline continue)', '');
    for (const w of r.warnings) L.push(`- 🟡 **${w.indicator}** (${w.stage}) : ${w.message}`);
    L.push('');
  }

  L.push('## État des étapes', '', '| Étape | Résultat |', '|---|---|');
  const icon = { success: '✅', failure: '❌', skipped: '⏭️ annulée (Fail Fast)', cancelled: '⏹️ annulée', unknown: '—' };
  for (const j of r.jobs) L.push(`| ${j.name} | ${icon[j.result] || j.result} |`);
  L.push('');
  if (r.status === 'CRITICAL' && skippedJobs.length) {
    L.push(`Étapes non exécutées suite au blocage : ${skippedJobs.map((j) => j.name).join(', ')}, Déploiement.`, '');
  }

  L.push('## Contexte', '');
  L.push(`- Commit : \`${(r.run.sha || 'local').slice(0, 7)}\` sur \`${r.run.ref || '-'}\` par ${r.run.actor || '-'}`);
  if (r.run.url) L.push(`- Exécution : ${r.run.url}`);
  L.push(`- Généré le : ${r.generatedAt}`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
if (require.main === module) {
  const [stage, ...args] = process.argv.slice(2);
  if (stage === 'report') {
    const report = runReport();
    process.exit(report.status === 'CRITICAL' ? 1 : 0);
  }
  if (!evaluators[stage]) {
    console.error(`stage inconnu : ${stage}. Attendu : ${Object.keys(evaluators).join(', ')}, report`);
    process.exit(2);
  }
  const record = runStage(stage, args);
  process.exit(record.status === 'CRITICAL' ? 1 : 0);
}

module.exports = { confidentialityRate, evaluators, worst };
