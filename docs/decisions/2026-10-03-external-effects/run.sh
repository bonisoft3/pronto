#!/usr/bin/env bash
# Reproduces the measurements of ../2026-10-03-external-effects.md against throwaway postgres containers.
set -euo pipefail
cd "$(dirname "$0")"
deno=$(cd ../../../../../libraries/mecha && mise which deno)
image=postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8
export NO_COLOR=1 PG_URL=postgres://postgres:pw@localhost:55432/postgres
trap 'docker rm -f external-effects-pg daprd-ee sink-declared sink-undeclared >/dev/null 2>&1; docker network rm external-effects-net >/dev/null 2>&1' EXIT
fresh() {
  docker rm -f external-effects-pg >/dev/null 2>&1 || true
  docker run -d --name external-effects-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 "$image" >/dev/null
  until docker exec external-effects-pg pg_isready -qU postgres; do sleep 1; done
  sleep 2
}
run() { (cd "$1" && shift && "$deno" run -A "$@" 2>&1 | grep -E '^(setup|start|recover|write|work|crash|forge|jobkey|requeue)' || true); }

echo "## DBOS"
fresh
run dbos bare.ts setup
echo "# D1 one workflow id started twice";               run dbos bare.ts start c1
echo "# D2 crash inside a step after the external call"; CRASH=step run dbos bare.ts start c2; run dbos bare.ts recover c2
echo "# D3 crash after a datasource transaction";         CRASH=aftertx run dbos bare.ts start c3; run dbos bare.ts recover c3
run dbos gate.ts setup
echo "# D4 a trigger enqueues with dbos.enqueue_workflow";  ROLLBACK=1 run dbos gate.ts write g0; run dbos gate.ts write g1; run dbos gate.ts work g1
echo "# D5 a finished workflow id enqueued again"
docker exec external-effects-pg psql -qtAU postgres -c "select dbos.enqueue_workflow('charge','cortex', array['{\"id\":\"g1\"}'::json], workflow_id=>'charge:g1')" >/dev/null
docker exec external-effects-pg psql -qtAU postgres -c "select count(*) || ' row, ' || max(status) from dbos.workflow_status where workflow_uuid='charge:g1'"

echo "## Graphile Worker and the ledger"
fresh
run graphile ledger.ts setup
echo "# G1 a job_key deduplicates only while its job exists"; run graphile ledger.ts jobkey b1
echo "# G2 the guard claims and enqueues in the transition's commit"; ROLLBACK=1 run graphile ledger.ts write l0; run graphile ledger.ts write l1
echo "# G3 the task settles through the guard";   run graphile ledger.ts work l1
echo "# G4 a forged outcome is refused";          run graphile ledger.ts write l2; run graphile ledger.ts forge l2
echo "# G5 crash after the call; the next start releases the dead pool's lock and reconciles"
CRASH=1 run graphile ledger.ts work l2; run graphile ledger.ts work l2
echo "# G6 the job delivered again after completion";  run graphile ledger.ts requeue l1

echo "## Dapr, as the airlock's only way out"
daprd=daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125
echo_image=mendhak/http-https-echo:35@sha256:440ca6b810bc04606aac700e461caca5543eaa882c4e0af96a33424d05a23592
docker network create external-effects-net >/dev/null
for sink in sink-declared sink-undeclared; do
  docker run -d --name "$sink" --hostname "$sink" --network external-effects-net "$echo_image" >/dev/null
done
docker run -d --name daprd-ee --network external-effects-net -p 53500:3500 -v "$PWD/dapr/components:/components:ro" "$daprd" \
  ./daprd --app-id airlock --resources-path /components --dapr-http-port 3500 --mode standalone >/dev/null
until curl -sf localhost:53500/v1.0/healthz/outbound >/dev/null; do sleep 1; done
sleep 2
reach() { curl -s -m 5 -X POST -H 'Idempotency-Key: charge:1' -H 'Content-Type: application/json' -d '{"amount":12.5}' "localhost:53500/v1.0/invoke/$1/method/v1/charges" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("reached", d["os"]["hostname"], d["method"], d["path"], "key="+str(d["headers"].get("idempotency-key")), d["body"]) if "os" in d else print("refused", d.get("errorCode"))'; }
echo "# M1 the declared endpoint, by name";         reach acquirer
echo "# M2 an undeclared name";                     reach nosuch
echo "# M3 an undeclared origin, as a full URL";    reach http://sink-undeclared:8080
