# verify.nu: verify@gcp, the integration tests of an app against its address
# on Cloud Run, the release's or a preview's (docs/release-targets.md#gcp).
#
# A driver is what verify@<target> names one: a service of the app's compose
# project that measures a running app through APP_URL, such as omnishell's
# visual lint or an app's browser acceptance at integrate (bayt's base of
# each, at scale 0, only describes its build). Each is built as
# bayt builds it, from the compose config, and runs as integrate runs it with
# APP_URL at the target and nothing else of the stack up. A check that reads
# no APP_URL drives the cluster itself, and stays with integrate.
#
# The drivers run in Cloud Build in the target's project, which reaches its
# address wherever the machine verifying is, on 32 vCPUs: a driver's browser
# renders in software, and a 2-CPU runner timed a 3D page out.

use ../k8s/release.nu [resolve-app]
use release-record.nu
use build.nu [builder stamp exists key-tag file-hashes image-keys]

# What uploads the drivers' screenshots: Google's own gsutil builder.
const uploader = "gcr.io/cloud-builders/gsutil"

def --wrapped gc [...args] {
	let r = (^gcloud --quiet ...$args | complete)
	if $r.exit_code != 0 { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
	$r.stdout
}

def render [cue_path: string, data?: string]: nothing -> record {
	let inputs = [$cue_path] | append (if ($data | is-not-empty) { [$data] } else { [] })
	let res = (do { ^cue export --expression gcpRelease.plan --out json ...$inputs } | complete)
	if $res.exit_code != 0 { error make {msg: $"($cue_path): ($res.stderr)"} }
	$res.stdout | from json
}

# The plan a release or a preview renders.
export def plan-of [cue_path: string, preview: string]: nothing -> record {
	if ($preview | is-empty) { return (render $cue_path) }
	let base_file = (mktemp -t gcp.XXXXXX.json | str trim)
	{GCP: {preview: $preview}} | to json | save -f $base_file
	let plan = (render $cue_path $base_file)
	rm $base_file
	$plan
}

# The drivers' build, started before the service they test is up: their
# images build while the release deploys it, then the build waits for
# `go-drivers` (a marker in the project's Cloud Build bucket) to run them.
# A record `go-drivers`, `finish-drivers` and `cancel-drivers` take.
export def start-drivers [app_dir: string, plan: record]: nothing -> record {
	let p = $plan.project
	# The address release.nu configures the service for, its passkeys' relying
	# party among it: Cloud Run's other one, status.url, is another host.
	let number = (gc projects describe $p --format "value(projectNumber)" | str trim)
	let url = $"https://($plan.service)-($number).($plan.region).run.app"
	let work = (mktemp -d -t gcp-verify.XXXXXX | str trim)
	# Where the drivers' layer caches live: the project's registry, beside the
	# images the release pushes there.
	let registry_host = ($plan.registry | split row "/" | first)
	let cache_repo = $"($plan.registry)/($plan.service)-verify"
	# The app's own files, as git sees them, as its images are built from.
	do { cd $app_dir; ^git ls-files -co --exclude-standard } | lines | where {|f| not ($f starts-with ".certs/") } | str join "\n" | save -f $"($work)/files"
	with-env {COPYFILE_DISABLE: "1"} { ^tar -czf $"($work)/source.tgz" -C $app_dir -T $"($work)/files" }
	# A driver whose inputs did not change since its image was last pushed is
	# pulled by that image's digest, not built again (image-keys, as the
	# release's own images): its bases alone were four minutes of every release.
	# The registry is asked after here, where the drivers are read as the build
	# reads them; any doubt builds them all.
	let compose = (try { do { cd $app_dir; ^docker compose --profile "*" config --format json } | from json } catch { null })
	let names = if $compose == null { [] } else {
		$compose.services | transpose name svc | where {|s| ($s.svc.environment?.APP_URL? != null) and (($s.svc.scale? | default 1) != 0) } | get name | sort
	}
	let keys = if ($names | is-empty) { {} } else { image-keys $app_dir $compose (file-hashes $app_dir $"($work)/files") $"($builder) verify linux/amd64" $names }
	# PRONTO_VERIFY_NO_DRIVER_CACHE=1 builds them all, as before.
	let found = if ($env.PRONTO_VERIFY_NO_DRIVER_CACHE? | is-not-empty) { [] } else { (try {
		$names | par-each --keep-order {|d|
			let at = $"($cache_repo)-($d):(key-tag ($keys | get $d))"
			if (exists artifacts docker images describe $at) {
				$"($d)=($cache_repo)-($d)@(gc artifacts docker images describe $at --format "value(image_summary.digest)" | str trim)"
			}
		} | compact
	} catch { [] }) }
	let pushed = ($names | each {|d| $"($d)=($cache_repo)-($d):(key-tag ($keys | get $d))" })
	# The drivers a rehearsal job runs (GCP.rehearsal) are built and pushed here, but run in the job.
	let rehearsal = ($plan.rehearsal? | default null)
	let replaced = if $rehearsal == null { [] } else { $rehearsal.replaces }
	if $rehearsal != null and ($rehearsal.driver not-in $names) { error make {msg: $"GCP.rehearsal.driver ($rehearsal.driver) is no driver of the app: ($names | str join ', ')"} }
	let rehearsal_image = if $rehearsal == null { null } else { $"($cache_repo)-($rehearsal.driver):(key-tag ($keys | get $rehearsal.driver))" }
	if ($found | is-not-empty) { print $"gcp: (stamp) the drivers ($found | each {|f| $f | split row '=' | first } | str join ', ') are unchanged since they were last built: pulling them" }
	let script = ([
		"set -eu"
		"apk add --no-cache jq >/dev/null"
		"drivers=$(docker compose --profile '*' config --format json | jq -r '.services | to_entries[] | select(.value.environment.APP_URL != null and (.value.scale // 1) != 0) | .key' | sort)"
		"[ -n \"$drivers\" ] || { echo 'verify: no service of the app reads APP_URL' >&2; exit 1; }"
		"echo \"verify: building $(echo $drivers)\""
		$"replaced='($replaced | str join ' ')'"
		"tested=''; for d in $drivers; do case \" $replaced \" in *\" $d \"*) ;; *) tested=\"$tested $d\" ;; esac; done"
		"docker buildx create --use --driver docker-container >/dev/null"
		# Each driver's layers cached in the registry, as the runtime images'
		# are (release.nu push-images): a browser and its packages are pulled,
		# not installed again, while the drivers' own files are unchanged.
		$"echo \"$\(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\\\"access_token\\\":\\\"\\\([^\\\"]*\\\)\\\".*/\\1/p'\)\" | docker login --username oauth2accesstoken --password-stdin https://($registry_host) >/dev/null"
		# The drivers whose image the registry has for their inputs are pulled
		# and named as compose names them, so `compose run` finds them built.
		$"cached='($found | str join ' ')'"
		$"pushed='($pushed | str join ' ')'"
		"image_of() { docker compose --profile '*' config --format json | jq -r --arg d \"$1\" '.services[$d].image // (.name + \"-\" + $d)'; }"
		"tobuild=''"
		"for d in $drivers; do"
		"  ref=''; for c in $cached; do [ \"${c%%=*}\" != \"$d\" ] || ref=\"${c#*=}\"; done"
		"  if [ -n \"$ref\" ] && docker pull -q \"$ref\" >/dev/null && docker tag \"$ref\" \"$(image_of \"$d\")\"; then echo \"verify: $d pulled from $ref\"; else tobuild=\"$tobuild $d\"; fi"
		"done"
		"caches=''"
		$"for d in $tobuild; do c=\"($cache_repo)-$d:buildcache\"; caches=\"$caches --set $d.cache-from=type=registry,ref=$c --set $d.cache-to=type=registry,ref=$c,mode=max,image-manifest=true,oci-mediatypes=true\"; done"
		# Loaded with their layers uncompressed: gzip of a browser's image is a
		# minute and more, for a tarball that only crosses a socket.
		"if [ -n \"$tobuild\" ]; then"
		"  docker compose --profile '*' config | docker buildx bake -f - --set '*.output=type=docker,compression=uncompressed' --provenance=false --allow=fs.read=/workspace --set '*.platform=linux/amd64' $caches $tobuild"
		# What `compose run` would build first, the images the drivers' own are
		# made from, built and loaded now: from the bake's cache, before the wait.
		"  docker compose --profile '*' build --with-dependencies $tobuild"
		# What was built is pushed under its inputs' key, for the next release
		# to pull: while the release deploys, and should the push fail the
		# tests still run.
		"  for d in $tobuild; do"
		"    for c in $pushed; do [ \"${c%%=*}\" != \"$d\" ] || { docker tag \"$(image_of \"$d\")\" \"${c#*=}\" && docker push -q \"${c#*=}\" >/dev/null || echo \"verify: $d not cached\" >&2; }; done"
		"  done"
		"fi"
		# The release says go once the service is up: a marker in the bucket,
		# read with the build account's token from the worker's metadata.
		"echo 'verify: waiting for the service to be up'"
		# As long as the release takes: no limit, a stuck wait shows in the log's progress line.
		"waited=0; step=1"
		"until token=$(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p') && wget -qO /dev/null --header \"Authorization: Bearer $token\" \"https://storage.googleapis.com/storage/v1/b/${PROJECT_ID}_cloudbuild/o/verify%2F${BUILD_ID}%2Fgo\" 2>/dev/null; do"
		# A second apart for ten minutes, then three.
		"  [ \"$waited\" -lt 600 ] || step=3"
		"  waited=$((waited + step)); [ $((waited % 300)) -ge $step ] || echo \"verify: still waiting for the release to say go ($waited s)\"; sleep $step"
		"done"
		"echo \"verify: $(echo $tested) against $APP_URL\""
		# The drivers run together, each to its end whatever the others answer,
		# with SHOTS naming where it may leave screenshots, copied out of its
		# container; each one's log is printed whole once all are done. The
		# first makes the compose project's network, which the others join.
		"mkdir -p /workspace/shots /workspace/verdicts /workspace/logs"
		"drive() {"
		"  docker compose --profile '*' run --name \"verify-$1\" --no-deps -e APP_URL=\"$APP_URL\" -e SHOTS=/shots \"$1\" >\"/workspace/logs/$1\" 2>&1 || true"
		"  docker inspect -f '{{.State.ExitCode}}' \"verify-$1\" >\"/workspace/verdicts/$1\" 2>/dev/null || echo 1 >\"/workspace/verdicts/$1\""
		"  docker cp \"verify-$1:/shots\" \"/workspace/shots/$1\" 2>/dev/null || true"
		"  docker rm -f \"verify-$1\" >/dev/null 2>&1 || true"
		"}"
		"first=1"
		"for d in $tested; do"
		"  drive \"$d\" &"
		"  if [ \"$first\" = 1 ]; then first=0; until docker inspect \"verify-$d\" >/dev/null 2>&1 || [ -s \"/workspace/verdicts/$d\" ]; do sleep 1; done; fi"
		"done"
		"wait"
		"failed=''"
		"for d in $tested; do"
		"  echo \"verify: $d\""
		"  cat \"/workspace/logs/$d\""
		"  if [ \"$(cat \"/workspace/verdicts/$d\")\" = 0 ]; then echo \"verify: $d passed\"; else echo \"verify: $d FAILED\" >&2; failed=\"$failed $d\"; fi"
		"done"
		"echo \"$failed\" > /workspace/failed"
	] | str join "\n")
	# The screenshots go to the project's Cloud Build bucket whatever the
	# drivers answered; the verdict is the last step's.
	let upload = ([
		"if [ -n \"$(ls -A /workspace/shots 2>/dev/null)\" ]; then"
		"  gsutil -q -m cp -r /workspace/shots \"gs://${PROJECT_ID}_cloudbuild/verify/${BUILD_ID}/\""
		"  echo \"verify: screenshots in gs://${PROJECT_ID}_cloudbuild/verify/${BUILD_ID}/shots/\""
		"fi"
	] | str join "\n")
	let verdict = ([
		"failed=$(cat /workspace/failed)"
		"[ -z \"$failed\" ] || { echo \"verify: failed:$failed\" >&2; exit 1; }"
		"echo 'verify: every driver passed'"
	] | str join "\n")
	# Cloud Build reads `$NAME` in a step as its own substitution, and `$$` is
	# a `$`: the scripts' own are escaped, ${PROJECT_ID} and ${BUILD_ID} are its.
	let shell = {|s| $s | str replace -a "$" "$$" | str replace -a "$${PROJECT_ID}" "${PROJECT_ID}" | str replace -a "$${BUILD_ID}" "${BUILD_ID}" }
	{
		steps: [
			{name: $builder, entrypoint: "sh", args: ["-c" (do $shell $script)], env: [$"APP_URL=($url)" "SOURCE_DATE_EPOCH=0"]}
			{name: $uploader, entrypoint: "bash", args: ["-c" (do $shell $upload)]}
			{name: $builder, entrypoint: "sh", args: ["-c" (do $shell $verdict)]}
		]
		options: {machineType: "E2_HIGHCPU_32", logging: "CLOUD_LOGGING_ONLY"}
		timeout: "86400s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: (stamp) building the tests of ($url) in Cloud Build"
	# The build logs to Cloud Logging alone, which `builds submit` does not
	# stream: its log is printed once it ends, without the image builds' lines.
	let build = (gc builds submit $"($work)/source.tgz" --config $"($work)/cloudbuild.yaml" --project $p --async --format "value(id)" | str trim)
	rm -rf $work
	print $"gcp: (stamp) build ($build): https://console.cloud.google.com/cloud-build/builds/($build)?project=($p)"
	{app: ($plan.app? | default null), appDir: $app_dir, build: $build, project: $p, url: $url, service: $plan.service, region: $plan.region, rehearsalImage: $rehearsal_image}
}

# The drivers' build told to run them, now that the service is up.
export def go-drivers [run: record] {
	gc run services describe $run.service --region $run.region --project $run.project --format "value(status.url)" | ignore
	let f = (mktemp -t gcp-go.XXXXXX | str trim)
	"go" | save -f $f
	gc storage cp $f $"gs://($run.project)_cloudbuild/verify/($run.build)/go" | ignore
	rm $f
	print $"gcp: (stamp) testing ($run.url)"
}

# The scenarios a cue file text defines: the keys of `scenarios:` at the start of a line (tests/scenarios/*.cue).
export def scenario-names [text: string]: nothing -> list<string> {
	$text | parse -r '(?m)^scenarios:\s+"?(?<n>[A-Za-z0-9_.-]+)"?:' | each {|r| $r.n } | uniq
}

# The scenarios a log marks failed, as a scenario prints it (`✗ <name> (12s) at step`): the format
# release-cron's bisect reads too (pronto-plugins release-cron/cron.js signature()).
export def failed-scenarios [lines: list<string>]: nothing -> list<string> {
	$lines | each {|l| $l | parse -r '✗ (?<n>\S+) \(\d+s\) at step' | each {|r| $r.n } } | flatten | uniq
}

# The log of each driver that failed, from the drivers' build log: what a driver printed lies between
# its `verify: <driver>` line and its `verify: <driver> FAILED` one.
export def failed-sections [lines: list<string>]: nothing -> list<list<string>> {
	mut buffer = []
	mut sections = []
	for l in $lines {
		if ($l | parse -r '^verify: \S+ FAILED$' | is-not-empty) { $sections = ($sections | append [$buffer]) ; $buffer = [] } else if ($l | parse -r '^verify: \S+$' | is-not-empty) { $buffer = [] } else { $buffer = ($buffer | append $l) }
	}
	$sections
}

# new when every failure is a scenario absent from the last live release's tree; regression when one
# was in it; unknown for anything else (a failure naming no scenario, a name the current tree does not
# define, or one the live tree mentions in a way the keys do not show). `sections` is the log of each
# failed unit. When in doubt, not new.
export def classify-failures [sections: list<list<string>>, live_names: list<string>, live_text: string, current_names: list<string>]: nothing -> record {
	let named = ($sections | each {|s| failed-scenarios $s })
	# A line marked failed that is not a scenario's (a stack, Premium, a summary) is another failure.
	let marked = ($sections | flatten | where {|l| $l | str trim | str starts-with "✗" })
	if ($marked | length) != ($sections | flatten | where {|l| (failed-scenarios [$l]) | is-not-empty } | length) { return {verdict: "unknown", new: [], why: "a failure is not a scenario's"} }
	if ($sections | is-empty) or ($named | any {|n| $n | is-empty }) { return {verdict: "unknown", new: [], why: "a failure names no scenario"} }
	let all = ($named | flatten | uniq)
	let regressed = ($all | where {|n| $n in $live_names })
	if ($regressed | is-not-empty) { return {verdict: "regression", new: [], why: $"already in the live release: ($regressed | str join ', ')"} }
	let odd = ($all | where {|n| $n not-in $current_names or ($live_text | str contains $n) })
	if ($odd | is-not-empty) { return {verdict: "unknown", new: [], why: $"cannot be classified: ($odd | str join ', ')"} }
	{verdict: "new", new: $all, why: ""}
}

# The scenarios of a failed run that are a new feature's, as a list: empty unless every failure is one
# (classify-failures), against the tree of the app's last live release. One rule for every place a
# scenario failure fails the release. Prints the line the caller greps and notes it in the release record.
export def new-feature-excuse [run: record, sections: list<list<string>>]: nothing -> list<string> {
	let app = ($run.app? | default null)
	let dir = ($run.appDir? | default null)
	if $app == null or $dir == null { return [] }
	let verdict = (try {
		let commit = (release-record live-commit $app)
		if $commit == null { error make {msg: "no known live release"} }
		let have = (do { ^git -C $dir cat-file -e $"($commit)^{commit}" } | complete)
		if $have.exit_code != 0 {
			do { ^git -C $dir fetch --quiet origin $commit } | complete | ignore
			if (do { ^git -C $dir cat-file -e $"($commit)^{commit}" } | complete).exit_code != 0 { error make {msg: $"commit ($commit) is not in the checkout"} }
		}
		let files = (^git -C $dir ls-tree -r --name-only $commit -- tests/scenarios/ | lines | where {|f| $f | str ends-with ".cue" })
		let live_text = ($files | each {|f| ^git -C $dir show $"($commit):./($f)" } | str join "\n")
		let current_text = (glob $"($dir)/tests/scenarios/*.cue" | each {|f| open --raw $f } | str join "\n")
		classify-failures $sections (scenario-names $live_text) $live_text (scenario-names $current_text) | insert commit $commit
	} catch {|e| {verdict: "unknown", new: [], why: $e.msg, commit: null} })
	if $verdict.verdict != "new" {
		print $"gcp: (stamp) the failure is not a new feature's scenario alone \(($verdict.verdict): ($verdict.why)\): the release fails"
		return []
	}
	print $"gcp: (stamp) new-feature scenarios failed, released anyway: ($verdict.new | str join ', ') \(absent from ($verdict.commit | str substring 0..<8), live release\)"
	release-record note {newFeatureScenarios: $verdict.new}
	$verdict.new
}

# GCP.rehearsal run: the job of the previews project, on the driver image the tests' build pushes,
# against the preview's address. Always returns the record of the run (ok, execution, seconds, usd);
# its log is printed whole. The cost is the job's seconds at the vCPU and GiB prices GCP.rehearsal names.
export def run-rehearsal [run: record, r: record]: nothing -> record {
	let image = $run.rehearsalImage
	# The image is pushed by the tests' build, which has gone on to wait for the preview.
	mut waited = 0
	while not (exists artifacts docker images describe $image) {
		# No limit: a stuck push shows in this line, every five minutes.
		if $waited > 0 and ($waited mod 300) == 0 { print $"gcp: (stamp) still waiting for the rehearsal's image ($image) to be pushed, ($waited)s: see the tests' build ($run.build)" }
		# The build ended without pushing it: it never will be.
		if ($waited mod 30) == 0 {
			let status = (gc builds describe $run.build --project $run.project --format "value(status)" | str trim)
			if $status not-in ["QUEUED" "PENDING" "WORKING"] and not (exists artifacts docker images describe $image) { error make {msg: $"the tests' build ($run.build) ended ($status) without pushing the rehearsal's image ($image)"} }
		}
		sleep 5sec
		$waited += 5
	}
	gc run jobs update $r.job --image $image --region $run.region --project $run.project | ignore
	# gcloud's own escaping of a list: `~` between the pairs, so no pair may hold one.
	let pairs = ($r.env | merge {APP_URL: $run.url} | items {|k, v| $"($k)=($v)" })
	if ($pairs | any {|p| $p | str contains "~" }) { error make {msg: "GCP.rehearsal.env holds a ~, which separates the job's variables"} }
	let vars = ($pairs | str join "~")
	print $"gcp: (stamp) the rehearsal: job ($r.job) on ($image) against ($run.url)"
	let execution = (gc run jobs execute $r.job --region $run.region --project $run.project $"--update-env-vars=^~^($vars)" --async --format "value(metadata.name)" | str trim)
	print $"gcp: (stamp) rehearsal execution ($execution): https://console.cloud.google.com/run/jobs/executions/details/($run.region)/($execution)?project=($run.project)"
	mut done = {}
	loop {
		sleep 5sec
		$done = (gc run jobs executions describe $execution --region $run.region --project $run.project --format json | from json)
		if ($done.status?.completionTime? | is-not-empty) { break }
	}
	let seconds = (($done.status.completionTime | into datetime) - ($done.status.startTime | into datetime)) / 1sec | math round --precision 1
	let limits = (gc run jobs describe $r.job --region $run.region --project $run.project --format json | from json | get spec.template.spec.template.spec.containers.0.resources.limits)
	let vcpu = (if ($limits.cpu | str ends-with "m") { ($limits.cpu | str replace "m" "" | into float) / 1000 } else { $limits.cpu | into float })
	let memory_gi = (if ($limits.memory | str ends-with "Gi") { $limits.memory | str replace "Gi" "" | into float } else if ($limits.memory | str ends-with "Mi") { ($limits.memory | str replace "Mi" "" | into float) / 1024 } else { error make {msg: $"the job's memory ($limits.memory) is not in Gi or Mi"} })
	let usd = ($seconds * ($vcpu * $r.price.vcpu + $memory_gi * $r.price.gib) | math round --precision 4)
	# The execution's Completed condition, not a count of tasks: one task that failed fails it.
	let ok = ($done.status.conditions? | default [] | any {|c| $c.type == "Completed" and $c.status == "True" })
	sleep 10sec # Cloud Logging takes the last lines a moment after the run ends
	let log = (gc logging read $"resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"($execution)\"" --project $run.project --order asc --limit 100000 --format "value(textPayload)"
		| lines | where {|l| $l | str trim | is-not-empty })
	$log | each {|l| print $"rehearsal| ($l)" } | ignore
	# Failing scenarios that are all a new feature's do not fail the release.
	let new_feature = if $ok { [] } else { new-feature-excuse $run [$log] }
	let ok = ($ok or ($new_feature | is-not-empty))
	print $"gcp: (stamp) the rehearsal (if $ok { 'passed' } else { 'FAILED' }) in ($seconds)s: $($usd) \(($vcpu) vCPU, ($memory_gi) GiB\)"
	{ok: $ok, newFeature: $new_feature, job: $r.job, execution: $execution, seconds: $seconds, vcpu: $vcpu, memoryGi: $memory_gi, usd: $usd}
}

# The drivers' build stopped, when the service it waits for never came up.
export def cancel-drivers [run: record] {
	do { ^gcloud --quiet builds cancel $run.build --project $run.project } | complete | ignore
}

# The drivers' build to its end, its log printed; an error when one failed,
# after all have run.
# The drivers' build to its end. A failure prints the drivers' log before it
# stops the release; a pass goes on at once, the release printing the log once
# it is done (drivers-log), since reading it is most of a minute.
export def finish-drivers [run: record] {
	print $"gcp: (stamp) waiting for the tests to end"
	mut status = "QUEUED"
	mut polls = 0
	while $status in ["QUEUED" "PENDING" "WORKING"] {
		# A second apart (the gcloud call is most of it) for 300 polls, then three.
		if $polls > 300 { sleep 3sec } else { sleep 1sec }
		$polls += 1
		$status = (gc builds describe $run.build --project $run.project --format "value(status)" | str trim)
	}
	if $status != "SUCCESS" {
		let lines = (driver-lines $run --just-ended)
		$lines | each {|l| print $l } | ignore
		# Only the last step, the drivers' verdict, may have failed: not their build, nor the screenshots' upload.
		let steps = (try { gc builds describe $run.build --project $run.project --format json | from json | get steps | get status } catch { [] })
		if $status == "FAILURE" and $steps == ["SUCCESS" "SUCCESS" "FAILURE"] and (new-feature-excuse $run (failed-sections $lines) | is-not-empty) { return }
		error make {msg: $"the tests failed against ($run.url) \(($status)\): each driver's verdict is in the log above"}
	}
	print $"gcp: (stamp) every test passed against ($run.url)"
}

# What the drivers printed, from the build's log, as lines.
export def driver-lines [
	run: record
	--just-ended # Cloud Logging takes the last lines a moment after the build ends
]: nothing -> list<string> {
	if $just_ended { sleep 10sec }
	gc logging read $"resource.type=\"build\" AND resource.labels.build_id=\"($run.build)\"" --project $run.project --order asc --limit 100000 --format "value(textPayload)"
		| lines | each {|l| $l | str replace -r '^Step #\d+: ' '' } | where {|l| not ($l starts-with "#") and ($l | str trim | is-not-empty) }
}

# What the drivers printed, from the build's log.
export def drivers-log [
	run: record
	--just-ended # Cloud Logging takes the last lines a moment after the build ends
] {
	driver-lines $run --just-ended=$just_ended | each {|l| print $l } | ignore
}

# Every driver of the app against the service the plan names, up already; an
# error when one fails, after all have run.
export def run-drivers [app_dir: string, plan: record] {
	let run = (start-drivers $app_dir $plan)
	go-drivers $run
	# The drivers GCP.rehearsal replaces run in its job, beside the others in Cloud Build.
	let rehearsal = if ($plan.rehearsal? | is-empty) { null } else { run-rehearsal $run $plan.rehearsal }
	finish-drivers $run
	drivers-log $run --just-ended
	if $rehearsal != null and not $rehearsal.ok { error make {msg: $"the rehearsal failed \(execution ($rehearsal.execution)\): its log is above"} }
}

export def main [
	--app: string     # Application name or path
	--preview: string # The preview to test, such as pr-32; the release when absent
] {
	let app_info = (resolve-app $app)
	let preview = ($preview | default ($env.SAY_VERIFY_ARGS_PREVIEW? | default ""))
	run-drivers $app_info.dir (plan-of $app_info.cue_path $preview)
}
