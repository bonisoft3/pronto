#!/usr/bin/env nu
# Run with: nu gcp/secrets_test.nu
#
# secrets.nu's pure part: which (project, secret) pairs a release's plans name, and which of them
# a listing of the secrets that have an enabled version leaves missing.

const gcp_dir = path self .

use std/assert
use secrets.nu [secret-pairs missing-pairs missing-message]

const prod = {project: "brawl-chess", oidcSecretKeys: ["OIDC_GOOGLE_CLIENT_SECRET"], sidecarSecretKeys: ["notify-vapid-private-key" "a-key"]}
const rc = {project: "brawl-chess-previews", oidcSecretKeys: ["OIDC_GOOGLE_CLIENT_SECRET"], sidecarSecretKeys: ["notify-vapid-private-key" "a-key"]}

def test_pairs_are_each_plan_s_secrets_in_its_project [] {
	let pairs = (secret-pairs [$prod $rc])
	assert equal ($pairs | length) 6
	assert ({project: "brawl-chess-previews", secret: "notify-vapid-private-key"} in $pairs)
	assert ({project: "brawl-chess", secret: "OIDC_GOOGLE_CLIENT_SECRET"} in $pairs)
}

def test_a_plan_without_sidecar_keys_names_only_oidc [] {
	assert equal (secret-pairs [{project: "p", oidcSecretKeys: ["X"]}]) [{project: "p", secret: "X"}]
}

def test_one_project_twice_is_one_pair [] {
	assert equal (secret-pairs [$prod $prod] | length) 3
}

def test_missing_are_the_pairs_not_listed [] {
	let pairs = (secret-pairs [$prod $rc])
	let have = ($pairs | where {|p| not ($p.project == "brawl-chess-previews" and $p.secret == "a-key") })
	assert equal (missing-pairs $pairs $have) [{project: "brawl-chess-previews", secret: "a-key"}]
	assert equal (missing-pairs $pairs $pairs) []
}

def test_the_message_lists_every_pair_and_where_to_declare [] {
	let m = (missing-message [{project: "p1", secret: "s1"} {project: "p2", secret: "s2"}])
	assert ($m | str contains "s1 in p1")
	assert ($m | str contains "s2 in p2")
	assert ($m | str contains "infra/gcp")
	assert ($m | str contains "release@infra")
}

def main [] {
	let tests = (scope commands | where name =~ '^test_' | get name)
	for t in $tests {
		print $"($t)"
		let r = (do { ^$nu.current-exe --no-config-file -c $"source ($gcp_dir | path join secrets_test.nu); ($t)" } | complete)
		if $r.exit_code != 0 { print -e $r.stdout $r.stderr; error make {msg: $"($t) failed"} }
	}
	print $"($tests | length) passed"
}
