# build.nu: the images a release runs, built in Cloud Build as the app's
# compose project builds them, so the machine releasing needs no Docker
# daemon. release@gcp pushes them beside the service it rolls, release@k8s to
# the registry its cluster pulls from (docs/release-targets.md).

# What builds and runs the drivers: Docker's own CLI image, with its buildx
# and compose plugins, run by Cloud Build against the Docker of its worker.
export const builder = "docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d"
# What lets an amd64 worker build another platform's images: QEMU's handlers.
const binfmt = "tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"
# How long the release has run, before each of its lines: where its time
# goes, read off the log.
export def stamp []: nothing -> string {
	let ran = ((date now) - ($env.GCP_T0? | default (date now)))
	let s = ($ran / 1sec | math floor)
	$"[+($s // 60 | fill -a r -c '0' -w 2):($s mod 60 | fill -a r -c '0' -w 2)]"
}

export def --wrapped gc [...args] {
	let input = $in
	# Never a prompt: a release runs where nobody answers one.
	let r = ($input | ^gcloud --quiet ...$args | complete)
	if $r.exit_code != 0 { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
	$r.stdout
}
# Whether a resource is there. Only its absence answers false: an expired
# token, a disabled API or a network that dropped would otherwise read as a
# resource to create, and the creation then dies on one that exists.
export def --wrapped exists [...args]: nothing -> bool {
	let r = (^gcloud --quiet ...$args | complete)
	if $r.exit_code != 0 and not ($r.stderr =~ "NOT_FOUND|HTTPError 404|Cannot find|does not exist|not found|was not found") {
		error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"}
	}
	$r.exit_code == 0
}


# The account Cloud Build runs a build as in the project: the project's
# default, which pushes the images and writes the build's log.
export def build-account [project: string]: nothing -> string {
	gc builds get-default-service-account --project $project --format "value(serviceAccountEmail)" | str trim | split row "/" | last
}

# Each file of the app as git sees it (unsaved ones included), with its
# content's hash: the paths `files` lists, hashed in one call.
export def file-hashes [app_dir: string, files: string]: nothing -> table<path: string, hash: string> {
	let paths = (open --raw $files | lines)
	if ($paths | is-empty) { return [] }
	# hash-object reads the paths it is given from the repository's top, and
	# ls-files wrote them from the app's own directory: the app's prefix
	# (apps/<name>/ in a monorepo) turns one into the other.
	let hashes = (do {
		cd $app_dir
		let prefix = (^git rev-parse --show-prefix | str trim)
		let top = (^git rev-parse --show-toplevel | str trim)
		$paths | each {|f| $"($prefix)($f)" } | str join (char nl) | ^git -C $top hash-object --stdin-paths
	} | lines)
	$paths | zip $hashes | each {|p| {path: $p.0, hash: $p.1} }
}

# What every image of a build reads, as one key: every file of the app's and
# what else the build is told. Equal keys build equal images, the build being
# reproducible: what was pushed for a key is what building again would push.
# The key of an image whose inputs are not known more closely (image-keys).
export def source-key [hashes: table, told: string]: nothing -> string {
	[($hashes | each {|h| $"($h.path) ($h.hash)" } | str join (char nl)) $told] | str join (char nl) | hash sha256 | str substring 0..23
}

# A glob of Docker's COPY as an anchored regex's body: `*` and `?` stay within
# a path segment, `**` crosses them, `[!x]` is `[^x]`.
def glob-regex [g: string]: nothing -> string {
	$g | str replace -a -r '([.+(){}|^$\\])' '\$1' | str replace -a '[!' '[^' | str replace -a '**' "\u{1}" | str replace -a '*' '[^/]*' | str replace -a '?' '[^/]' | str replace -a "\u{1}" '.*'
}

# The paths of its build context a Dockerfile reads, as globs; null when it
# may read any (a source that is a build argument, a bound mount of the
# context, a copy of the whole context).
def dockerfile-reads [text: string]: nothing -> any {
	mut reads = []
	mut end = ""
	for raw in ($text | str replace -a -r '\\\r?\n' ' ' | lines) {
		let l = ($raw | str trim)
		# A heredoc's body is the Dockerfile's own text.
		if $end != "" { if $l == $end { $end = "" }; continue }
		let words = ($l | split row -r '\s+')
		let kw = ($words | first)
		# Only a RUN, COPY or ADD opens a heredoc, by a `<<` that starts a word (not a shell's `$((1<<2))`).
		if ($kw =~ '(?i)^(RUN|COPY|ADD)$') {
			let tag = ($l | parse -r "(?:^|\\s)<<-?['\"]?(?<tag>\\w+)")
			if ($tag | is-not-empty) { $end = ($tag | first | get tag) }
		}
		if ($kw =~ '(?i)^RUN$') {
			let binds = ($words | where {|w| $w starts-with "--mount=" and ($w | str contains "type=bind") and not ($w | str contains "from=") })
			if ($binds | is-not-empty) { return null }
		}
		if not ($kw =~ '(?i)^(COPY|ADD)$') { continue }
		let args = ($words | skip 1)
		let flags = ($args | take while {|w| $w starts-with "--" })
		if ($flags | any {|f| $f starts-with "--from=" }) { continue }
		mut srcs = ($args | skip ($flags | length))
		if ($srcs | is-empty) { continue }
		if ($srcs | first | str starts-with "[") {
			let j = (try { $srcs | str join " " | from json } catch { null })
			if $j == null { return null }
			$srcs = $j
		}
		for s in ($srcs | drop 1 | where {|s| not ($s starts-with "<<") and not ($s =~ '^(https?://|git@)') }) {
			if ($s | str contains "$") { return null }
			let p = ($s | str replace -r '^(\./)+' '' | str trim --char '/')
			if $p in ["" "."] { return null }
			$reads = ($reads | append $p)
		}
	}
	$reads
}

# What one image's build reads, as its own hash and the services whose images
# it builds from: its build record from the compose project (machine paths
# made the app's), its Dockerfile, and the files of its context the Dockerfile
# copies. An input not known more closely stands for the whole app (`whole`).
def image-own [app_real: string, b: any, hashes: table, whole: string]: nothing -> record {
	let all = {own: $whole, deps: []}
	if $b == null { return $all }
	let ctx = (try { $b.context | path expand | path relative-to $app_real } catch { null })
	if $ctx == null { return $all }
	let text = if ($b.dockerfile_inline? | is-not-empty) { $b.dockerfile_inline } else {
		let f = ($app_real | path join $ctx ($b.dockerfile? | default "Dockerfile"))
		if ($f | path type) != "file" { return $all }
		open --raw $f
	}
	let under = if ($ctx | is-empty) { $hashes } else {
		$hashes | where {|h| $h.path starts-with $"($ctx)/" } | update path {|h| $h.path | str substring (($ctx | str length) + 1).. }
	}
	let reads = (dockerfile-reads $text)
	let files = if $reads == null { $under } else if ($reads | is-empty) { [] } else {
		let re = ("^(?:" + ($reads | each {|g| glob-regex $g } | str join '|') + ")(?:/.*)?$")
		$under | where {|h| $h.path =~ $re }
	}
	let contexts = ($b.additional_contexts? | default {} | transpose name ref)
	let deps = ($contexts | where {|c| $c.ref starts-with "service:" } | each {|c| $c.ref | str replace "service:" "" })
	# A context that is a directory of the machine counts, when the Dockerfile reads from it, as the whole app.
	let dirs = ($contexts | where {|c| not ($c.ref =~ '^[a-z-]+:') and ($text =~ ('(?i)(from=|FROM )' + ($c.name | str replace -a -r '([.+(){}|^$\\*?\[\]-])' '\$1') + '(\s|$)')) } | each { $whole })
	let record = ($b | reject -o tags cache_from cache_to | to json | str replace -a $app_real ".")
	let own = ([$record ($text | hash sha256) ($files | each {|h| $"($h.path) ($h.hash)" } | str join (char nl))] | append $dirs | str join (char nl) | hash sha256 | str substring 0..23)
	{own: $own, deps: $deps}
}

# The key of each image of `services`: what its build reads and, through the
# images it builds from, what theirs read, so an edit to one service's files
# changes its key and its dependents' alone. The app's compose project is read
# for that (null reading it, or an override, keys each image by the whole app).
export def image-keys [app_dir: string, compose: any, hashes: table, told: string, services: list<string>]: nothing -> record {
	let whole = (source-key $hashes $told)
	let app_real = ($app_dir | path expand)
	let known = ($compose.services? | default {})
	mut owns = {}
	mut todo = ($services | where {|s| $s != "schema" or $s in ($known | columns) })
	# The schema job's image is built from migrate's and the database's.
	if "schema" in $services and "schema" not-in ($known | columns) {
		$owns = ($owns | insert schema {own: ("schema" | hash sha256), deps: ["migrate" "database"]})
		$todo = ($todo | append ["migrate" "database"])
	}
	while ($todo | is-not-empty) {
		let s = ($todo | first)
		$todo = ($todo | skip 1)
		if $s in ($owns | columns) { continue }
		let o = if $compose == null { {own: $whole, deps: []} } else { image-own $app_real ($known | get -o $s | default {} | get -o build) $hashes $whole }
		$owns = ($owns | insert $s $o)
		$todo = ($todo | append ($o.deps | where {|d| $d not-in ($owns | columns) }))
	}
	let owns = $owns
	$services | each {|svc|
		mut seen = []
		mut queue = [$svc]
		while ($queue | is-not-empty) {
			let s = ($queue | first)
			$queue = ($queue | skip 1)
			if $s in $seen { continue }
			$seen = ($seen | append $s)
			$queue = ($queue | append ($owns | get $s | get deps))
		}
		let key = ($seen | sort | each {|s| $"($s) ($owns | get $s | get own)" } | prepend $told | str join (char nl) | hash sha256 | str substring 0..23)
		{svc: $svc, key: $key}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.key }
}

# The tag an image's key leaves on it, which a later release finds it by.
export def key-tag [key: string]: nothing -> string { $"src-($key)" }

# The images pushed for their keys before, by service: those of a release
# whose image did not change since (a retry, a release again, an edit to
# another service's files) need no build. Each image is asked after at once:
# one after another, a dozen gcloud calls were most of a minute.
export def pushed-for [refs: list<record>, keys: record]: nothing -> list<record> {
	$refs | par-each --keep-order {|r|
		let at = $"($r.repo):(key-tag ($keys | get $r.svc))"
		if (exists artifacts docker images describe $at) {
			{svc: $r.svc, repo: $r.repo, digest: (gc artifacts docker images describe $at --format "value(image_summary.digest)" | str trim)}
		}
	} | compact
}

# The runtime images, built in Cloud Build as the app's compose project builds
# them, so the machine releasing needs no Docker daemon, and pushed by digest:
# what integrate tested is what releases. The build reads the app's own files
# alone, as git sees them: every context of its images is the app's
# directory or an image by digest. Each image's layers are cached in the
# registry beside it (`:buildcache`), so a layer whose inputs did not change is
# pulled, not built again; and an image whose inputs did not change since its
# last push is not built at all (image-keys): an edit to one service's files
# builds that image and the ones built from it, no others.
# `--override` is a compose file the build reads after the app's own
# (`--platform`'s images, and release@k8s's release tree, `release-tree`).
export def push-images [
	app_dir: string, plan: record, name: string, services: list<string>
	--platform: string = "linux/amd64"
	--override: string # compose YAML read over the app's compose.yaml
]: nothing -> record {
	let p = $plan.project
	let host = ($plan.registry | split row "/" | first)
	# A preview's images are tagged for it, never as the release's.
	let tag = ($plan.preview? | default "release")
	let refs = ($services | each {|svc| {svc: $svc, repo: $"($plan.registry)/($name)-($svc)", ref: $"($plan.registry)/($name)-($svc):($tag)"} })
	let work = (mktemp -d -t gcp-build.XXXXXX | str trim)
	# Never a certificate pair `sayt setup` issued for this machine: an image
	# carries none.
	do { cd $app_dir; ^git ls-files -co --exclude-standard } | lines | where {|f| not ($f starts-with ".certs/") } | str join "\n" | save -f $"($work)/files"
	let hashes = (file-hashes $app_dir $"($work)/files")
	let told = ([$builder $platform] | append (if ($override | is-empty) { [] } else { [$override] }) | str join " ")
	# An override changes what the images are built from: each is keyed by the whole app then.
	let compose = if ($override | is-not-empty) { null } else { (try { do { cd $app_dir; ^docker compose --profile "*" config --format json } | from json } catch { null }) }
	let keys = (image-keys $app_dir $compose $hashes $told $services)
	let before = (pushed-for $refs $keys)
	let reused = ($before | par-each --keep-order {|b|
		gc artifacts docker tags add $"($b.repo)@($b.digest)" $"($b.repo):($tag)" | ignore
		{svc: $b.svc, ref: {tag: $tag, digest: $b.digest}}
	})
	let all = $services
	let refs = ($refs | where {|r| $r.svc not-in ($before | each {|b| $b.svc }) })
	let services = ($refs | get svc)
	if ($refs | is-empty) {
		print $"gcp: (stamp) ($all | str join ', ') unchanged since they were last built: reusing them"
		rm -rf $work
		return ($reused | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref })
	}
	if ($reused | is-not-empty) { print $"gcp: (stamp) reusing ($reused | each {|b| $b.svc } | str join ', '), unchanged since they were last built" }
	# The schema job's image, `schema`: migrate's, with the database's initdb
	# directory, so one job builds the schema and carries it forward. A bake
	# target beside compose's, from theirs.
	let schema = ("schema" in $services)
	if $schema {
		{target: {schema: {
			context: "."
			contexts: {migrate: "target:migrate", database: "target:database"}
			dockerfile-inline: "FROM migrate\nCOPY --from=database /docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/\n"
		}}} | to json | save -f $"($work)/.pronto-schema.bake.json"
	}
	if ($override | is-not-empty) { $override | save -f $"($work)/.pronto-release.compose.yaml" }
	# The bake file is appended in a second tar: macOS's bsdtar reads `-T`'s
	# list only after every `-C`, so one `-C $app_dir -T … -C $work` call looks
	# for the app's files in $work.
	with-env {COPYFILE_DISABLE: "1"} {
		^tar -cf $"($work)/source.tar" -C $app_dir -T $"($work)/files"
		if $schema { ^tar -rf $"($work)/source.tar" -C $work .pronto-schema.bake.json }
		if ($override | is-not-empty) { ^tar -rf $"($work)/source.tar" -C $work .pronto-release.compose.yaml }
	}
	^gzip -n $"($work)/source.tar"
	mv $"($work)/source.tar.gz" $"($work)/source.tgz"
	let bake_files = if $schema { "-f - -f .pronto-schema.bake.json" } else { "-f -" }
	let compose_files = if ($override | is-not-empty) { "-f compose.yaml -f .pronto-release.compose.yaml " } else { "" }
	# Artifact Registry takes a cache as an image manifest, OCI's.
	let sets = ($refs | each {|r|
		let cache = $"($r.repo):buildcache"
		$"--set ($r.svc).tags=($r.ref) --set ($r.svc).cache-from=type=registry,ref=($cache) --set ($r.svc).cache-to=type=registry,ref=($cache),mode=max,image-manifest=true,oci-mediatypes=true"
	} | str join " ")
	# The worker's metadata server lends the build's account a token, which
	# logs Docker into the registry; reproducible, so an unchanged source
	# pushes the digest it pushed before.
	let script = ([
		"set -eu"
		"token=$(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')"
		$"echo \"$token\" | docker login --username oauth2accesstoken --password-stdin https://($host) >/dev/null"
	] | append (if $platform == "linux/amd64" { [] } else {
		# Cloud Build's workers are amd64: another platform's build steps run
		# under QEMU, which binfmt registers with the worker's kernel.
		[$"docker run --privileged --rm ($binfmt) --install ($platform | split row '/' | last) >/dev/null"]
	}) | append [
		"docker buildx create --use --driver docker-container >/dev/null"
		$"docker compose ($compose_files)--profile '*' config | docker buildx bake ($bake_files) --push --provenance=false --allow=fs.read=/workspace --set '*.platform=($platform)' ($sets) ($services | str join ' ')"
	] | str join "\n")
	{
		# Cloud Build reads `$NAME` in a step as its own substitution; `$$` is a `$`.
		steps: [{name: $builder, entrypoint: "sh", args: ["-c" ($script | str replace -a "$" "$$")], env: ["SOURCE_DATE_EPOCH=0"]}]
		options: {machineType: "E2_HIGHCPU_8", logging: "CLOUD_LOGGING_ONLY"}
		timeout: "1800s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: (stamp) building ($services | str join ', ') in Cloud Build"
	let r = (^gcloud --quiet builds submit $"($work)/source.tgz" --config $"($work)/cloudbuild.yaml" --project $p | complete)
	rm -rf $work
	if $r.exit_code != 0 {
		error make {msg: $"Cloud Build failed:\n(($r.stdout + $r.stderr) | lines | last 40 | str join (char nl))"}
	}
	# Each image's digest read and tagged at once, as pushed-for reads them.
	$refs | par-each --keep-order {|r|
		let digest = (gc artifacts docker images describe $r.ref --format "value(image_summary.digest)" | str trim)
		# Found by its key the next time, should nothing change.
		gc artifacts docker tags add $"($r.repo)@($digest)" $"($r.repo):(key-tag ($keys | get $r.svc))" | ignore
		{svc: $r.svc, ref: {tag: $tag, digest: $digest}}
	} | append $reused | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
}

# The service role's token, HS256 under the gateway's secret, as mecha's
# cluster signs its own (role service, the nil subject) but with no expiry:
# the release restates it from the secret, so it changes only with it.
export def service-jwt [secret: string]: nothing -> string {
	$secret | ^python3 -I -c 'import sys,hmac,hashlib,base64,json
b=lambda d: base64.urlsafe_b64encode(d).rstrip(b"=").decode()
h=b(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
p=b(json.dumps({"role":"service","sub":"00000000-0000-0000-0000-000000000000"},separators=(",",":")).encode())
k=sys.stdin.buffer.read()
print(h+"."+p+"."+b(hmac.new(k,(h+"."+p).encode(),hashlib.sha256).digest()),end="")'
}
