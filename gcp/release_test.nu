#!/usr/bin/env nu
# Run with: nu gcp/release_test.nu
#
# release@gcp's go-live (release.nu), run against a gcloud and a curl that are shell scripts
# on the PATH: gcloud keeps a service's traffic in a state file, as Cloud Run does, and curl
# answers from a script of what each address says. Nothing here reaches a project.

const gcp_dir = path self .

use std/assert
use release.nu [hold-traffic poll-health preflight invoker_probe sql-drift]

# A directory holding the fakes and the state they share.
def fakes [service_exists: bool, serving: string, candidate_says: string, public_says: string]: nothing -> string {
	let d = (mktemp -d)
	mkdir ($d | path join bin)
	$serving | save -f ($d | path join serving)
	$candidate_says | save -f ($d | path join candidate_says)
	$public_says | save -f ($d | path join public_says)
	if $service_exists { "" | save -f ($d | path join exists) }
	r#'
#!/bin/sh
d="$(dirname "$0")/.."
echo "$*" >> "$d/gcloud.log"
[ -z "$GCLOUD_SLOW" ] || sleep "$GCLOUD_SLOW"
case "$*" in
  *"services describe"*)
    [ -f "$d/exists" ] || { echo "NOT_FOUND: not found" >&2; exit 1; }
    s="$(cat "$d/serving")"
    echo "{\"status\":{\"traffic\":[{\"revisionName\":\"$s\",\"percent\":100},{\"revisionName\":\"svc-00002-new\",\"percent\":0,\"tag\":\"next\",\"url\":\"https://next---svc-1.r.run.app\"}]}}" ;;
  *"revisions list"*)
    s="$(cat "$d/serving")"
    echo "[{\"metadata\":{\"name\":\"svc-00002-new\",\"creationTimestamp\":\"2\",\"labels\":{\"pronto-schema\":\"a\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}},{\"metadata\":{\"name\":\"svc-00001-old\",\"creationTimestamp\":\"1\",\"labels\":{\"pronto-schema\":\"a\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}]" ;;
  *"get-iam-policy"*)
    # The policy as Cloud Run holds it: allUsers an invoker once a file says it was granted.
    if [ -f "$d/granted" ]; then echo '{"bindings":[{"role":"roles/run.invoker","members":["allUsers"]}],"etag":"x"}'; else echo '{"etag":"x"}'; fi ;;
  *"images describe"*) cat "$d/tagged_digest" 2>/dev/null ;;
  *"projects describe"*) echo 123 ;;
  *"services replace"*"--dry-run"*)
    # Cloud Run's own refusal of a reserved name, as a sidecar apart that sets PORT met.
    f="$(echo "$*" | sed 's/.*replace \([^ ]*\) .*/\1/')"
    if grep -Eq "name: (PORT|BAD_RESERVED)$" "$f"; then echo "ERROR: (gcloud.run.services.replace) spec.template.spec.containers[0].env: The following reserved env names were provided: PORT, BAD_RESERVED." >&2; exit 1; fi ;;
  *"services replace"*) touch "$d/exists" ;;
  *"update-traffic"*)
    case "$*" in *"--to-revisions "*) echo "$*" | sed "s/.*--to-revisions \([^= ]*\)=.*/\1/" > "$d/serving" ;; esac ;;
esac
'# | str trim --left | save -f ($d | path join bin gcloud)
	r#'
#!/bin/sh
# The last argument is the address; a script file says what each answers, "code body" a line.
# While a count is left in `refusals`, a request carrying a bearer token gets Cloud Run's own
# 401, as one does while a fresh allUsers grant spreads.
d="$(dirname "$0")/.."
echo "$*" >> "$d/curl.log"
for last; do :; done
case "$last" in
  *next---*) say="$(cat "$d/candidate_says")" ;;
  *) say="$(cat "$d/public_says")" ;;
esac
case "$*" in *"Authorization: Bearer "*)
  n="$(cat "$d/refusals" 2>/dev/null || echo 0)"
  if [ "$n" -gt 0 ]; then
    echo $((n - 1)) > "$d/refusals"
    say="401 The request was not authorized to invoke this service. The access token could not be verified."
  fi ;;
esac
code=$(echo "$say" | cut -d" " -f1); body=$(echo "$say" | cut -d" " -f2-)
out=""; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
printf "%s" "$body" > "$out"
printf "%s" "$code"
'# | str trim --left | save -f ($d | path join bin curl)
	chmod +x ($d | path join bin gcloud) ($d | path join bin curl)
	$d
}

def with-fakes [d: string, body: closure] {
	with-env {PATH: ([($d | path join bin)] | append $env.PATH), GCP_GOLIVE_EVERY: "1"} { do $body }
}

def main [] {
	print "Running release-gcp tests...\n"
	test_stop_preview_stops_every_service_at_once
	test_grant_secrets_binds_each_secret_at_once
	test_hold_traffic_keeps_the_serving_revision
	test_hold_traffic_first_deploy
	test_sql_drift_patches_tier_and_flags_at_once
	test_poll_health_wants_the_revision_by_name
	test_poll_health_waits_for_cloud_run_to_pass_a_bearer
	test_golive_waits_for_the_invoker_grant
	test_golive_grants_public_once
	test_golive_switches_after_both_answer
	test_golive_goes_back_when_the_candidate_never_answers
	test_golive_goes_back_when_the_public_address_stays_on_the_old_revision
	test_golive_first_deploy
	test_golive_tags_the_tested_images_before_the_schema_job
	test_preflight_dry_runs_every_service_over_placeholder_digests
	test_preflight_names_the_file_and_clouds_run_message
	test_preflight_passes_a_sidecar_apart_whose_compose_sets_port
	print "\nAll release-gcp tests passed."
}

def test_sql_drift_patches_tier_and_flags_at_once [] {
	let plan = {sqlTier: "db-custom-1-3840", sqlFlags: "cloudsql.logical_decoding=on,max_connections=130"}
	let live = {settings: {tier: "db-f1-micro", databaseFlags: [{name: "max_connections", value: "130"}, {name: "cloudsql.logical_decoding", value: "on"}]}}
	let flags = [--database-flags $plan.sqlFlags]
	assert equal (sql-drift $live $plan) [--tier db-custom-1-3840]
	assert equal (sql-drift ($live | upsert settings.tier "db-custom-1-3840") $plan) []
	# Both in one patch: two would restart the database twice.
	assert equal (sql-drift ($live | upsert settings.databaseFlags [{name: "max_connections", value: "50"}]) $plan) [--tier db-custom-1-3840 ...$flags]
	assert equal (sql-drift {settings: {tier: "db-custom-1-3840"}} $plan) $flags
}

def test_hold_traffic_keeps_the_serving_revision [] {
	print "test hold-traffic keeps traffic on the serving revision..."
	let held = (hold-traffic "spec:\n  traffic:\n    - percent: 100\n      latestRevision: true\n  template:\n    metadata:\n      annotations:\n        autoscaling.knative.dev/maxScale: '1'\n" "svc-00001-old" | from yaml)
	assert equal $held.spec.traffic [{revisionName: "svc-00001-old", percent: 100}, {percent: 0, latestRevision: true, tag: "next"}]
	assert equal ($held.spec.template.metadata.annotations | get "autoscaling.knative.dev/maxScale") "1"
}

def test_hold_traffic_first_deploy [] {
	print "test hold-traffic on a first deploy tags the only revision..."
	let held = (hold-traffic "spec:\n  traffic:\n    - percent: 100\n      latestRevision: true\n" null | from yaml)
	assert equal $held.spec.traffic [{percent: 100, latestRevision: true, tag: "next"}]
}

def test_poll_health_wants_the_revision_by_name [] {
	print "test poll-health answers only for the revision asked..."
	let d = (fakes true "svc-00001-old" "200 x" "200 svc-00002-new")
	with-fakes $d {
		assert (poll-health "https://svc/health" ["200"] "svc-00002-new" --steady 2).ok
	}
	rm -r $d
}

def test_poll_health_waits_for_cloud_run_to_pass_a_bearer [] {
	print "test poll-health with a bearer waits while Cloud Run refuses it itself, however long that takes..."
	let d = (fakes true "svc-00001-old" "200 x" "200 svc-00002-new")
	"3" | save -f ($d | path join refusals)
	with-fakes $d {
		with-env {GCP_GOLIVE_EVERY: "1"} {
			assert (poll-health "https://svc/health" ["200"] "svc-00002-new" --steady 2 --bearer $invoker_probe).ok
		}
	}
	assert equal (open --raw ($d | path join refusals) | str trim) "0"
	assert (open --raw ($d | path join curl.log) | lines | all {|l| $l | str contains $"Authorization: Bearer ($invoker_probe)" })
	rm -r $d
}

def test_golive_waits_for_the_invoker_grant [] {
	print "test go-live moves traffic only once Cloud Run passes a bearer-carrying request on..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	"2" | save -f ($d | path join refusals)
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	let curls = (open --raw ($d | path join curl.log) | lines)
	assert ($curls | all {|l| $l | str contains "Authorization: Bearer " })
	assert (($curls | where {|l| $l | str contains "next---" } | length) >= 3)
	assert equal (open --raw ($d | path join serving) | str trim) "svc-00002-new"
	rm -r $d
}

# go-live over the fakes, as a release's staged record: no sidecars, no IAP, no domain.
def golive [d: string, extra: record = {}]: nothing -> record {
	let work = (mktemp -d)
	mkdir ($work | path join dist gcp)
	"spec:\n  traffic:\n    - percent: 100\n      latestRevision: true\n" | save -f ($work | path join dist gcp service.yaml)
	"" | save -f ($work | path join dist gcp job.yaml)
	let plan = {project: "p", region: "r", service: "svc", iap: false, domain: null, aliases: [], sidecarServicesYaml: {}, clock: null, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {}}}
	let staged = ({plan: $plan, pushed: {}, has_migrate: false, copy: null, gated: false, number: "1"} | merge $extra)
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) [go-live]; go-live ($staged | to nuon)"
	let res = (with-fakes $d { cd $work; do { ^$nu.current-exe --no-config-file -c $script } | complete })
	rm -r $work
	$res
}

def log-of [d: string]: nothing -> string { open --raw ($d | path join gcloud.log) }

# A SetIamPolicy that changes nothing still opens Cloud Run's window of 401s for bearer tokens
# (bonk-chess-rc-render died of one, 2026-11-03), so a grant already held is left alone.
def test_golive_grants_public_once [] {
	print "test go-live sets no policy on a door and sidecar allUsers already invokes, and grants one that lacks it..."
	let more = {plan: {project: "p", region: "r", service: "svc", iap: false, domain: null, aliases: [], sidecarServicesYaml: {render: "x"}, clock: null, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {render: "svc-render"}}}}
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	"" | save -f ($d | path join granted)
	let res = (golive $d $more)
	assert equal $res.exit_code 0 $res.stderr
	assert (log-of $d | str contains "get-iam-policy svc ")
	assert (log-of $d | str contains "get-iam-policy svc-render ")
	assert (not (log-of $d | str contains "add-iam-policy-binding"))
	rm -r $d
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let res = (golive $d $more)
	assert equal $res.exit_code 0 $res.stderr
	assert (log-of $d | str contains "add-iam-policy-binding svc --region r --project p --member allUsers --role roles/run.invoker")
	assert (log-of $d | str contains "add-iam-policy-binding svc-render --region r --project p --member allUsers --role roles/run.invoker")
	rm -r $d
}

def test_golive_switches_after_both_answer [] {
	print "test go-live moves traffic only after the candidate answers, and ends on the new revision..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	let log = (log-of $d)
	assert ($log | str contains "services replace dist/gcp/service.held.yaml")
	assert ($log | str contains "update-traffic svc --to-revisions svc-00002-new=100")
	assert (not ($log | str contains "svc-00001-old=100"))
	assert equal (open --raw ($d | path join serving) | str trim) "svc-00002-new"
	rm -r $d
}

def test_golive_goes_back_when_the_candidate_never_answers [] {
	print "test go-live keeps traffic on the old revision when the candidate never answers..."
	let d = (fakes true "svc-00001-old" "500 down" "200 svc-00001-old")
	let res = (golive $d)
	assert ($res.exit_code != 0)
	assert ($res.stdout | str contains "did not answer at its own address")
	assert equal (open --raw ($d | path join serving) | str trim) "svc-00001-old"
	assert (not (log-of $d | str contains "--to-revisions svc-00002-new=100"))
	rm -r $d
}

def test_golive_goes_back_when_the_public_address_stays_on_the_old_revision [] {
	print "test go-live shifts back when the public address never answers as the new revision..."
	let d = (fakes true "svc-00001-old" "200 ok" "500 gone")
	let res = (golive $d)
	assert ($res.exit_code != 0)
	assert ($res.stdout | str contains "did not answer as svc-00002-new")
	assert ($res.stdout | str contains "serves svc-00001-old again")
	assert equal (open --raw ($d | path join serving) | str trim) "svc-00001-old"
	rm -r $d
}

def test_golive_first_deploy [] {
	print "test go-live of a first deploy has no revision to hold, and still goes live..."
	let d = (fakes false "" "200 ok" "200 svc-00002-new")
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	assert ($res.stdout | str contains "is live at")
	rm -r $d
}

def test_golive_tags_the_tested_images_before_the_schema_job [] {
	print "test go-live tags the tested images the release's before the schema job changes production, and returns them..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	"sha256:aa" | save -f ($d | path join tagged_digest)
	let res = (golive $d {gated: true, copy: {refs: [{svc: "crud", repo: "reg/app-crud", digest: "sha256:aa"}]}})
	assert equal $res.exit_code 0 $res.stderr
	let log = (log-of $d)
	assert ($log | str contains "tags add reg/app-crud@sha256:aa reg/app-crud:release")
	assert ($log | str contains "run jobs replace dist/gcp/job.yaml")
	# A tag that fails stops the release before the schema job changes production's database.
	let lines = ($log | lines)
	let tagged = ($lines | enumerate | where {|l| $l.item | str contains "tags add" } | first | get index)
	let job = ($lines | enumerate | where {|l| $l.item | str contains "run jobs replace" } | first | get index)
	assert ($tagged < $job) "the tag comes before the schema job"
	assert ($res.stdout | str contains "release")
	rm -r $d
}

# An app in a temp directory under the repository, so cue finds pronto's own schema; docker is a
# script that prints a compose project (no container runs), gcloud the fake above.
def preflight-app [sidecar_env: string]: nothing -> string {
	let app = ($gcp_dir | path dirname | path join $".preflight-(random uuid)")
	mkdir ($app | path join .pronto)
	$"package preflight\nimport \"github.com/bonisoft3/pronto/gcp/schema\"\nGCP: schema.#Release & {name: \"app\", service: \"svc\", project: \"pronto-test\", sidecars: \"side\": {port: 8687, apart: {}}}\ngcpRelease: schema.#Build & {release: GCP}\n" | save -f ($app | path join release.cue)
	{server: true, tokenRoles: ["anon"], replays: []} | to json | save -f ($app | path join .pronto cluster.json)
	let compose = {services: {database: {}, crud: {}, electric: {}, caddy: {}, auth: {environment: {OIDC_PROVIDERS: "google"}}, side: {environment: ($sidecar_env | from json)}}}
	$"#!/bin/sh\necho '($compose | to json --raw)'\n" | save -f ($app | path join docker)
	chmod +x ($app | path join docker)
	$app
}

def preflight-run [d: string, app: string]: nothing -> record {
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) [preflight]; preflight {dir: '($app)', cue_path: '($app | path join release.cue)'} [\"\"]"
	with-env {PATH: ([($app) ($d | path join bin)] | append $env.PATH)} { do { ^$nu.current-exe --no-config-file -c $script } | complete }
}

def test_preflight_dry_runs_every_service_over_placeholder_digests [] {
	print "test preflight validates the door and each sidecar apart with --dry-run, and applies nothing..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 x")
	let app = (preflight-app '{"X": "1"}')
	let res = (preflight-run $d $app)
	rm -r $app
	assert equal $res.exit_code 0 $res.stderr
	let replaces = (log-of $d | lines | where {|l| $l | str contains "services replace" })
	assert equal ($replaces | length) 2
	assert ($replaces | all {|l| $l | str contains "--dry-run" })
	assert (not (log-of $d | str contains "jobs replace"))
	rm -r $d
}

def test_preflight_names_the_file_and_clouds_run_message [] {
	print "test preflight fails with the file and Cloud Run's own message..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 x")
	let app = (preflight-app '{"BAD_RESERVED": "1"}')
	let res = (preflight-run $d $app)
	rm -r $app
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "Cloud Run refuses what this release would apply")
	assert ($res.stderr | str contains "release-sidecar-side.yaml")
	assert ($res.stderr | str contains "BAD_RESERVED")
	rm -r $d
}

# Cloud Run refused bonk-chess-rc-render for the PORT compose sets: the release leaves it to Cloud Run
# for a sidecar apart, which this preflight's dry-run (the fake refuses PORT as Cloud Run does) confirms.
def test_preflight_passes_a_sidecar_apart_whose_compose_sets_port [] {
	print "test preflight passes a sidecar apart whose compose environment sets PORT..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 x")
	let app = (preflight-app '{"PORT": "8687"}')
	let res = (preflight-run $d $app)
	rm -r $app
	assert equal $res.exit_code 0 $res.stderr
	rm -r $d
}

# A function of release.nu run over the fakes in a nushell of its own, as go-live is.
def run-release [d: string, call: string]: nothing -> record {
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) *; ($call)"
	with-fakes $d { do { ^$nu.current-exe --no-config-file -c $script } | complete }
}

# A door and two sidecars each take four calls to stop; at half a second a call, one after
# another they would take 6 s beside the job and clock calls (3 s) and the start: over 9 s.
def test_stop_preview_stops_every_service_at_once [] {
	print "test stop-preview stops the door and each sidecar, all at once..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let plan = {project: "p", region: "r", service: "svc", names: {job: "j", migrateJob: "mj", clock: "c", sidecarServices: {a: "svc-a", b: "svc-b"}}}
	let t0 = (date now)
	let res = (with-env {GCLOUD_SLOW: "0.5"} { run-release $d $"stop-preview ($plan | to nuon)" })
	let took = ((date now) - $t0)
	assert equal $res.exit_code 0 $res.stderr
	let log = (log-of $d)
	for svc in ["svc" "svc-a" "svc-b"] {
		assert ($log | str contains $"run services update ($svc) --scaling 0") $"($svc) is stopped"
		assert ($log | str contains $"run services update-traffic ($svc) --clear-tags") $"($svc)'s tags are cleared"
	}
	assert ($log | str contains "run jobs delete j") "the schema job goes"
	assert ($took < 6500ms) $"the services stop at once, not one after another \(($took)\)"
	rm -r $d
}

def test_grant_secrets_binds_each_secret_at_once [] {
	print "test grant-secrets binds the account to each secret, all at once..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let plan = {project: "p", preview: "rc", readSecrets: ["s1" "s2" "s3" "s4"], names: {serviceAccount: "sa@p.iam.gserviceaccount.com"}}
	let t0 = (date now)
	let res = (with-env {GCLOUD_SLOW: "1"} { run-release $d $"grant-secrets ($plan | to nuon)" })
	let took = ((date now) - $t0)
	assert equal $res.exit_code 0 $res.stderr
	let log = (log-of $d)
	for s in ["s1" "s2" "s3" "s4"] {
		assert ($log | str contains $"secrets add-iam-policy-binding ($s) --project p --member serviceAccount:sa@p.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor") $"($s) is granted"
	}
	assert ($took < 3.5sec) $"the grants run at once \(($took)\)"
	rm -r $d
}
