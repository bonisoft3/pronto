# release.nu: release@gcp, an app on Cloud Run beside Cloud SQL, with gcloud
# alone (docs/release-targets.md#gcp).
#
# The app's release.cue defines `GCP: schema.#Release & {...}` and
# `gcpRelease: schema.#Build & {release: GCP}` (gcp/schema). Each resource is
# described before it is made, so a release runs again unchanged: the same
# images push the same digests and roll nothing, and initdb finds its marker.

use ../k8s/release.nu [resolve-app]

# The services this target runs; anything else in the app's compose project
# needs what it does not build yet (PENDING.md#release-targets).
const runtime = ["database" "crud" "electric" "auth" "caddy"]
const unbuilt = ["mesh-events" "conduit" "transform" "ticker" "clock" "airlock" "compute" "rclone-s3" "imgproxy" "render"]

def --wrapped gc [...args] {
	let input = $in
	# Never a prompt: a release runs where nobody answers one.
	let r = ($input | ^gcloud --quiet ...$args | complete)
	if $r.exit_code != 0 { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
	$r.stdout
}
def --wrapped exists [...args]: nothing -> bool { (^gcloud --quiet ...$args | complete).exit_code == 0 }

def render [cue_path: string, data?: string]: nothing -> record {
	let inputs = [$cue_path] | append (if ($data | is-not-empty) { [$data] } else { [] })
	let res = (do { ^cue export --expression gcpRelease.plan --out json ...$inputs } | complete)
	if $res.exit_code != 0 { error make {msg: $"($cue_path): ($res.stderr)"} }
	$res.stdout | from json
}

def random-secret []: nothing -> string {
	^python3 -I -c 'import secrets,string;a=string.ascii_letters+string.digits;print("".join(secrets.choice(a) for _ in range(48)),end="")'
}

# A secret's latest value, made from `value` (or a random one) when it has none,
# and given a new version only when `value` differs from it.
def ensure-secret [name: string, project: string, value?: string]: nothing -> string {
	if not (exists secrets describe $name --project $project) {
		let v = ($value | default (random-secret))
		$v | gc secrets create $name --project $project --replication-policy automatic --data-file=- | ignore
		return $v
	}
	let current = (gc secrets versions access latest --secret $name --project $project)
	if ($value | is-not-empty) and $value != $current {
		$value | gc secrets versions add $name --project $project --data-file=- | ignore
		return $value
	}
	$current
}

def ensure-infrastructure [plan: record] {
	let p = $plan.project
	let n = $plan.names
	# A preview's release may not enable APIs: the project's first release did.
	if ($plan.preview? | is-empty) {
		gc services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com iam.googleapis.com cloudbuild.googleapis.com --project $p | ignore
	}
	if not (exists artifacts repositories describe $plan.repository --location $plan.region --project $p) {
		# Nor make the repository its images go to, in a project of previews.
		if ($plan.preview? | is-not-empty) {
			error make {msg: $"the Artifact Registry repository ($plan.repository) in ($p) is missing: the project's owner makes it once \(pronto's docs/release-targets.md#previews\)"}
		}
		gc artifacts repositories create $plan.repository --repository-format docker --location $plan.region --project $p --description "pronto images" | ignore
	}
	# Cloud Build's account pushes the images and writes the build's log; a
	# preview's project grants it that once, by its owner, as the repository.
	if ($plan.preview? | is-empty) {
		let builds = (build-account $p)
		gc artifacts repositories add-iam-policy-binding $plan.repository --location $plan.region --project $p --member $"serviceAccount:($builds)" --role roles/artifactregistry.writer | ignore
		gc projects add-iam-policy-binding $p --member $"serviceAccount:($builds)" --role roles/logging.logWriter --condition None --quiet | ignore
	}
	let sa = ($n.serviceAccount | split row "@" | first)
	if ($plan.preview? | is-not-empty) {
		# A preview's release runs from a pull request: it may not grant roles in
		# the project, so the previews' account is the owner's to make, once.
		if not (exists iam service-accounts describe $n.serviceAccount --project $p) {
			error make {msg: $"($n.serviceAccount) is missing: the project's owner makes it once \(pronto's docs/release-targets.md#previews\)"}
		}
	} else {
		if not (exists iam service-accounts describe $n.serviceAccount --project $p) {
			gc iam service-accounts create $sa --project $p --display-name $"($plan.service) on Cloud Run" | ignore
		}
		for role in ["roles/cloudsql.client" "roles/secretmanager.secretAccessor"] {
			gc projects add-iam-policy-binding $p --member $"serviceAccount:($n.serviceAccount)" --role $role --condition None --quiet | ignore
		}
	}

	let pg = (ensure-secret $n.secrets.POSTGRES_PASSWORD $p)
	let electric = (ensure-secret $n.secrets.ELECTRIC_PASSWORD $p)
	ensure-secret $n.secrets.PGRST_JWT_SECRET $p | ignore
	ensure-secret $n.secrets.ELECTRIC_SECRET $p | ignore
	# Through the Auth Proxy on localhost, which carries TLS itself.
	let at = $"@127.0.0.1:5432/($n.database)"
	ensure-secret $n.secrets.CRUD_DB_URI $p $"postgres://postgres:($pg)($at)?sslmode=disable" | ignore
	ensure-secret $n.secrets.AUTH_DATABASE_URL $p $"postgres://postgres:($pg)($at)?sslmode=disable" | ignore
	ensure-secret $n.secrets.ELECTRIC_DB_URL $p $"postgresql://electric:($electric)($at)?sslmode=disable" | ignore
	# A job has no proxy beside it: pgroll's runner reaches the database over the socket.
	ensure-secret $n.secrets.MIGRATE_DATABASE_URL $p $"postgres://postgres:($pg)@/($n.database)?host=/cloudsql/($n.connection)&sslmode=disable" | ignore

	if not (exists sql instances describe $n.instance --project $p) {
		print $"gcp: creating Cloud SQL ($n.instance) \(several minutes\)"
		gc sql instances create $n.instance --project $p --region $plan.region --database-version POSTGRES_18 --edition enterprise --tier $plan.sqlTier --storage-size 10 --storage-type HDD --database-flags $plan.sqlFlags --root-password $pg | ignore
	}
	# Flags an earlier release set differently are patched, which restarts it.
	let flags = (gc sql instances describe $n.instance --project $p --format json | from json | get settings.databaseFlags? | default [] | each {|f| $"($f.name)=($f.value)" } | sort | str join ",")
	if $flags != ($plan.sqlFlags | split row "," | sort | str join ",") {
		print $"gcp: setting ($plan.sqlFlags) on ($n.instance) \(it restarts\)"
		gc sql instances patch $n.instance --project $p --database-flags $plan.sqlFlags --quiet | ignore
	}
	# The password the URLs carry is the user's, whichever came first.
	gc sql users set-password postgres --instance $n.instance --project $p --password $pg | ignore
	if not (exists sql databases describe $n.database --instance $n.instance --project $p) {
		gc sql databases create $n.database --instance $n.instance --project $p | ignore
	}
}

# What builds the runtime images: Docker's own CLI image, with its buildx and
# compose plugins, run by Cloud Build against the Docker of the build's worker.
const builder = "docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d"

# The account Cloud Build runs a build as in the project: the project's
# default, which pushes the images and writes the build's log.
def build-account [project: string]: nothing -> string {
	gc builds get-default-service-account --project $project --format "value(serviceAccountEmail)" | str trim | split row "/" | last
}

# The runtime images, built in Cloud Build as the app's compose project builds
# them, so the machine releasing needs no Docker daemon, and pushed by digest:
# what integrate tested is what releases. The build reads the app's own files
# alone, as git sees them: every context of its images is the app's
# directory or an image by digest.
def push-images [app_dir: string, plan: record, name: string, services: list<string>]: nothing -> record {
	let p = $plan.project
	let host = ($plan.registry | split row "/" | first)
	# A preview's images are tagged for it, never as the release's.
	let tag = ($plan.preview? | default "release")
	let refs = ($services | each {|svc| {svc: $svc, ref: $"($plan.registry)/($name)-($svc):($tag)"} })
	let work = (mktemp -d -t gcp-build.XXXXXX | str trim)
	# Never a certificate pair `sayt setup` issued for this machine: an image
	# carries none.
	do { cd $app_dir; ^git ls-files -co --exclude-standard } | lines | where {|f| not ($f starts-with ".certs/") } | str join "\n" | save -f $"($work)/files"
	with-env {COPYFILE_DISABLE: "1"} { ^tar -czf $"($work)/source.tgz" -C $app_dir -T $"($work)/files" }
	let sets = ($refs | each {|r| $"--set ($r.svc).tags=($r.ref)" } | str join " ")
	# The worker's metadata server lends the build's account a token, which
	# logs Docker into the registry; reproducible, so an unchanged source
	# pushes the digest it pushed before.
	let script = ([
		"set -eu"
		"token=$(wget -qO- --header Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')"
		$"echo \"$token\" | docker login --username oauth2accesstoken --password-stdin https://($host) >/dev/null"
		"docker buildx create --use --driver docker-container >/dev/null"
		$"docker compose --profile '*' config | docker buildx bake -f - --push --provenance=false --allow=fs.read=/workspace --set '*.platform=linux/amd64' ($sets) ($services | str join ' ')"
	] | str join "\n")
	{
		# Cloud Build reads `$NAME` in a step as its own substitution; `$$` is a `$`.
		steps: [{name: $builder, entrypoint: "sh", args: ["-c" ($script | str replace -a "$" "$$")], env: ["SOURCE_DATE_EPOCH=0"]}]
		options: {machineType: "E2_HIGHCPU_8", logging: "CLOUD_LOGGING_ONLY"}
		timeout: "1800s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: building ($services | str join ', ') in Cloud Build"
	let r = (^gcloud --quiet builds submit $"($work)/source.tgz" --config $"($work)/cloudbuild.yaml" --project $p | complete)
	rm -rf $work
	if $r.exit_code != 0 {
		error make {msg: $"Cloud Build failed:\n(($r.stdout + $r.stderr) | lines | last 40 | str join (char nl))"}
	}
	$refs | each {|r|
		let digest = (gc artifacts docker images describe $r.ref --format "value(image_summary.digest)" | str trim)
		{svc: $r.svc, ref: {tag: $tag, digest: $digest}}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
}

# The domain onto the service, through Cloud Run's domain-mapping API: gcloud
# reaches it only from its beta component, which a release cannot assume. The
# records it prints go to the domain's DNS; Google wants the domain verified
# first (Search Console), which no release can do for its owner.
def map-domain [domain: string, service: string, project: string, region: string] {
	let api = $"https://($region)-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/($project)/domainmappings"
	let auth = [Authorization $"Bearer (gc auth print-access-token | str trim)"]
	let got = (http get --full --allow-errors --headers $auth $"($api)/($domain)")
	let mapping = if $got.status == 404 {
		let made = (http post --full --allow-errors --headers $auth --content-type application/json $api {
			apiVersion: "domains.cloudrun.com/v1", kind: "DomainMapping"
			metadata: {name: $domain, namespace: $project}
			spec: {routeName: $service}
		})
		if $made.status >= 300 {
			print $"gcp: ($domain) is not mapped: ($made.body.error?.message? | default ($made.body | to json))"
			print $"gcp: verify it first: gcloud domains verify ($domain)"
			return
		}
		$made.body
	} else if $got.status >= 300 {
		error make {msg: $"($api)/($domain) answered ($got.status): ($got.body | to json)"}
	} else { $got.body }
	let ready = ($mapping.status?.conditions? | default [] | where type == "Ready" | get 0?)
	if ($ready.status? | default "") != "True" {
		print $"gcp: ($domain) is mapped but not ready: ($ready.message? | default 'Google is still provisioning it')"
		print $"gcp: an unverified domain is verified once by its owner: gcloud domains verify ($domain)"
	}
	let records = ($mapping.status?.resourceRecords? | default [])
	if ($records | is-not-empty) {
		print $"gcp: ($domain)'s DNS records:"
		print ($records | select -o type name rrdata | table)
	}
}

# A job applied and run to its end; its logs are where a failure says why.
def run-job [file: string, name: string, what: string, project: string, region: string] {
	gc run jobs replace $file --region $region --project $project | ignore
	print $"gcp: ($what) \(($name)\)"
	let run = (^gcloud --quiet run jobs execute $name --region $region --project $project --wait | complete)
	if $run.exit_code != 0 {
		error make {msg: $"($name) failed: ($run.stderr | str trim)\nlogs: gcloud logging read 'resource.labels.job_name=($name)' --project ($project) --limit 40"}
	}
}

# A preview removed: its service, jobs, instance and secrets. Its images stay
# for the repository's cleanup policy; nothing the release made is touched.
def delete-preview [plan: record] {
	let p = $plan.project
	let r = $plan.region
	let n = $plan.names
	if (exists run services describe $plan.service --region $r --project $p) { gc run services delete $plan.service --region $r --project $p | ignore }
	for job in [$n.job $n.migrateJob] {
		if (exists run jobs describe $job --region $r --project $p) { gc run jobs delete $job --region $r --project $p | ignore }
	}
	if (exists sql instances describe $n.instance --project $p) { gc sql instances delete $n.instance --project $p | ignore }
	for secret in ($n.secrets | values) {
		if (exists secrets describe $secret --project $p) { gc secrets delete $secret --project $p | ignore }
	}
	print $"gcp: preview ($plan.preview) removed"
}

export def main [
	--snapshot      # Build and render only, change nothing in the project
	--dry-run       # Print what would be applied and exit
	--app: string   # Application name or path
	--preview: string # A pull request's own copy beside the release, such as pr-32
	--delete        # Remove the preview, when its pull request closes
] {
	let app_info = (resolve-app $app)
	# sayt hands a release's own flags over as SAY_RELEASE_ARGS_<FLAG>.
	let preview = ($preview | default ($env.SAY_RELEASE_ARGS_PREVIEW? | default ""))
	let delete = ($delete or (($env.SAY_RELEASE_ARGS_DELETE? | default "") | is-not-empty))
	let base = if ($preview | is-empty) { {} } else { {GCP: {preview: $preview}} }
	let base_file = (mktemp -t gcp.XXXXXX.json | str trim)
	$base | to json | save -f $base_file
	let plan0 = (render $app_info.cue_path $base_file)
	rm $base_file
	if $delete {
		if ($preview | is-empty) { error make {msg: "--delete removes a preview: name it with --preview; a release is never deleted here"} }
		delete-preview $plan0
		return
	}
	let services = (do { cd $app_info.dir; ^docker compose --profile "*" config --services } | lines)
	let refused = ($services | where {|s| $s in $unbuilt })
	if ($refused | is-not-empty) {
		error make {msg: $"release@gcp does not run ($refused | str join ', ') yet \(PENDING.md#release-targets\)"}
	}
	if $dry_run { print $plan0.jobYaml; print "---"; print $plan0.serviceYaml; return }

	let name = (^cue export --expression GCP.name --out text $app_info.cue_path | str trim)
	# The cluster's migrate step runs where the app has pgroll migrations to carry, as in compose.
	let has_migrate = ("migrate" in $services)
	let pushed = if $snapshot { {} } else { ensure-infrastructure $plan0; push-images $app_info.dir $plan0 $name ($runtime | append (if $has_migrate { ["migrate"] } else { [] })) }

	# The providers compose gives the auth service, under what release.cue sets.
	let compose = (do { cd $app_info.dir; ^docker compose --profile "*" config --format json } | from json)
	let auth_env = $compose.services.auth.environment
	let fixed = (^cue export --expression GCP.auth.oidc --out json $app_info.cue_path | from json | columns)
	let oidc = ($auth_env | transpose key value | where {|e| ($e.key starts-with "OIDC_") and ($e.key not-in $fixed) and not ($e.key ends-with "_CLIENT_SECRET") }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let number = (gc projects describe $plan0.project --format "value(projectNumber)" | str trim)
	let data_file = (mktemp -t gcp.XXXXXX.json | str trim)
	let migrate = if $has_migrate { {migrate: {env: ($compose.services.migrate.environment? | default {} | reject -o DATABASE_URL)}} } else { {} }
	{GCP: ({image: {pushed: $pushed}, auth: {oidc: $oidc, programProviders: ($auth_env.OIDC_PROVIDERS? | default "")}, runHost: $"($plan0.service)-($number).($plan0.region).run.app"} | merge $migrate | merge ($base.GCP? | default {}))} | to json | save -f $data_file
	let plan = (render $app_info.cue_path $data_file)
	rm $data_file
	mkdir dist/gcp
	$plan.jobYaml | save -f dist/gcp/job.yaml
	$plan.serviceYaml | save -f dist/gcp/service.yaml
	if $has_migrate { $plan.migrateJobYaml | save -f dist/gcp/migrate.yaml }
	if $snapshot { print "gcp: rendered dist/gcp/job.yaml and dist/gcp/service.yaml; nothing applied"; return }

	let p = $plan.project
	let r = $plan.region
	for key in $plan.oidcSecretKeys {
		if not (exists secrets describe $key --project $p) {
			error make {msg: $"secret ($key) is missing: create it with `gcloud secrets create ($key) --project ($p) --data-file=-`"}
		}
	}
	run-job dist/gcp/job.yaml $plan.names.job "building the schema" $p $r
	if $has_migrate { run-job dist/gcp/migrate.yaml $plan.names.migrateJob "carrying the schema forward" $p $r }
	gc run services replace dist/gcp/service.yaml --region $r --project $p | ignore
	gc run services add-iam-policy-binding $plan.service --region $r --project $p --member allUsers --role roles/run.invoker | ignore

	let address = $"https://($plan.service)-($number).($r).run.app"
	for d in ([$plan.domain?] | compact | append $plan.aliases) { map-domain $d $plan.service $p $r }
	# Live means the address answers, not that gcloud returned.
	let health = (^curl --silent --output /dev/null --write-out "%{http_code}" --retry 8 --retry-all-errors $"($address)/health")
	if $health != "200" { error make {msg: $"($address)/health answered ($health)"} }
	print $"gcp: ($plan.service) is live at ($address)"
}
