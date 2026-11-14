# local-gate-key.nu: the ledgers of release@gcp's gates (docs/release-targets.md#gcp).
#
# local-gate: a tree that passed `integrate@local` with INTEGRATE_LOCAL_DRIVERS=all (or the app's
# full rehearsal) on this machine is stamped under ~/.cache/pronto/local-gate/<app>/<key>, and the
# release skips the local gate for it. The key is a hash of the app's files as git lists them
# (tracked and untracked, not ignored: a changed or new file changes it) and of the pronto files
# the gate runs, so another pronto version never matches.
#
# rc-passed: the deploy-shaped key of the last release that passed the rc preview gate, under
# ~/.cache/pronto/rc-passed/<app>/<key>. A release whose local gate passed skips rc while its
# deploy-shaped key (release.cue, compose files, infra/, program.cue, cue.mod/module.cue,
# .mise.toml, mise.lock, and the pronto runtime's content but its release engine) has a stamp.
# A pronto version change that differs only in the release engine (gcp/*.nu, the release tests,
# testdata/, docs/) does not move that key; the mise pins of other tools still do.
#
# The one place the keys are computed; release.nu, integrate-local.ts and an app's rehearsal use it:
#
#   nu gcp/local-gate-key.nu key|passed|stamp <app dir> [key]              the local gate's tree
#   nu gcp/local-gate-key.nu deploy-key|rc-passed|rc-stamp <app dir> [key] the rc gate's deploy-shaped inputs
#
# `key` and `deploy-key` print the key; `passed` and `rc-passed` print true or false; `stamp` and
# `rc-stamp` record a pass for the key given, which is the one taken before the run it vouches
# for (the tree as it stands only where none is given). A tree whose key cannot be read is not stamped.

const pronto = (path self ..)
const gate_files = ["integrate-local.ts" "local-drivers.ts" "upgrade-from-released.ts" "plugin.json"]
# What the local gate never exercises, because it runs host processes and not the images, the
# service as Cloud Run renders it or the project: the release's and the compose files, how an
# image is built (Dockerfiles, docker/, the web server's, entrypoints' and sidecars' files), the
# cluster's facts, the rules and the toolchain's pins. Database migrations are not here: the
# local gate runs them on postgres.
const deploy_pattern = '^(release\.cue|program\.cue|cue\.mod/module\.cue|\.mise\.toml|mise\.lock|\.say\.yaml|\.pronto/cluster\.json|infra/.*|docker/.*|sidecars?/.*|(\.bayt/)?compose[^/]*\.ya?ml|(.*/)?(\.bayt/)?[^/]*Dockerfile[^/]*|(.*/)?(Caddyfile[^/]*|nginx[^/]*\.conf|[^/]*entrypoint[^/]*))$'

const pin_files = [".mise.toml" "mise.toml" "mise.lock" "cue.mod/module.cue"]

# A pin file's text without pronto's own pin: its line in the mise config, its tool blocks in the
# lock (version, checksums, urls), its dependency in the CUE module. What pronto's version moves
# is judged by its content (pronto-content), not by the number.
def without-pronto-pin [file: string]: string -> string {
	let text = $in
	match ($file | path basename) {
		".mise.toml" | "mise.toml" => { $text | lines | where {|l| $l !~ '^\s*.?github:bonisoft3/pronto.?\s*=' } | str join (char nl) }
		"mise.lock" => {
			mut keep = true
			mut out = []
			for l in ($text | lines) {
				if $l =~ '^\[' { $keep = not ($l | str contains 'github:bonisoft3/pronto') }
				if $keep { $out = ($out | append $l) }
			}
			$out | str join (char nl)
		}
		_ => { $text | str replace -r '"github.com/bonisoft3/pronto@v0":\s*\{[^}]*\}' "" }
	}
}

def ledger [app_dir: string, kind: string]: nothing -> string {
	$env.HOME | path join .cache pronto $kind ($app_dir | path expand | path basename)
}

# Hash of the files, among the app's, that `keep` selects, with the pronto files given. Absolute
# paths: hash-object reads relative ones from the repository root, not the app. The listing is
# NUL-separated, so no name is quoted, dropped or split; a listed path that is gone (a tracked
# file deleted) stays in the key by name, one that is not a file by name alone.
def tree-key [app_dir: string, keep: closure, own: list<string>, unpin: bool, ...more: string]: nothing -> any {
	let dir = ($app_dir | path expand)
	let listed = (do { ^git -C $dir ls-files -co --exclude-standard -z } | complete)
	if $listed.exit_code != 0 { return null }
	let names = ($listed.stdout | split row (char nul) | where {|f| $f != "" and (do $keep $f) })
	if ($names | any {|f| $f =~ '\n' }) { error make {msg: "a file name with a newline cannot be keyed"} }
	let files = ($names | where {|f| ($dir | path join $f | path exists) and ($dir | path join $f | path type) in [file symlink] })
	let hashed = ($files | each {|f| $dir | path join $f } | str join (char nl) | do { ^git -C $dir hash-object --stdin-paths } | complete)
	if $hashed.exit_code != 0 { return null }
	# The deploy key reads a pin file without the pronto pin (without-pronto-pin), the pin being
	# what the runtime's own content stands for there.
	let hashes = if not $unpin { $hashed.stdout | lines } else {
		$files | zip ($hashed.stdout | lines) | each {|p| if $p.0 in $pin_files { open --raw ($dir | path join $p.0) | without-pronto-pin $p.0 | hash sha256 } else { $p.1 } }
	}
	let theirs = ($own | each {|f| open --raw ($pronto | path join $f) | hash sha256 })
	# The tools' pins (sayt, omnishell and its visual lint, mise's) above the app, where the app's
	# own are not the repository's.
	let top = (^git -C $dir rev-parse --show-toplevel | str trim)
	let pins = if $top == $dir { [] } else {
		["mise.lock" ".mise.toml" "mise.toml"] | where {|f| $top | path join $f | path exists } | each {|f| let text = (open --raw ($top | path join $f)); (if $unpin { $text | without-pronto-pin $f } else { $text }) | hash sha256 }
	}
	[...$names ...$hashes ...$theirs ...$more ...$pins] | str join (char nl) | hash sha256
}

# The local gate's key of the tree as it stands, or null where git cannot read it (no ledger then).
export def key [app_dir: string]: nothing -> any {
	tree-key $app_dir {|f| $f !~ '^\.(omc|claude)/' } $gate_files false
}

# The pronto files whose change can alter what a release deploys: the runtime mise installed
# (everything under `$pronto`) but the release engine's own files. Each as `path hash`, the
# version line of distribution/config.cue left out, since a new version number alone changes
# nothing. A release-engine-only change was tested by the release's own fork tests (release-flow)
# before it was published, which stands in for the rc run it used to cause
# (docs/decisions/2026-11-01-local-gate-replaces-rc.md).
const engine_pattern = '^(gcp/[^/]*\.nu|(release-flow|release-gcp|local-gate-key)\.test\.ts|testdata/.*|docs/.*)$'
def pronto-content []: nothing -> list<string> {
	glob ($pronto | path join "**" "*") --no-dir --exclude ["**/.git/**" "**/.omc/**" "**/.claude/**" "**/node_modules/**"]
		| each {|f| $f | path relative-to $pronto }
		| where {|f| $f !~ $engine_pattern }
		| sort
		| each {|f|
			let text = (open --raw ($pronto | path join $f))
			let kept = if $f == "distribution/config.cue" { $text | lines | where {|l| $l !~ '^#Version:' } | str join (char nl) } else { $text }
			$"($f) ($kept | hash sha256)"
		}
}

# The rc gate's: only the deploy-shaped files, and pronto's deploy-relevant content.
export def deploy-key [app_dir: string]: nothing -> any {
	tree-key $app_dir {|f| $f =~ $deploy_pattern } [] true ...(pronto-content)
}

def seen [app_dir: string, kind: string, k: any]: nothing -> bool {
	$k != null and ((ledger $app_dir $kind | path join $k) | path exists)
}

def record [app_dir: string, kind: string, k: any] {
	if $k == null { error make {msg: "no stamp for a tree whose key cannot be read"} }
	mkdir (ledger $app_dir $kind)
	(date now | format date "%+") | save -f (ledger $app_dir $kind | path join $k)
}

# Whether this tree passed the local gate on this machine (the key given, else the tree's).
export def passed [app_dir: string, k?: string]: nothing -> bool { seen $app_dir local-gate ($k | default (key $app_dir)) }

# The stamp of a local pass, for the tree whose key is given (taken before the gate ran).
export def stamp [app_dir: string, k?: string] { record $app_dir local-gate ($k | default (key $app_dir)) }

# Whether a release with this deploy-shaped key passed the rc gate.
export def rc-passed [app_dir: string, k?: string]: nothing -> bool { seen $app_dir rc-passed ($k | default (deploy-key $app_dir)) }

# The stamp of an rc pass, for the deploy-shaped key given (taken before the release ran).
export def rc-stamp [app_dir: string, k?: string] { record $app_dir rc-passed ($k | default (deploy-key $app_dir)) }

def main [verb: string, app_dir: string, k?: string] {
	match $verb {
		"key" => { print (key $app_dir) }
		"passed" => { print (passed $app_dir) }
		"stamp" => { stamp $app_dir $k }
		"deploy-key" => { print (deploy-key $app_dir) }
		"rc-passed" => { print (rc-passed $app_dir) }
		"rc-stamp" => { rc-stamp $app_dir $k }
		_ => { error make {msg: $"local-gate-key.nu: unknown verb ($verb): key, passed, stamp, deploy-key, rc-passed or rc-stamp"} }
	}
}
