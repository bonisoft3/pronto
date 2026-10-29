# build.nu: the images a release runs, built in Cloud Build as the app's
# compose project builds them, so the machine releasing needs no Docker
# daemon. release@gcp pushes them beside the service it rolls
# (docs/release-targets.md).

# What builds and runs the drivers: Docker's own CLI image, with its buildx
# and compose plugins, run by Cloud Build against the Docker of its worker.
const build_script = path self

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

# What an image build reads, as one key: every file of the app's as git sees
# it (its path and its content's hash, unsaved ones included), and what else
# the build is told. Equal keys build equal images, the build being
# reproducible: what was pushed for a key is what building again would push.
export def source-key [app_dir: string, files: string, told: string]: nothing -> string {
	# hash-object reads the paths it is given from the repository's top, and
	# ls-files wrote them from the app's own directory: the app's prefix
	# (apps/<name>/ in a monorepo) turns one into the other.
	let hashes = (do {
		cd $app_dir
		let prefix = (^git rev-parse --show-prefix | str trim)
		let top = (^git rev-parse --show-toplevel | str trim)
		open --raw $files | lines | each {|f| $"($prefix)($f)" } | str join (char nl) | ^git -C $top hash-object --stdin-paths
	} | str trim)
	let metadata = (open --raw $files | lines | each {|f|
		let entry = (ls -l ($app_dir | path join $f) | first)
		[$f $entry.type $entry.mode? $entry.target?]
	} | to json -r)
	[(open --raw $files) $hashes $metadata $told] | str join (char nl) | hash sha256 | str substring 0..23
}

# The tag an image's key leaves on it, which a later release finds it by.
export def key-tag [key: string]: nothing -> string { $"src-($key)" }

# The images pushed for this key before, by service, when every one of them
# was: a release whose app did not change since (a retry, a release again)
# builds nothing. Null when any is missing.
export def pushed-for [refs: list<record>, key: string]: nothing -> any {
	let found = ($refs | par-each --keep-order {|r|
		let at = $"($r.repo):(key-tag $key)"
		if (exists artifacts docker images describe $at) {
			{svc: $r.svc, repo: $r.repo, digest: (gc artifacts docker images describe $at --format "value(image_summary.digest)" | str trim)}
		}
	} | compact)
	if ($found | length) == ($refs | length) { $found } else { null }
}

# The runtime images, built in Cloud Build as the app's compose project builds
# them, so the machine releasing needs no Docker daemon, and pushed by digest:
# what integrate tested is what releases. The build reads the app's own files
# alone, as git sees them: every context of its images is the app's
# directory or an image by digest. Each image's layers are cached in the
# registry beside it (`:buildcache`), so a layer whose inputs did not change is
# pulled, not built again; and an app unchanged since its last push builds
# nothing at all (source-key).
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
	# What it was told before the override existed, so a gcp release keeps its key.
	let key = (source-key $app_dir $"($work)/files" ([$builder (open --raw $build_script | hash sha256) ($services | str join " ") $platform] | append (if ($override | is-empty) { [] } else { [$override] }) | str join " "))
	let before = (pushed-for $refs $key)
	if $before != null {
		print $"gcp: (stamp) ($services | str join ', ') unchanged since they were last built: reusing them"
		rm -rf $work
		return ($before | par-each --keep-order {|b|
			gc artifacts docker tags add $"($b.repo)@($b.digest)" $"($b.repo):($tag)" | ignore
			{svc: $b.svc, ref: {tag: $tag, digest: $b.digest}}
		} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref })
	}
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
		gc artifacts docker tags add $"($r.repo)@($digest)" $"($r.repo):(key-tag $key)" | ignore
		{svc: $r.svc, ref: {tag: $tag, digest: $digest}}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
}
