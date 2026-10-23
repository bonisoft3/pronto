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

# What builds and runs the drivers: Docker's own CLI image, with its buildx
# and compose plugins, run by Cloud Build against the Docker of its worker.
export const builder = "docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d"
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

# Every driver of the app against the service the plan names; an error when
# one fails, after all have run.
export def run-drivers [app_dir: string, plan: record] {
	let p = $plan.project
	# The address release.nu configures the service for, its passkeys' relying
	# party among it: Cloud Run's other one, status.url, is another host.
	gc run services describe $plan.service --region $plan.region --project $p --format "value(status.url)" | ignore
	let number = (gc projects describe $p --format "value(projectNumber)" | str trim)
	let url = $"https://($plan.service)-($number).($plan.region).run.app"
	let work = (mktemp -d -t gcp-verify.XXXXXX | str trim)
	# The app's own files, as git sees them, as its images are built from.
	do { cd $app_dir; ^git ls-files -co --exclude-standard } | lines | where {|f| not ($f starts-with ".certs/") } | str join "\n" | save -f $"($work)/files"
	with-env {COPYFILE_DISABLE: "1"} { ^tar -czf $"($work)/source.tgz" -C $app_dir -T $"($work)/files" }
	let script = ([
		"set -eu"
		"apk add --no-cache jq >/dev/null"
		"drivers=$(docker compose --profile '*' config --format json | jq -r '.services | to_entries[] | select(.value.environment.APP_URL != null and (.value.scale // 1) != 0) | .key' | sort)"
		"[ -n \"$drivers\" ] || { echo 'verify: no service of the app reads APP_URL' >&2; exit 1; }"
		"echo \"verify: $(echo $drivers) against $APP_URL\""
		"docker buildx create --use --driver docker-container >/dev/null"
		"docker compose --profile '*' config | docker buildx bake -f - --load --provenance=false --allow=fs.read=/workspace --set '*.platform=linux/amd64' $drivers"
		# Every driver runs, whatever the one before it answered, with SHOTS
		# naming where it may leave screenshots, copied out of its container.
		"failed=''"
		"mkdir -p /workspace/shots"
		"for d in $drivers; do"
		"  echo \"verify: $d\""
		"  if docker compose --profile '*' run --name \"verify-$d\" --no-deps -e APP_URL=\"$APP_URL\" -e SHOTS=/shots \"$d\"; then echo \"verify: $d passed\"; else echo \"verify: $d FAILED\" >&2; failed=\"$failed $d\"; fi"
		"  docker cp \"verify-$d:/shots\" \"/workspace/shots/$d\" 2>/dev/null || true"
		"  docker rm -f \"verify-$d\" >/dev/null 2>&1 || true"
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
	print $"gcp: testing ($url) in Cloud Build"
	# The build logs to Cloud Logging alone, which `builds submit` does not
	# stream: its log is printed once it ends, without the image builds' lines.
	let build = (gc builds submit $"($work)/source.tgz" --config $"($work)/cloudbuild.yaml" --project $p --async --format "value(id)" | str trim)
	rm -rf $work
	print $"gcp: build ($build): https://console.cloud.google.com/cloud-build/builds/($build)?project=($p)"
	mut status = "QUEUED"
	while $status in ["QUEUED" "PENDING" "WORKING"] {
		sleep 20sec
		$status = (gc builds describe $build --project $p --format "value(status)" | str trim)
	}
	# Cloud Logging takes the last lines a moment after the build ends.
	sleep 10sec
	gc logging read $"resource.type=\"build\" AND resource.labels.build_id=\"($build)\"" --project $p --order asc --limit 100000 --format "value(textPayload)"
		| lines | each {|l| $l | str replace -r '^Step #\d+: ' '' } | where {|l| not ($l starts-with "#") and ($l | str trim | is-not-empty) } | each {|l| print $l } | ignore
	if $status != "SUCCESS" { error make {msg: $"the tests failed against ($url) \(($status)\): each driver's verdict is in the log above"} }
	print $"gcp: every test passed against ($url)"
}

export def main [
	--app: string     # Application name or path
	--preview: string # The preview to test, such as pr-32; the release when absent
] {
	let app_info = (resolve-app $app)
	let preview = ($preview | default ($env.SAY_VERIFY_ARGS_PREVIEW? | default ""))
	run-drivers $app_info.dir (plan-of $app_info.cue_path $preview)
}
