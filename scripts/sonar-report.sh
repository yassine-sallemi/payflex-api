#!/usr/bin/env bash
# Collects the Quality Gate status and key measures of the last analysis into reports/sonar.json
set -euo pipefail
S="${SONAR_URL:-http://localhost:9000}"
A="admin:${SONAR_ADMIN_PASSWORD:?missing}"
KEY="${SONAR_PROJECT_KEY:-payflex-api}"
METRICS="coverage,line_coverage,bugs,code_smells,sqale_index,reliability_issues,software_quality_blocker_issues,software_quality_security_issues,software_quality_reliability_rating,ncloc,duplicated_lines_density"

# wait for the background Compute Engine task to finish
for _ in $(seq 1 60); do
  q=$(curl -sf -u "$A" "$S/api/ce/component?component=$KEY")
  echo "$q" | grep -q '"queue":\[\]' && ! echo "$q" | grep -q '"status":"IN_PROGRESS"' && break
  sleep 2
done

mkdir -p reports
gate=$(curl -sf -u "$A" "$S/api/qualitygates/project_status?projectKey=$KEY")
measures=$(curl -sf -u "$A" "$S/api/measures/component?component=$KEY&metricKeys=$METRICS")
issues=$(curl -sf -u "$A" "$S/api/issues/search?componentKeys=$KEY&resolved=false&ps=50")
node -e '
const [gate, measures, issues] = process.argv.slice(1).map(JSON.parse);
const out = {
  qualityGate: gate.projectStatus,
  measures: measures.component.measures,
  issues: issues.issues.map(i => ({ severity: i.severity, impacts: i.impacts, rule: i.rule, file: i.component.split(":").pop(), line: i.line, message: i.message })),
};
require("fs").writeFileSync("reports/sonar.json", JSON.stringify(out, null, 2));
console.log("Quality Gate SonarQube :", out.qualityGate.status);
' "$gate" "$measures" "$issues"
