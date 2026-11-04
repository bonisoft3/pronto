#!/usr/bin/env nu
# Run with: nu gcp/verify_test.nu
#
# verify.nu's rule that a failing scenario absent from the last live release's tree is a new
# feature's and does not fail the release, and a failing one that was in it does.

const gcp_dir = path self .

use std/assert
use verify.nu [scenario-names failed-scenarios failed-sections classify-failures new-feature-excuse]
use release-record.nu
use build.nu [failure-message tag-action]

const cue_text = "package scenarios\n// scenarios: commented: {}\nscenarios: seek: {\n}\nscenarios: seek_notify: {\n}\nscenarios: \"seek_race\": {}\nx: scenarios: nested: {}\n"

def test_names_of_a_cue_file [] {
	assert equal (scenario-names $cue_text) [seek seek_notify seek_race]
}

def test_failed_scenarios_read_the_format_bisect_reads [] {
	let lines = ["✗ seek_notify (12s) at step 4: {\"x\":1}" "  boom" "✗ gold (3s) at step 1" "✗ seek_notify (9s) at step 2" "  ✗ premium: note" "✓ chat (2s): accept"]
	assert equal (failed-scenarios $lines) [seek_notify gold]
}

def test_sections_of_failed_drivers [] {
	let lines = ["verify: a" "✗ x (1s) at step 1" "verify: a FAILED" "verify: b" "ok" "verify: b passed" "verify: c" "✗ y (1s) at step 2" "verify: c FAILED"]
	assert equal (failed-sections $lines) [["✗ x (1s) at step 1"] ["✗ y (1s) at step 2"]]
}

def test_only_new_scenarios_failing_is_new [] {
	let r = (classify-failures [["✗ seek_notify (5s) at step 3"]] [seek] "scenarios: seek: {}" [seek seek_notify])
	assert equal $r.verdict "new"
	assert equal $r.new [seek_notify]
}

def test_a_scenario_of_the_live_tree_failing_is_a_regression [] {
	let r = (classify-failures [["✗ seek_notify (5s) at step 3" "✗ seek (5s) at step 3"]] [seek] "scenarios: seek: {}" [seek seek_notify])
	assert equal $r.verdict "regression"
}

def test_a_failure_naming_nothing_is_unknown [] {
	assert equal (classify-failures [["boom"]] [seek] "" [seek]).verdict "unknown"
	assert equal (classify-failures [["✗ a (1s) at step 1"] ["driver crashed"]] [] "" [a]).verdict "unknown"
	assert equal (classify-failures [] [seek] "" [seek]).verdict "unknown"
}

def test_a_name_the_current_tree_lacks_or_the_live_tree_mentions_is_unknown [] {
	assert equal (classify-failures [["✗ ghost (1s) at step 1"]] [seek] "" [seek]).verdict "unknown"
	assert equal (classify-failures [["✗ built (1s) at step 1"]] [seek] "for id in [built]: scenarios: (id): {}" [seek built]).verdict "unknown"
}

def test_another_failed_line_is_unknown [] {
	assert equal (classify-failures [["✗ a (1s) at step 1" "  ✗ stack: not ready"]] [] "" [a]).verdict "unknown"
	assert equal (classify-failures [["✗ a (1s) at step 1" "✗ premium (4s)"]] [] "" [a]).verdict "unknown"
}

def test_a_name_inside_another_is_not_in_the_live_tree [] {
	assert equal (classify-failures [["✗ seek (1s) at step 1"]] [seek_notify] "scenarios: seek_notify: {}\n// seek" [seek]).verdict "unknown"
	assert equal (classify-failures [["✗ seek (1s) at step 1"]] [seek_notify] "scenarios: seek_notify: {}" [seek]).verdict "new"
}

# A git checkout whose first commit holds scenario `seek`, and a working tree adding `seek_notify`.
def checkout []: nothing -> record {
	let d = (mktemp -d)
	let app = ($d | path join app)
	mkdir ($app | path join tests scenarios)
	"package scenarios\nscenarios: seek: {}\n" | save -f ($app | path join tests scenarios seek.cue)
	^git -C $app init -q
	^git -C $app add -A
	^git -C $app -c user.name=t -c user.email=t@t commit -q -m one
	let commit = (^git -C $app rev-parse HEAD | str trim)
	"package scenarios\nscenarios: seek_notify: {}\n" | save -f ($app | path join tests scenarios seek_notify.cue)
	{dir: $d, app: $app, commit: $commit}
}

def with-record [c: record, dirty: bool, body: closure] {
	let home = ($c.dir | path join home)
	mkdir ($home | path join .cache pronto releases)
	{app: "t", preview: "", commit: $c.commit, dirty: $dirty, outcome: "live"} | to json --raw | save -f ($home | path join .cache pronto releases t.jsonl)
	with-env {HOME: $home} { do $body }
}

def test_the_excuse_reads_the_live_release_s_tree [] {
	let c = (checkout)
	let run = {app: "t", appDir: $c.app}
	with-record $c false {
		assert equal (new-feature-excuse $run [["✗ seek_notify (1s) at step 1"]]) [seek_notify]
		assert equal (new-feature-excuse $run [["✗ seek (1s) at step 1"]]) []
		assert equal (new-feature-excuse $run [["✗ seek_notify (1s) at step 1"] ["boom"]]) []
	}
	with-record $c true {
		assert equal (new-feature-excuse $run [["✗ seek_notify (1s) at step 1"]]) []
	}
	assert equal (new-feature-excuse {app: "none-such", appDir: $c.app} [["✗ seek_notify (1s) at step 1"]]) []
	rm -r $c.dir
}

def test_a_closure_failure_says_its_cause [] {
	let e = (try { [1 2] | par-each {|x| error make {msg: $"cause ($x)"} } | ignore; null } catch {|e| $e })
	assert equal $e.msg "Eval block failed with pipeline input"
	let m = (failure-message $e)
	assert ($m | str contains "cause") $m
	assert (not ($m | str contains "Eval block"))
}

def test_a_plain_failure_keeps_its_message [] {
	let e = (try { error make {msg: "plain"} } catch {|e| $e })
	assert equal (failure-message $e) "plain"
}

def test_a_tag_is_left_made_or_moved [] {
	assert equal (tag-action null "sha256:a") "create"
	assert equal (tag-action "sha256:a" "sha256:a") "keep"
	assert equal (tag-action "sha256:b" "sha256:a") "move"
}

def main [] {
	let tests = (scope commands | where name =~ '^test_' | get name)
	for t in $tests {
		print $"($t)"
		let r = (do { ^$nu.current-exe --no-config-file -c $"source ($gcp_dir | path join verify_test.nu); ($t)" } | complete)
		if $r.exit_code != 0 { print -e $r.stdout $r.stderr; error make {msg: $"($t) failed"} }
	}
	print $"($tests | length) passed"
}
