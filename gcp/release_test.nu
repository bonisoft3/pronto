#!/usr/bin/env nu
# Run with: nu gcp/release_test.nu
#
# release@gcp's go-live (release.nu), run against a gcloud and a curl that are shell scripts
# on the PATH: gcloud keeps a service's traffic in a state file, as Cloud Run does, and curl
# answers from a script of what each address says. Nothing here reaches a project.

const gcp_dir = path self .

use std/assert
use release.nu [hold-traffic poll-health preflight roll-back]

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
echo "gcloud $*" >> "$d/calls.log"
case "$*" in
  *"services describe"*)
    [ -f "$d/exists" ] || { echo "NOT_FOUND: not found" >&2; exit 1; }
    # The door's own traffic is kept in a file; a sidecar apart serves its newest revision.
    case "$*" in *"describe svc "*) s="$(cat "$d/serving")" ;; *) s=svc-00002-new ;; esac
    # A live revision ready on its latest, released with the job hash a file holds.
    live=""; [ -f "$d/live_job" ] && live=",\"latestReadyRevisionName\":\"$s\",\"latestCreatedRevisionName\":\"$s\""
    labels=""; [ -f "$d/live_job" ] && labels="\"spec\":{\"template\":{\"metadata\":{\"labels\":{\"pronto-job\":\"$(cat "$d/live_job")\"}}}},"
    echo "{$labels\"status\":{\"traffic\":[{\"revisionName\":\"$s\",\"percent\":100},{\"revisionName\":\"svc-00002-new\",\"percent\":0,\"tag\":\"next\",\"url\":\"https://next---svc-1.r.run.app\"}]$live}}" ;;
  *"revisions list"*)
    # The schema each revision was released with, from a file when one says so.
    old="$(cat "$d/old_schema" 2>/dev/null || echo a)"
    echo "[{\"metadata\":{\"name\":\"svc-00002-new\",\"creationTimestamp\":\"2\",\"labels\":{\"pronto-schema\":\"a\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}},{\"metadata\":{\"name\":\"svc-00001-old\",\"creationTimestamp\":\"1\",\"labels\":{\"pronto-schema\":\"$old\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}]" ;;
  *"images describe"*) cat "$d/tagged_digest" 2>/dev/null ;;
  *"projects describe"*) echo 123 ;;
  *"services replace"*"--dry-run"*)
    # Cloud Run's own refusal of a reserved name, as a sidecar apart that sets PORT met.
    f="$(echo "$*" | sed 's/.*replace \([^ ]*\) .*/\1/')"
    if grep -Eq "name: (PORT|BAD_RESERVED)$" "$f"; then echo "ERROR: (gcloud.run.services.replace) spec.template.spec.containers[0].env: The following reserved env names were provided: PORT, BAD_RESERVED." >&2; exit 1; fi ;;
  *"services replace"*) touch "$d/exists" ;;
  *"update-traffic"*)
    # Only the door's own traffic is kept; a sidecar's is logged.
    case "$*" in *"update-traffic svc "*"--to-revisions "*) echo "$*" | sed "s/.*--to-revisions \([^= ]*\)=.*/\1/" > "$d/serving" ;; esac ;;
esac
'# | str trim --left | save -f ($d | path join bin gcloud)
	r#'
#!/bin/sh
# The last argument is the address; a script file says what each answers, "code body" a line.
d="$(dirname "$0")/.."
echo "$*" >> "$d/curl.log"
echo "curl $*" >> "$d/calls.log"
for last; do :; done
case "$last" in
  *next---*) say="$(cat "$d/candidate_says")" ;;
  *) say="$(cat "$d/public_says")" ;;
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
	with-env {PATH: ([($d | path join bin)] | append $env.PATH), GCP_GOLIVE_WAIT: "2", GCP_GOLIVE_EVERY: "1"} { do $body }
}

def main [] {
	print "Running release-gcp tests...\n"
	test_hold_traffic_keeps_the_serving_revision
	test_hold_traffic_first_deploy
	test_poll_health_wants_the_revision_by_name
	test_poll_health_times_out
	test_golive_switches_after_both_answer
	test_golive_goes_back_when_the_candidate_never_answers
	test_golive_goes_back_when_the_public_address_stays_on_the_old_revision
	test_golive_first_deploy
	test_golive_tags_the_tested_images_before_the_schema_job
	test_golive_skips_a_schema_job_the_live_revision_was_released_with
	test_golive_takes_a_previews_traffic_at_once
	test_golive_waits_for_the_door_before_the_sidecars
	test_golive_rolls_each_sidecar_once_the_revision_serves
	test_golive_does_not_go_back_past_a_migration
	test_rollback_sends_the_service_and_its_sidecars_back_one_revision
	test_rollback_refuses_past_a_migration
	test_preflight_dry_runs_every_service_over_placeholder_digests
	test_preflight_names_the_file_and_clouds_run_message
	test_preflight_passes_a_sidecar_apart_whose_compose_sets_port
	print "\nAll release-gcp tests passed."
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
		assert (not ((poll-health "https://svc/health" ["200"] "svc-00009-other").ok))
	}
	rm -r $d
}

def test_poll_health_times_out [] {
	print "test poll-health gives up with the last answer..."
	let d = (fakes true "svc-00001-old" "200 x" "500 boom")
	with-fakes $d {
		let got = (poll-health "https://svc/health" ["200"] null)
		assert (not $got.ok)
		assert ($got.last | str contains "500 boom")
	}
	rm -r $d
}

# The plan a go-live takes, as a release's: no sidecars, no IAP, no domain. `extra` merges over it.
def plan-of-golive [extra: record = {}]: nothing -> record {
	{project: "p", region: "r", service: "svc", iap: false, domain: null, aliases: [], sidecarServicesYaml: {}, clock: null, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {}}} | merge $extra
}

# go-live over the fakes, as a release's staged record. `held` is the service yaml it applied.
def golive [d: string, extra: record = {}, plan: record = {}]: nothing -> record {
	let work = (mktemp -d)
	mkdir ($work | path join dist gcp)
	"spec:\n  traffic:\n    - percent: 100\n      latestRevision: true\n" | save -f ($work | path join dist gcp service.yaml)
	"" | save -f ($work | path join dist gcp job.yaml)
	let staged = ({plan: (plan-of-golive $plan), pushed: {}, has_migrate: false, copy: null, gated: false, number: "1"} | merge $extra)
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) [go-live]; go-live ($staged | to nuon)"
	let res = (with-fakes $d { cd $work; do { ^$nu.current-exe --no-config-file -c $script } | complete })
	let held = ($work | path join dist gcp service.held.yaml)
	let res = ($res | insert held (if ($held | path exists) { open --raw $held | from json } else { null }))
	rm -r $work
	$res
}

def log-of [d: string]: nothing -> string { open --raw ($d | path join gcloud.log) }

def calls-of [d: string]: nothing -> list<string> { open --raw ($d | path join calls.log) | lines }

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
	# The yaml it applied held the traffic on the serving revision, the new one tagged.
	assert equal $res.held.spec.traffic [{revisionName: "svc-00001-old", percent: 100}, {percent: 0, latestRevision: true, tag: "next"}]
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

# Going back past a migration is a release of the older commit, which its gate tests: the
# revision before was released with another schema, so traffic stays where it moved to.
def test_golive_does_not_go_back_past_a_migration [] {
	print "test go-live leaves traffic on the new revision when the one before has another schema..."
	let d = (fakes true "svc-00001-old" "200 ok" "500 gone")
	"b" | save -f ($d | path join old_schema)
	let res = (golive $d)
	assert ($res.exit_code != 0)
	assert ($res.stdout | str contains "another schema")
	assert equal (open --raw ($d | path join serving) | str trim) "svc-00002-new"
	rm -r $d
}

def test_golive_first_deploy [] {
	print "test go-live of a first deploy has no revision to hold, and still goes live..."
	let d = (fakes false "" "200 ok" "200 svc-00002-new")
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	assert ($res.stdout | str contains "is live at")
	assert equal $res.held.spec.traffic [{percent: 100, latestRevision: true, tag: "next"}]
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
	rm -r $d
}

# The schema job is skipped where the live revision was released with the very job it would run
# (a hash of it rides on the service as a label), and runs when the hash differs, is absent, or
# PRONTO_RELEASE_FORCE_SCHEMA says so.
def test_golive_skips_a_schema_job_the_live_revision_was_released_with [] {
	print "test go-live skips an unchanged schema job, and runs it when forced or changed..."
	let same = ("" | hash sha256 | str substring 0..39)
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	$same | save -f ($d | path join live_job)
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	assert ($res.stdout | str contains "the schema job skipped")
	assert (not (log-of $d | str contains "run jobs replace"))
	rm -r $d
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	$same | save -f ($d | path join live_job)
	let res = (with-env {PRONTO_RELEASE_FORCE_SCHEMA: "1"} { golive $d })
	assert equal $res.exit_code 0 $res.stderr
	assert (log-of $d | str contains "run jobs replace dist/gcp/job.yaml")
	rm -r $d
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	"another" | save -f ($d | path join live_job)
	let res = (golive $d)
	assert equal $res.exit_code 0 $res.stderr
	assert (log-of $d | str contains "run jobs replace dist/gcp/job.yaml")
	rm -r $d
}

# A preview's last revision was stopped with the preview. Held on it, an instance of each started
# together, the new one's electric took the replication slot's lock, and the old one's waited for
# ever: a preview's door takes the traffic at once.
def test_golive_takes_a_previews_traffic_at_once [] {
	print "test go-live gives a preview's door its traffic at once, a release's held..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let res = (golive $d {} {preview: "rc"})
	assert equal $res.exit_code 0 $res.stderr
	assert equal $res.held.spec.traffic [{percent: 100, latestRevision: true, tag: "next"}]
	rm -r $d
}

# A sidecar apart reads the door at start: the door answers before the sidecar is made, or it
# met a 500 and exited until its revision was given up.
def test_golive_waits_for_the_door_before_the_sidecars [] {
	print "test go-live asks the door's /health before it makes a sidecar apart..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let side = {sidecarServicesYaml: {render: "x"}, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {render: "svc-render"}}}
	let res = (golive $d {} $side)
	assert equal $res.exit_code 0 $res.stderr
	let calls = (calls-of $d)
	let door = ($calls | enumerate | where {|c| ($c.item | str starts-with "curl") and not ($c.item | str contains "next---") } | first | get index)
	let side_at = ($calls | enumerate | where {|c| $c.item | str contains "services replace dist/gcp/sidecar-render.yaml" } | first | get index)
	assert ($door < $side_at) "the door answers before the sidecar is made"
	rm -r $d
}

# A sidecar apart made before the switch read the door that served then; each is rolled once the
# new revision serves, a fresh instance reading this release's door.
def test_golive_rolls_each_sidecar_once_the_revision_serves [] {
	print "test go-live rolls each sidecar apart after traffic moves..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 svc-00002-new")
	let side = {sidecarServicesYaml: {render: "x"}, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {render: "svc-render"}}}
	let res = (golive $d {} $side)
	assert equal $res.exit_code 0 $res.stderr
	let lines = (log-of $d | lines)
	let moved = ($lines | enumerate | where {|l| $l.item | str contains "update-traffic svc " } | first | get index)
	let rolled = ($lines | enumerate | where {|l| $l.item | str contains "services update svc-render --update-labels pronto-door=svc-00002-new" } | first | get index)
	assert ($moved < $rolled) "rolled after the traffic moved"
	rm -r $d
}

def rollback-run [d: string, plan: record]: nothing -> record {
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) [roll-back]; roll-back ($plan | to nuon)"
	with-fakes $d { do { ^$nu.current-exe --no-config-file -c $script } | complete }
}

def test_rollback_sends_the_service_and_its_sidecars_back_one_revision [] {
	print "test --rollback sends the service and each sidecar apart back one revision..."
	let d = (fakes true "svc-00002-new" "200 ok" "200 ok")
	let res = (rollback-run $d (plan-of-golive {names: {sidecarServices: {render: "svc-render"}}}))
	assert equal $res.exit_code 0 $res.stderr
	let log = (log-of $d)
	assert ($log | str contains "update-traffic svc --to-revisions svc-00001-old=100")
	assert ($log | str contains "update-traffic svc-render --to-revisions svc-00001-old=100")
	rm -r $d
}

def test_rollback_refuses_past_a_migration [] {
	print "test --rollback refuses to go back past a schema change, and moves nothing..."
	let d = (fakes true "svc-00002-new" "200 ok" "200 ok")
	"b" | save -f ($d | path join old_schema)
	let res = (rollback-run $d (plan-of-golive))
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "another schema")
	assert (not (log-of $d | str contains "update-traffic"))
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

# Cloud Run refuses the PORT compose sets for a sidecar apart ("reserved env names"): the release
# leaves it to Cloud Run, which this preflight's dry-run (the fake refuses PORT as Cloud Run does)
# confirms.
def test_preflight_passes_a_sidecar_apart_whose_compose_sets_port [] {
	print "test preflight passes a sidecar apart whose compose environment sets PORT..."
	let d = (fakes true "svc-00001-old" "200 ok" "200 x")
	let app = (preflight-app '{"PORT": "8687"}')
	let res = (preflight-run $d $app)
	rm -r $app
	assert equal $res.exit_code 0 $res.stderr
	rm -r $d
}
