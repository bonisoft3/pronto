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
# .mise.toml, mise.lock, and pronto's gcp scripts) has a stamp.
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
const gate_files = ["integrate-local.ts" "local-drivers.ts" "plugin.json"]
# What the local gate never exercises, because it runs host processes and not the images, the
# service as Cloud Run renders it or the project: the release's and the compose files, how an
# image is built (Dockerfiles, docker/, the web server's, entrypoints' and sidecars' files), the
# cluster's facts, the rules and the toolchain's pins. Database migrations are not here: the
# local gate runs them on postgres.
const deploy_pattern = '^(release\.cue|program\.cue|cue\.mod/module\.cue|\.mise\.toml|mise\.lock|\.say\.yaml|\.pronto/cluster\.json|infra/.*|docker/.*|sidecars?/.*|(\.bayt/)?compose[^/]*\.ya?ml|(.*/)?(\.bayt/)?[^/]*Dockerfile[^/]*|(.*/)?(Caddyfile[^/]*|nginx[^/]*\.conf|[^/]*entrypoint[^/]*))$'

def ledger [app_dir: string, kind: string]: nothing -> string {
	$env.HOME | path join .cache pronto $kind ($app_dir | path expand | path basename)
}

# Hash of the files, among the app's, that `keep` selects, with the pronto files given. Absolute
# paths: hash-object reads relative ones from the repository root, not the app. The listing is
# NUL-separated, so no name is quoted, dropped or split; a listed path that is gone (a tracked
# file deleted) stays in the key by name, one that is not a file by name alone.
def tree-key [app_dir: string, keep: closure, own: list<string>]: nothing -> any {
	let dir = ($app_dir | path expand)
	let listed = (do { ^git -C $dir ls-files -co --exclude-standard -z } | complete)
	if $listed.exit_code != 0 { return null }
	let names = ($listed.stdout | split row (char nul) | where {|f| $f != "" and (do $keep $f) })
	if ($names | any {|f| $f =~ '\n' }) { error make {msg: "a file name with a newline cannot be keyed"} }
	let files = ($names | where {|f| ($dir | path join $f | path exists) and ($dir | path join $f | path type) in [file symlink] })
	let hashed = ($files | each {|f| $dir | path join $f } | str join (char nl) | do { ^git -C $dir hash-object --stdin-paths } | complete)
	if $hashed.exit_code != 0 { return null }
	let theirs = ($own | each {|f| open --raw ($pronto | path join $f) | hash sha256 })
	# The tools' pins (sayt, omnishell and its visual lint, mise's) above the app, where the app's
	# own are not the repository's.
	let top = (^git -C $dir rev-parse --show-toplevel | str trim)
	let pins = if $top == $dir { [] } else {
		["mise.lock" ".mise.toml" "mise.toml"] | each {|f| $top | path join $f } | where {|f| $f | path exists } | each {|f| open --raw $f | hash sha256 }
	}
	[...$names ...($hashed.stdout | lines) ...$theirs ...$pins] | str join (char nl) | hash sha256
}

# The local gate's key of the tree as it stands, or null where git cannot read it (no ledger then).
export def key [app_dir: string]: nothing -> any {
	tree-key $app_dir {|f| $f !~ '^\.(omc|claude)/' } $gate_files
}

# The rc gate's: only the deploy-shaped files, and pronto's release scripts.
export def deploy-key [app_dir: string]: nothing -> any {
	let scripts = (glob ($pronto | path join gcp *.nu) | each {|f| $f | path relative-to $pronto } | sort)
	tree-key $app_dir {|f| $f =~ $deploy_pattern } ["plugin.json" ...$scripts]
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
