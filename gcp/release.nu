# release.nu: release@gcp, an app on Cloud Run beside Cloud SQL, with gcloud
# alone (docs/release-targets.md#gcp).
#
# The app's release.cue defines `GCP: schema.#Release & {...}` and
# `gcpRelease: schema.#Build & {release: GCP}` (gcp/schema). Each resource is
# described before it is made, so a release runs again unchanged: the same
# images push the same digests and roll nothing, and initdb finds its marker.

use ../k8s/release.nu [resolve-app]
use verify.nu [run-drivers plan-of builder]

# The services this target runs; anything else in the app's compose project
# needs what it does not build yet (PENDING.md#release-targets).
const runtime = ["database" "crud" "electric" "auth" "caddy"]
# compose's clock is not one of them: Cloud Scheduler is the ticker's clock here.
const unbuilt = ["mesh-events" "conduit" "transform" "airlock" "compute" "render"]

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

# The service role's token, HS256 under the gateway's secret, as mecha's
# cluster signs its own (role service, the nil subject) but with no expiry:
# the release restates it from the secret, so it changes only with it.
def service-jwt [secret: string]: nothing -> string {
	$secret | ^python3 -I -c 'import sys,hmac,hashlib,base64,json
b=lambda d: base64.urlsafe_b64encode(d).rstrip(b"=").decode()
h=b(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
p=b(json.dumps({"role":"service","sub":"00000000-0000-0000-0000-000000000000"},separators=(",",":")).encode())
k=sys.stdin.buffer.read()
print(h+"."+p+"."+b(hmac.new(k,(h+"."+p).encode(),hashlib.sha256).digest()),end="")'
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
		gc services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com iam.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com --project $p | ignore
		# Where a sidecar's metrics are scraped to: Managed Service for Prometheus.
		if ($plan.scrapeConfig | is-not-empty) { gc services enable monitoring.googleapis.com --project $p | ignore }
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
		let roles = ["roles/cloudsql.client" "roles/secretmanager.secretAccessor"] | append (if ($plan.scrapeConfig | is-not-empty) { ["roles/monitoring.metricWriter"] } else { [] })
		for role in $roles {
			gc projects add-iam-policy-binding $p --member $"serviceAccount:($n.serviceAccount)" --role $role --condition None --quiet | ignore
		}
	}

	let pg = (ensure-secret $n.secrets.POSTGRES_PASSWORD $p)
	let electric = (ensure-secret $n.secrets.ELECTRIC_PASSWORD $p)
	let authenticator = (ensure-secret $n.secrets.AUTHENTICATOR_PASSWORD $p)
	let jwt_secret = (ensure-secret $n.secrets.PGRST_JWT_SECRET $p)
	ensure-secret $n.secrets.SERVICE_JWT $p (service-jwt $jwt_secret) | ignore
	ensure-secret $n.secrets.ELECTRIC_SECRET $p | ignore
	# Through the Auth Proxy on localhost, which carries TLS itself.
	let at = $"@127.0.0.1:5432/($n.database)"
	# PostgREST logs in as the authenticator role, as compose's crud does.
	ensure-secret $n.secrets.CRUD_DB_URI $p $"postgres://authenticator:($authenticator)($at)?sslmode=disable" | ignore
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

# What builds the runtime images is verify.nu's builder: Docker's own CLI
# image, with its buildx and compose plugins, run by Cloud Build against the
# Docker of the build's worker.

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

# What copies a tested preview's images into the release's registry: Google's
# crane, which logs in as the build's account through the worker's metadata.
const copier = "gcr.io/go-containerregistry/gcrane:v0.22.1@sha256:67b9993e083198db3d30ae6d2bb685cc67a45494a3c485ef2fa9994715bee9ff"

# The release's images, copied by digest from the preview its tests ran
# against, so what was tested is, byte for byte, what releases. Cloud Build in
# the release's project copies them, and its account reads the previews'
# repository: a grant its owner makes once (docs/release-targets.md#previews).
def copy-images [plan: record, name: string, services: list<string>, from: record]: nothing -> record {
	let p = $plan.project
	let refs = ($services | each {|svc|
		let src = ($from.pushed | get -o $svc)
		if $src == null { error make {msg: $"the preview has no ($svc) image to release"} }
		{svc: $svc, src: $"($from.registry)/($name)-($svc)@($src.digest)", digest: $src.digest, ref: $"($plan.registry)/($name)-($svc):release"}
	})
	let work = (mktemp -d -t gcp-copy.XXXXXX | str trim)
	{
		steps: ($refs | each {|r| {name: $copier, args: ["cp" $r.src $r.ref]} })
		options: {logging: "CLOUD_LOGGING_ONLY"}
		timeout: "1200s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: copying the tested ($services | str join ', ') from the preview"
	let r = (^gcloud --quiet builds submit --no-source --config $"($work)/cloudbuild.yaml" --project $p | complete)
	rm -rf $work
	if $r.exit_code != 0 {
		let builds = (build-account $p)
		error make {msg: $"the preview's images were not copied \(its repository may not let ($builds) read it: gcloud artifacts repositories add-iam-policy-binding ($from.registry | split row '/' | last) --project ($from.registry | split row '/' | get 1) --location ($plan.region) --member serviceAccount:($builds) --role roles/artifactregistry.reader\):\n(($r.stdout + $r.stderr) | lines | last 20 | str join (char nl))"}
	}
	$refs | each {|r|
		let digest = (gc artifacts docker images describe $r.ref --format "value(image_summary.digest)" | str trim)
		if $digest != $r.digest { error make {msg: $"($r.ref) is ($digest), not the tested ($r.digest)"} }
		{svc: $r.svc, ref: {tag: "release", digest: $digest}}
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

# The ticker's clock: one Cloud Scheduler job POSTing to the door's /poke each
# minute, made or brought to the plan's. It carries the service token, as the
# compose clock does: the service answers anyone, so Cloud Run has no OIDC
# token to check (mecha's services/ticker, the cloud clock), and the ticker
# compares the bearer itself. No retry: the next minute recomputes the same.
def ensure-clock [clock: record, token: string, project: string, region: string] {
	let common = [--location $region --project $project --schedule $clock.schedule --time-zone Etc/UTC --uri $clock.uri --http-method POST --max-retry-attempts 0 --attempt-deadline 60s]
	let header = $"Authorization=Bearer ($token)"
	if (exists scheduler jobs describe $clock.name --location $region --project $project) {
		gc scheduler jobs update http $clock.name ...$common --update-headers $header | ignore
	} else {
		gc scheduler jobs create http $clock.name ...$common --headers $header | ignore
	}
	# A job made just after the API is enabled can sit past its first slot
	# until something runs it; running it once also pokes the new revision.
	gc scheduler jobs run $clock.name --location $region --project $project | ignore
	print $"gcp: the ticker's clock \(($clock.name)\) pokes ($clock.uri) each minute"
}

# The blob plane's bucket, in the region, its objects the service account's
# alone: nothing in it is public, since readers reach a picture through the
# door's /img. Made once; the grant is restated on every release.
def ensure-bucket [bucket: string, account: string, project: string, region: string] {
	if not (exists storage buckets describe $"gs://($bucket)" --project $project) {
		gc storage buckets create $"gs://($bucket)" --project $project --location $region --uniform-bucket-level-access --public-access-prevention | ignore
	}
	gc storage buckets add-iam-policy-binding $"gs://($bucket)" --project $project --member $"serviceAccount:($account)" --role roles/storage.objectAdmin | ignore
	print $"gcp: pictures are kept in gs://($bucket)"
}

# A preview stopped: what runs against its database (its service, jobs and
# clock), so the database is no one's.
def stop-preview [plan: record] {
	let p = $plan.project
	let r = $plan.region
	let n = $plan.names
	if (exists run services describe $plan.service --region $r --project $p) { gc run services delete $plan.service --region $r --project $p | ignore }
	for job in [$n.job $n.migrateJob] {
		if (exists run jobs describe $job --region $r --project $p) { gc run jobs delete $job --region $r --project $p | ignore }
	}
	if (exists scheduler jobs describe $n.clock --location $r --project $p) { gc scheduler jobs delete $n.clock --location $r --project $p | ignore }
}

# A preview to deploy afresh on its instance as it stands: stopped, and its
# database dropped, which the deploy makes again and builds the schema in.
# Dropping it drops the replication slot its electric left there.
def empty-preview [plan: record] {
	stop-preview $plan
	let n = $plan.names
	if (exists sql databases describe $n.database --instance $n.instance --project $plan.project) {
		print $"gcp: emptying the preview ($plan.preview): dropping its database on ($n.instance)"
		gc sql databases delete $n.database --instance $n.instance --project $plan.project | ignore
	}
}

# A preview removed: its service, jobs, instance and secrets. Its images stay
# for the repository's cleanup policy; nothing the release made is touched.
def delete-preview [plan: record] {
	let p = $plan.project
	let n = $plan.names
	stop-preview $plan
	if (exists sql instances describe $n.instance --project $p) { gc sql instances delete $n.instance --project $p | ignore }
	for secret in ($n.secrets | values) {
		if (exists secrets describe $secret --project $p) { gc secrets delete $secret --project $p | ignore }
	}
	print $"gcp: preview ($plan.preview) removed"
}

# What a release or a preview deploys, from the plan release.cue renders for
# it, ending once its address answers; the images it ran, by digest. A
# release given a tested preview's (`from`) runs those, copied, not rebuilt.
def deploy [app_info: record, preview: string, dry_run: bool, snapshot: bool, from?: record]: nothing -> record {
	let base = if ($preview | is-empty) { {} } else { {GCP: {preview: $preview}} }
	let plan0 = (plan-of $app_info.cue_path $preview)
	let services = (do { cd $app_info.dir; ^docker compose --profile "*" config --services } | lines)
	let refused = ($services | where {|s| $s in $unbuilt })
	if ($refused | is-not-empty) {
		error make {msg: $"release@gcp does not run ($refused | str join ', ') yet \(PENDING.md#release-targets\)"}
	}
	if $dry_run { print $plan0.jobYaml; print "---"; print $plan0.serviceYaml; return {} }

	let name = (^cue export --expression GCP.name --out text $app_info.cue_path | str trim)
	# The cluster's migrate step runs where the app has pgroll migrations to carry, as in compose.
	let has_migrate = ("migrate" in $services)
	# The ticker, where the app declares a schedule or a machine's timer.
	let has_ticker = ("ticker" in $services)
	# The blob plane, where the app turns it on: two more containers over a bucket.
	let has_blobs = ("rclone-s3" in $services)
	# The app's own containers beside them (GCP.sidecars), each one of its compose services.
	let missing = ($plan0.sidecars | where {|s| $s not-in $services })
	if ($missing | is-not-empty) {
		error make {msg: $"GCP.sidecars names ($missing | str join ', '), which the app's compose project does not define"}
	}
	let images = ($runtime | append (if $has_migrate { ["migrate"] } else { [] }) | append (if $has_ticker { ["ticker"] } else { [] }) | append (if $has_blobs { ["rclone-s3" "imgproxy"] } else { [] }) | append $plan0.sidecars)
	let pushed = if $snapshot { {} } else {
		ensure-infrastructure $plan0
		if $from != null { copy-images $plan0 $name $images $from } else { push-images $app_info.dir $plan0 $name $images }
	}

	# The providers compose gives the auth service, under what release.cue sets.
	let compose = (do { cd $app_info.dir; ^docker compose --profile "*" config --format json } | from json)
	let auth_env = $compose.services.auth.environment
	let fixed = (^cue export --expression GCP.auth.oidc --out json $app_info.cue_path | from json | columns)
	let oidc = ($auth_env | transpose key value | where {|e| ($e.key starts-with "OIDC_") and ($e.key not-in $fixed) and not ($e.key ends-with "_CLIENT_SECRET") }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let auth_own = ($auth_env | transpose key value | where {|e| $e.key starts-with "AUTH_" } | reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let number = (gc projects describe $plan0.project --format "value(projectNumber)" | str trim)
	let data_file = (mktemp -t gcp.XXXXXX.json | str trim)
	let migrate = if $has_migrate { {migrate: {env: ($compose.services.migrate.environment? | default {} | reject -o DATABASE_URL)}} } else { {} }
	let ticker = if $has_ticker { {ticker: {env: ($compose.services.ticker.environment? | default {} | reject -o CRUD_URL SERVICE_JWT PORT)}} } else { {} }
	let blobs = if $has_blobs { {blobs: {}} } else { {} }
	# Each sidecar's compose environment, its peers at their loopback ports.
	let sidecars = ($plan0.sidecars | reduce -f {} {|n, acc|
		let compose_env = ($compose.services | get $n | get environment? | default {} | transpose key value
			| reduce -f {} {|e, all| $all | insert $e.key ($plan0.loopback | transpose peer at | reduce -f ($e.value | into string) {|l, v| $v | str replace -a $l.peer $l.at }) })
		$acc | insert $n {env: $compose_env}
	})
	let sidecar_env = if ($sidecars | is-empty) { {} } else { {sidecars: $sidecars} }
	{GCP: ({image: {pushed: $pushed}, auth: {oidc: $oidc, env: $auth_own, programProviders: ($auth_env.OIDC_PROVIDERS? | default "")}, runHost: $"($plan0.service)-($number).($plan0.region).run.app"} | merge $migrate | merge $ticker | merge $blobs | merge $sidecar_env | merge ($base.GCP? | default {}))} | to json | save -f $data_file
	let plan = (render $app_info.cue_path $data_file)
	rm $data_file
	mkdir dist/gcp
	$plan.jobYaml | save -f dist/gcp/job.yaml
	$plan.serviceYaml | save -f dist/gcp/service.yaml
	if $has_migrate { $plan.migrateJobYaml | save -f dist/gcp/migrate.yaml }
	if $snapshot { print "gcp: rendered dist/gcp/job.yaml and dist/gcp/service.yaml; nothing applied"; return {} }

	let p = $plan.project
	let r = $plan.region
	for key in $plan.oidcSecretKeys {
		if not (exists secrets describe $key --project $p) {
			error make {msg: $"secret ($key) is missing: create it with `gcloud secrets create ($key) --project ($p) --data-file=-`"}
		}
	}
	if $has_blobs { ensure-bucket $plan.names.bucket $plan.names.serviceAccount $p $r }
	# What the Managed Prometheus sidecar scrapes, which it reads as a mounted secret.
	if ($plan.scrapeConfig | is-not-empty) { ensure-secret $plan.names.scrapeConfig $p $plan.scrapeConfig | ignore }
	run-job dist/gcp/job.yaml $plan.names.job "building the schema" $p $r
	if $has_migrate { run-job dist/gcp/migrate.yaml $plan.names.migrateJob "carrying the schema forward" $p $r }
	gc run services replace dist/gcp/service.yaml --region $r --project $p | ignore
	gc run services add-iam-policy-binding $plan.service --region $r --project $p --member allUsers --role roles/run.invoker | ignore
	if ($plan.clock? | is-not-empty) { ensure-clock $plan.clock (gc secrets versions access latest --secret $plan.names.secrets.SERVICE_JWT --project $p) $p $r }

	let address = $"https://($plan.service)-($number).($r).run.app"
	for d in ([$plan.domain?] | compact | append $plan.aliases) { map-domain $d $plan.service $p $r }
	# Live means the address answers, not that gcloud returned, which waits for
	# the revision to be ready: half a minute at most, not curl's backoff,
	# whose eighth retry comes four minutes in.
	let health = (^curl --silent --output /dev/null --write-out "%{http_code}" --connect-timeout 5 --retry 10 --retry-delay 3 --retry-max-time 30 --retry-all-errors $"($address)/health")
	if $health != "200" { error make {msg: $"($address)/health answered ($health)"} }
	print $"gcp: ($plan.service) is live at ($address)"
	$pushed
}

export def main [
	--snapshot      # Build and render only, change nothing in the project
	--dry-run       # Print what would be applied and exit
	--app: string   # Application name or path
	--preview: string # A pull request's own copy beside the release, such as pr-32
	--delete        # Remove the preview, when its pull request closes
	--no-gate       # Release without testing a preview of it first
] {
	let app_info = (resolve-app $app)
	# sayt hands a release's own flags over as SAY_RELEASE_ARGS_<FLAG>, and only
	# so where the rule has more than one command: each is read from there too,
	# as a dry run that missed it would release.
	let given = {|flag| ($env | get -o $"SAY_RELEASE_ARGS_($flag)" | default "") not-in ["" "false"] }
	let preview = ($preview | default ($env.SAY_RELEASE_ARGS_PREVIEW? | default ""))
	let delete = ($delete or (do $given DELETE))
	let dry_run = ($dry_run or (do $given DRY_RUN))
	let snapshot = ($snapshot or (do $given SNAPSHOT))
	let no_gate = ($no_gate or (do $given NO_GATE))
	if $delete {
		if ($preview | is-empty) { error make {msg: "--delete removes a preview: name it with --preview; a release is never deleted here"} }
		delete-preview (plan-of $app_info.cue_path $preview)
		return
	}
	# A release goes behind its integration tests, run against a preview of
	# what it deploys (verify.nu), rather than a stack on the machine releasing:
	# the preview, then the tests, then the release of the very images tested,
	# and the preview stopped whatever happened. A preview, a dry run or a
	# snapshot deploys as asked.
	if ($preview | is-not-empty) or $dry_run or $snapshot or $no_gate {
		deploy $app_info $preview $dry_run $snapshot | ignore
		return
	}
	# The gate's preview is `rc`, whose Cloud SQL instance outlives it: making
	# one is most of ten minutes. Each release starts it on an empty database,
	# so one release at a time; `--preview rc --delete` removes it all.
	let rc = "rc"
	let rc_plan = (plan-of $app_info.cue_path $rc)
	print $"gcp: testing a preview \(($rc)\) before the release"
	let failure = (try {
		empty-preview $rc_plan
		let tested = (deploy $app_info $rc false false)
		run-drivers $app_info.dir $rc_plan
		deploy $app_info "" false false {registry: $rc_plan.registry, pushed: $tested} | ignore
		null
	} catch {|e| $e.msg })
	stop-preview $rc_plan
	if $failure != null { error make {msg: $failure} }
}
