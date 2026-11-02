#!/usr/bin/env nu
# Run with: nu gcp/release_test.nu
#
# release@gcp's go-live (release.nu), run against a gcloud and a curl that are shell scripts
# on the PATH: gcloud keeps a service's traffic in a state file, as Cloud Run does, and curl
# answers from a script of what each address says. Nothing here reaches a project.

const gcp_dir = path self .

use std/assert
use release.nu [hold-traffic poll-health]

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
case "$*" in
  *"services describe"*)
    [ -f "$d/exists" ] || { echo "NOT_FOUND: not found" >&2; exit 1; }
    s="$(cat "$d/serving")"
    echo "{\"status\":{\"traffic\":[{\"revisionName\":\"$s\",\"percent\":100},{\"revisionName\":\"svc-00002-new\",\"percent\":0,\"tag\":\"next\",\"url\":\"https://next---svc-1.r.run.app\"}]}}" ;;
  *"revisions list"*)
    s="$(cat "$d/serving")"
    echo "[{\"metadata\":{\"name\":\"svc-00002-new\",\"creationTimestamp\":\"2\",\"labels\":{\"pronto-schema\":\"a\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}},{\"metadata\":{\"name\":\"svc-00001-old\",\"creationTimestamp\":\"1\",\"labels\":{\"pronto-schema\":\"a\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}]" ;;
  *"services replace"*) touch "$d/exists" ;;
  *"update-traffic"*)
    case "$*" in *"--to-revisions "*) echo "$*" | sed "s/.*--to-revisions \([^= ]*\)=.*/\1/" > "$d/serving" ;; esac ;;
esac
'# | str trim --left | save -f ($d | path join bin gcloud)
	r#'
#!/bin/sh
# The last argument is the address; a script file says what each answers, "code body" a line.
d="$(dirname "$0")/.."
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

# go-live over the fakes, as a release's staged record: no sidecars, no IAP, no domain.
def golive [d: string]: nothing -> record {
	let work = (mktemp -d)
	mkdir ($work | path join dist gcp)
	"spec:\n  traffic:\n    - percent: 100\n      latestRevision: true\n" | save -f ($work | path join dist gcp service.yaml)
	"" | save -f ($work | path join dist gcp job.yaml)
	let plan = {project: "p", region: "r", service: "svc", iap: false, domain: null, aliases: [], sidecarServicesYaml: {}, clock: null, names: {job: "j", migrateJob: "mj", secrets: {}, sidecarServices: {}}}
	let staged = {plan: $plan, pushed: {}, has_migrate: false, copy: null, gated: false, number: "1"}
	let script = $"$env.GCP_T0 = \(date now\); use ($gcp_dir | path join release.nu) [go-live]; go-live ($staged | to nuon)"
	let res = (with-fakes $d { cd $work; do { ^$nu.current-exe --no-config-file -c $script } | complete })
	rm -r $work
	$res
}

def log-of [d: string]: nothing -> string { open --raw ($d | path join gcloud.log) }

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
