# secrets.nu: check-secrets, that every secret a GCP release reads by name is there before it
# starts. release@gcp stops on one missing (stage: the OIDC secrets, the sidecars' own), but only
# minutes in, in the rc preview's project; this names them all, in every project the release
# touches, in seconds. Metadata only: `gcloud secrets versions list`, never a secret's value.
#
#   nu gcp/secrets.nu check <app dir> [--if-gcp] [--preview <name>] [--no-gate]
#
# release@gcp runs it first; integrate@local runs it for an app with a GCP release plan.

use verify.nu [plan-of]

# The (project, secret) pairs a set of plans (the release's and the rc preview's) read by name:
# the OIDC secrets and the sidecars' own, in each plan's project. Each pair once.
export def secret-pairs [plans: list<record>]: nothing -> list<record> {
	$plans | each {|p|
		$p.oidcSecretKeys | append ($p.sidecarSecretKeys? | default []) | uniq | each {|s| {project: $p.project, secret: $s} }
	} | flatten | uniq | sort-by project secret
}

# The pairs whose latest version is not enabled: `have` lists the pairs that do have one.
export def missing-pairs [pairs: list<record>, have: list<record>]: nothing -> list<record> {
	$pairs | where {|p| $p not-in $have }
}

export def missing-message [missing: list<record>]: nothing -> string {
	let lines = ($missing | each {|m| $"  ($m.secret) in ($m.project)" } | str join "\n")
	$"release@gcp reads ($missing | length) secret\(s\) whose latest version is not enabled:\n($lines)\ndeclare each in the repo's infra/gcp and apply it with release@infra"
}

# Whether the secret's latest version, the one a deployed container reads, is ENABLED, by metadata
# alone (`versions describe latest`, which gives the state, never the value). Only absence answers
# false; any other failure (a project it cannot see, an expired token) is raised.
def has-enabled-version [project: string, secret: string]: nothing -> bool {
	let r = (^gcloud --quiet secrets versions describe latest --secret $secret --project $project --format "value(state)" | complete)
	if $r.exit_code != 0 {
		if $r.stderr =~ "NOT_FOUND|not found|Not found" { return false }
		error make {msg: $"gcloud secrets versions describe latest --secret ($secret) --project ($project): ($r.stderr | str trim)"}
	}
	($r.stdout | str trim) == "ENABLED"
}

# The plans a release touches: a preview's alone; production's alone with no gate; else production's
# and the rc preview's, which runs in a project of its own where the app gives one.
def release-plans [cue_path: string, preview: string, no_gate: bool]: nothing -> list<record> {
	if ($preview | is-not-empty) { return [(plan-of $cue_path $preview)] }
	if $no_gate { return [(plan-of $cue_path "")] }
	[(plan-of $cue_path "") (plan-of $cue_path "rc")]
}

# Fails, naming every missing (project, secret) pair at once, unless all are there. With
# `if_gcp`, an app with no GCP release is left alone.
export def check-secrets [app_dir: string, --if-gcp, --preview: string = "", --no-gate] {
	let cue_path = ($app_dir | path join release.cue)
	if not ($cue_path | path exists) {
		if $if_gcp { return }
		error make {msg: $"($cue_path) does not exist: check-secrets is for an app with a GCP release"}
	}
	if $if_gcp and ((^cue export --expression GCP.project --out text $cue_path | complete).exit_code != 0) { return }
	# A token, not `gcloud auth list`: in CI the credentials come from workload identity
	# (CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, a fresh CLOUDSDK_CONFIG), which lists no account.
	let who = (^gcloud auth print-access-token --quiet | complete)
	if $who.exit_code != 0 or ($who.stdout | str trim | is-empty) {
		error make {msg: "check-secrets: gcloud is not signed in (run `gcloud auth login`); the secrets a GCP release reads cannot be checked"}
	}
	let pairs = (secret-pairs (release-plans $cue_path $preview $no_gate))
	let have = ($pairs | par-each --keep-order {|p| if (has-enabled-version $p.project $p.secret) { $p } } | compact)
	let missing = (missing-pairs $pairs $have)
	if ($missing | is-not-empty) { error make {msg: (missing-message $missing)} }
	print $"check-secrets: (($pairs | length)) secrets, every one with an enabled latest version in ($pairs | get project | uniq | str join ', ')"
}

def main [verb: string, app_dir: string, --if-gcp, --preview: string = "", --no-gate] {
	if $verb != "check" { error make {msg: $"unknown verb ($verb): check"} }
	check-secrets $app_dir --if-gcp=$if_gcp --preview $preview --no-gate=$no_gate
}
