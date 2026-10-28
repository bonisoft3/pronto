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
use build.nu [builder stamp]

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
	let script = ([
		"set -eu"
		"apk add --no-cache jq >/dev/null"
		"drivers=$(docker compose --profile '*' config --format json | jq -r '.services | to_entries[] | select(.value.environment.APP_URL != null and (.value.scale // 1) != 0) | .key' | sort)"
		"[ -n \"$drivers\" ] || { echo 'verify: no service of the app reads APP_URL' >&2; exit 1; }"
		"echo \"verify: building $(echo $drivers)\""
		"docker buildx create --use --driver docker-container >/dev/null"
		# Each driver's layers cached in the registry, as the runtime images'
		# are (release.nu push-images): a browser and its packages are pulled,
		# not installed again, while the drivers' own files are unchanged.
		$"echo \"$\(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\\\"access_token\\\":\\\"\\\([^\\\"]*\\\)\\\".*/\\1/p'\)\" | docker login --username oauth2accesstoken --password-stdin https://($registry_host) >/dev/null"
		"caches=''"
		$"for d in $drivers; do c=\"($cache_repo)-$d:buildcache\"; caches=\"$caches --set $d.cache-from=type=registry,ref=$c --set $d.cache-to=type=registry,ref=$c,mode=max,image-manifest=true,oci-mediatypes=true\"; done"
		# Loaded with their layers uncompressed: gzip of a browser's image is a
		# minute and more, for a tarball that only crosses a socket.
		"docker compose --profile '*' config | docker buildx bake -f - --set '*.output=type=docker,compression=uncompressed' --provenance=false --allow=fs.read=/workspace --set '*.platform=linux/amd64' $caches $drivers"
		# What `compose run` would build first, the images the drivers' own are
		# made from, built and loaded now: from the bake's cache, before the wait.
		"docker compose --profile '*' build --with-dependencies $drivers"
		# The release says go once the service is up: a marker in the bucket,
		# read with the build account's token from the worker's metadata.
		"echo 'verify: waiting for the service to be up'"
		# Forty minutes at most, should the release that says it be gone.
		"waited=0"
		"until token=$(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p') && wget -qO /dev/null --header \"Authorization: Bearer $token\" \"https://storage.googleapis.com/storage/v1/b/${PROJECT_ID}_cloudbuild/o/verify%2F${BUILD_ID}%2Fgo\" 2>/dev/null; do"
		"  waited=$((waited + 2)); [ \"$waited\" -lt 2400 ] || { echo 'verify: the release never said go' >&2; exit 1; }; sleep 2"
		"done"
		"echo \"verify: $(echo $drivers) against $APP_URL\""
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
		"for d in $drivers; do"
		"  drive \"$d\" &"
		"  if [ \"$first\" = 1 ]; then first=0; until docker inspect \"verify-$d\" >/dev/null 2>&1 || [ -s \"/workspace/verdicts/$d\" ]; do sleep 1; done; fi"
		"done"
		"wait"
		"failed=''"
		"for d in $drivers; do"
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
		timeout: "3600s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: (stamp) building the tests of ($url) in Cloud Build"
	# The build logs to Cloud Logging alone, which `builds submit` does not
	# stream: its log is printed once it ends, without the image builds' lines.
	let build = (gc builds submit $"($work)/source.tgz" --config $"($work)/cloudbuild.yaml" --project $p --async --format "value(id)" | str trim)
	rm -rf $work
	print $"gcp: (stamp) build ($build): https://console.cloud.google.com/cloud-build/builds/($build)?project=($p)"
	{build: $build, project: $p, url: $url, service: $plan.service, region: $plan.region}
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
	while $status in ["QUEUED" "PENDING" "WORKING"] {
		sleep 2sec
		$status = (gc builds describe $run.build --project $run.project --format "value(status)" | str trim)
	}
	if $status != "SUCCESS" {
		drivers-log $run --just-ended
		error make {msg: $"the tests failed against ($run.url) \(($status)\): each driver's verdict is in the log above"}
	}
	print $"gcp: (stamp) every test passed against ($run.url)"
}

# What the drivers printed, from the build's log.
export def drivers-log [
	run: record
	--just-ended # Cloud Logging takes the last lines a moment after the build ends
] {
	if $just_ended { sleep 10sec }
	gc logging read $"resource.type=\"build\" AND resource.labels.build_id=\"($run.build)\"" --project $run.project --order asc --limit 100000 --format "value(textPayload)"
		| lines | each {|l| $l | str replace -r '^Step #\d+: ' '' } | where {|l| not ($l starts-with "#") and ($l | str trim | is-not-empty) } | each {|l| print $l } | ignore
}

# Every driver of the app against the service the plan names, up already; an
# error when one fails, after all have run.
export def run-drivers [app_dir: string, plan: record] {
	let run = (start-drivers $app_dir $plan)
	go-drivers $run
	finish-drivers $run
	drivers-log $run --just-ended
}

export def main [
	--app: string     # Application name or path
	--preview: string # The preview to test, such as pr-32; the release when absent
] {
	let app_info = (resolve-app $app)
	let preview = ($preview | default ($env.SAY_VERIFY_ARGS_PREVIEW? | default ""))
	run-drivers $app_info.dir (plan-of $app_info.cue_path $preview)
}
