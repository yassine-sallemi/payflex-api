#!/usr/bin/env bash
# Bootstraps an ephemeral SonarQube CE: admin password, analysis token and the
# "PayFlex" quality gate (critical thresholds of Étape 3). Prints the token.
set -euo pipefail
S="${SONAR_URL:-http://localhost:9000}"
PASS="${SONAR_ADMIN_PASSWORD:?missing}"

for _ in $(seq 1 90); do
  curl -sf "$S/api/system/status" | grep -q '"status":"UP"' && break
  sleep 3
done

# Public factory default of a throwaway container, replaced immediately.
DEFAULT_CREDS="admin:admin" # gitleaks:allow
curl -sf -u "$DEFAULT_CREDS" -X POST "$S/api/users/change_password" \
  -d "login=admin&previousPassword=admin&password=$PASS" >/dev/null || true
A="admin:$PASS"

curl -sf -u "$A" -X POST "$S/api/qualitygates/create" -d "name=PayFlex" >/dev/null || true
cond() { curl -sf -u "$A" -X POST "$S/api/qualitygates/create_condition" \
  -d "gateName=PayFlex&metric=$1&op=$2&error=$3" >/dev/null; }
cond line_coverage LT 70                         # line coverage < 70 %   -> critical
cond software_quality_blocker_issues GT 0        # any blocker issue      -> critical
cond software_quality_reliability_rating GT 3    # high/blocker bug (D/E) -> critical
cond software_quality_security_rating GT 3       # high/blocker vuln      -> critical
curl -sf -u "$A" -X POST "$S/api/qualitygates/set_as_default" -d "name=PayFlex" >/dev/null

curl -sf -u "$A" -X POST "$S/api/user_tokens/generate" \
  -d "name=ci-$RANDOM&type=GLOBAL_ANALYSIS_TOKEN" | sed -E 's/.*"token":"([^"]+)".*/\1/'
