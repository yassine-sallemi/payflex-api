# Observabilité du pipeline (bonus)

Les runners GitHub Actions sont éphémères : Prometheus ne peut pas les « scraper ».
Chaque exécution publie donc son évaluation (`gate-report.json`, artefact `quality-gate-report`) ;
le **pipeline-exporter** interroge l'API GitHub, télécharge ces rapports et les expose au format Prometheus.

```
GitHub Actions ──(artefact gate-report.json)──► pipeline-exporter :9300 ◄── Prometheus :9090 ──► Grafana :3001
                                     payflex-api :3000 (/metrics) ◄──┘
```

```bash
GITHUB_TOKEN=$(gh auth token) docker compose up -d --build
# Grafana : http://localhost:3001  (tableau « PayFlex — Pipeline CI/CD & Quality Gate »)
```

| Métrique | Description |
|---|---|
| `payflex_pipeline_gate_status{run}` | 0 = PASS, 1 = WARNING, 2 = CRITIQUE |
| `payflex_pipeline_coverage_pct{run}` | Couverture de lignes |
| `payflex_pipeline_perf_p95_ms{run}` / `_perf_error_rate_pct` | Résultats k6 |
| `payflex_pipeline_confidentiality_rate_pct{run}` / `_leaks_total` | Taux de Confidentialité / fuites |
| `payflex_pipeline_job_success{run,job}` | Résultat de chaque étape (1, 0, -1 = annulée) |
| `payflex_http_request_duration_seconds` | Latence runtime de l'API (prom-client) |
