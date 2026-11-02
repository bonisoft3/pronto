# release-record.nu: the record of every release@gcp run, one JSON line appended to
# ~/.cache/pronto/releases/<app>.jsonl once the release lock is let go, however the run ended
# (docs/release-targets.md#gcp). The release marks its phases and notes its facts as it goes into
# a marks file ($env.PRONTO_RELEASE_MARKS) that the record is folded from; a run without one (a dry
# run, a snapshot, a preview's --delete) marks nothing and records nothing.

const pronto = (path self ..)

# Marks only the run's own target: the rc preview a gated release deploys marks nothing.
def own [preview: string]: nothing -> bool {
	($env.PRONTO_RELEASE_MARKS? | is-not-empty) and $preview == ($env.PRONTO_RELEASE_PREVIEW? | default "")
}

def append-mark [line: record] {
	$"($line | to json --raw)\n" | save --append $env.PRONTO_RELEASE_MARKS
}

# A phase's start or end, for the release's own target (`preview`, "" for production).
export def mark [phase: string, edge: string, --preview: string = ""] {
	if not (own $preview) { return }
	append-mark {phase: $phase, edge: $edge, at: (date now | format date "%+")}
}

# A fact of the record (rc, localGate, revision, schema), the last one noted standing.
export def note [fact: record, --preview: string = ""] {
	if not (own $preview) { return }
	append-mark {fact: $fact}
}

def iso []: datetime -> string { $in | date to-timezone UTC | format date "%Y-%m-%dT%H:%M:%SZ" }

def seconds []: duration -> float { $in / 1sec | math round --precision 1 }

# The app checkout's commit and whether its directory differs from it, read before the release.
export def checkout [dir: string]: nothing -> record {
	let head = (do { ^git -C $dir rev-parse HEAD } | complete)
	let status = (do { ^git -C $dir status --porcelain -- . } | complete)
	{
		commit: (if $head.exit_code == 0 { $head.stdout | str trim } else { null })
		dirty: ($status.exit_code != 0 or ($status.stdout | str trim | is-not-empty))
	}
}

def version []: nothing -> string {
	open --raw ($pronto | path join distribution config.cue) | parse -r '#Version:\s+"(?<v>[^"]+)"' | get 0.v
}

# The record folded from the marks: phases in seconds, a phase never ended timed to the run's end.
def fold [cue_path: string, preview: string, started: datetime, ended: datetime, outcome: string, failure: any, at: record]: nothing -> record {
	let g = (^cue export --expression GCP --out json $cue_path | from json)
	let lines = (open --raw $env.PRONTO_RELEASE_MARKS | lines | where {|l| $l | is-not-empty } | each {|l| $l | from json })
	let facts = ($lines | where {|l| "fact" in $l } | reduce -f {rc: "skipped: the run ended before the rc gate was decided", localGate: "skipped", revision: null} {|l, acc| $acc | merge $l.fact })
	let marks = ($lines | where {|l| "phase" in $l })
	let span = {|p|
		let s = ($marks | where {|m| $m.phase == $p and $m.edge == "start" })
		if ($s | is-empty) { return null }
		let e = ($marks | where {|m| $m.phase == $p and $m.edge == "end" })
		let end = if ($e | is-empty) { $ended } else { $e | last | get at | into datetime }
		($end - ($s | first | get at | into datetime)) | seconds
	}
	let schema = if ($facts.schema? | default "") == "skipped" { "skipped" } else { do $span schema }
	let golive = (do $span deploy)
	{
		app: $g.name
		service: (if ($preview | is-empty) { $g.service } else { $"($g.service)-($preview)" })
		project: (if ($preview | is-not-empty) and ($g.previewProject? | is-not-empty) { $g.previewProject } else { $g.project })
		preview: $preview
		commit: $at.commit
		dirty: $at.dirty
		pronto: (version)
		started: ($started | iso)
		ended: ($ended | iso)
		outcome: $outcome
		failure: (if $failure == null { null } else { $failure | lines | where {|l| $l | str trim | is-not-empty } | get -o 0 })
		rc: $facts.rc
		localGate: $facts.localGate
		revision: $facts.revision
		phases: {
			lock: (do $span lock)
			gate: (do $span gate)
			rc: (do $span rc)
			stage: (do $span stage)
			schema: $schema
			# go-live but its schema job.
			deploy: (if $golive == null { null } else if ($schema | describe) == "float" { $golive - $schema | math round --precision 1 } else { $golive })
			total: (($ended - $started) | seconds)
		}
	}
}

# The record appended to the app's file. Its writing never fails the release: a warning says why not.
export def write [cue_path: string, preview: string, started: datetime, outcome: string, failure: any, at: record] {
	let ended = (date now)
	try {
		let r = (fold $cue_path $preview $started $ended $outcome $failure $at)
		let dir = ($env.HOME | path join .cache pronto releases)
		mkdir $dir
		$"($r | to json --raw)\n" | save --append ($dir | path join $"($r.app).jsonl")
		rm -f $env.PRONTO_RELEASE_MARKS
	} catch {|e| print -e $"gcp: warning: the release's record was not written: ($e.msg)" }
}
