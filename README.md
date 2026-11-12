# PayFlex API — Pipeline CI/CD intelligent

API REST de services financiers (Node.js / Express) servant de cible à un pipeline CI/CD
GitHub Actions avec **Quality Gate** (classification Critique / Non-critique) et
**Taux de Confidentialité** (détection de fuites de secrets et de PII).

## API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/health` | Sonde de vie |
| GET | `/metrics` | Métriques Prometheus |
| POST/GET | `/accounts`, `/accounts/:id` | Ouverture / consultation de compte |
| GET | `/accounts/:id/transactions` | Historique |
| POST | `/transfers` | Virement entre comptes |
| POST | `/payments/card` | Rechargement par carte (PAN masqué, frais 1,5 %) |

```bash
npm ci && npm start          # http://localhost:3000
npm test                     # Jest + couverture
```

## Pipeline (`.github/workflows/main.yml`)

```
1. Confidentialité (source + commits) ─► 2. Tests unitaires ─► 3. SonarQube ─► 4. Build + scan artefact
   ─► 5. Intégration (Docker + Newman + scan des logs) ─► 6. Performance (k6) ─► 7. Rapport Quality Gate ─► 8. Déploiement
```

Chaque étape exécute `scripts/quality-gate.js <étape>` qui classe chaque indicateur :

| Indicateur | Non-critique (alerte, le pipeline continue) | Critique (Fail Fast, pas de déploiement) |
|---|---|---|
| Couverture | 70 % ≤ couverture < 80 % | < 70 % |
| Tests UT / IT | – | au moins un test en échec |
| SonarQube | code smells, bugs mineurs | Quality Gate KO, bug bloquant |
| Performance k6 | p95 entre 200 et 500 ms, erreurs 1–2 % | p95 > 500 ms ou erreurs > 2 % |
| Confidentialité | – | toute fuite (taux < 100 %) |

Seuils : `quality-gate.config.json`. Règles de détection : `.gitleaks.toml`.

Taux de Confidentialité = `(1 − fuites / max(seuil toléré, 1)) × 100`, borné à [0, 100]
(le seuil toléré est 0 : la formule du sujet est ramenée à « 0 fuite = 100 %, sinon 0 % »).

## Observabilité (bonus)

`observability/` : exporter du pipeline + Prometheus + Grafana. Voir `observability/README.md`.
