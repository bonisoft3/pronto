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
const unbuilt = ["migrate" "mesh-events" "conduit" "transform" "ticker" "clock" "airlock" "compute" "rclone-s3" "imgproxy" "render"]

def --wrapped gc [...args] {
	let input = $in
	let r = ($input | ^gcloud ...$args | complete)
	if $r.exit_code != 0 { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
	$r.stdout
}
def --wrapped exists [...args]: nothing -> bool { (^gcloud ...$args | complete).exit_code == 0 }

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
	gc services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com iam.googleapis.com --project $p | ignore
	if not (exists artifacts repositories describe $plan.repository --location $plan.region --project $p) {
		gc artifacts repositories create $plan.repository --repository-format docker --location $plan.region --project $p --description "pronto images" | ignore
	}
	let sa = ($n.serviceAccount | split row "@" | first)
	if not (exists iam service-accounts describe $n.serviceAccount --project $p) {
		gc iam service-accounts create $sa --project $p --display-name $"($plan.service) on Cloud Run" | ignore
	}
	for role in ["roles/cloudsql.client" "roles/secretmanager.secretAccessor"] {
		gc projects add-iam-policy-binding $p --member $"serviceAccount:($n.serviceAccount)" --role $role --condition None --quiet | ignore
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

	if not (exists sql instances describe $n.instance --project $p) {
		print $"gcp: creating Cloud SQL ($n.instance) \(several minutes\)"
		gc sql instances create $n.instance --project $p --region $plan.region --database-version POSTGRES_18 --edition enterprise --tier $plan.sqlTier --storage-size 10 --storage-type HDD --database-flags cloudsql.logical_decoding=on --root-password $pg | ignore
	}
	# The password the URLs carry is the user's, whichever came first.
	gc sql users set-password postgres --instance $n.instance --project $p --password $pg | ignore
	if not (exists sql databases describe $n.database --instance $n.instance --project $p) {
		gc sql databases create $n.database --instance $n.instance --project $p | ignore
	}
	if not (exists storage buckets describe $"gs://($n.bucket)" --project $p) {
		gc storage buckets create $"gs://($n.bucket)" --project $p --location $plan.region --uniform-bucket-level-access | ignore
	}
	gc storage buckets add-iam-policy-binding $"gs://($n.bucket)" --member $"serviceAccount:($n.serviceAccount)" --role roles/storage.objectAdmin | ignore
}

# The runtime images, built as the app's compose project builds them and pushed
# by digest: what integrate tested is what releases.
def push-images [app_dir: string, plan: record, name: string]: nothing -> record {
	let host = ($plan.registry | split row "/" | first)
	# A short-lived token, not a credential helper written into Docker's config.
	gc auth print-access-token | ^docker login --username oauth2accesstoken --password-stdin $"https://($host)"
	let root = (do { cd $app_dir; ^git rev-parse --show-toplevel } | str trim)
	do {
		cd $app_dir
		# Reproducible, so an unchanged source pushes the digest it pushed before.
		with-env {SOURCE_DATE_EPOCH: "0"} {
			^docker compose --profile "*" config | ^docker buildx bake -f - --load --provenance=false $"--allow=fs.read=($root)" --set "*.platform=linux/amd64" ...$runtime
		}
	}
	let targets = (do { cd $app_dir; ^docker compose --profile "*" config | ^docker buildx bake -f - --print ...$runtime } | from json | get target)
	$runtime | each {|svc|
		let local = ($targets | get $svc | get tags | where {|t| $t ends-with ":latest" } | first)
		let repo = $"($plan.registry)/($name)-($svc)"
		^docker tag $local $"($repo):release"
		^docker push --quiet $"($repo):release" | ignore
		let digest = (^docker image inspect --format '{{json .RepoDigests}}' $"($repo):release" | from json | where {|d| $d starts-with $"($repo)@" } | first | split row "@" | last)
		{svc: $svc, ref: {tag: "release", digest: $digest}}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
}

export def main [
	--snapshot      # Build and render only, change nothing in the project
	--dry-run       # Print what would be applied and exit
	--app: string   # Application name or path
] {
	let app_info = (resolve-app $app)
	let plan0 = (render $app_info.cue_path)
	let services = (do { cd $app_info.dir; ^docker compose --profile "*" config --services } | lines)
	let refused = ($services | where {|s| $s in $unbuilt })
	if ($refused | is-not-empty) {
		error make {msg: $"release@gcp does not run ($refused | str join ', ') yet \(PENDING.md#release-targets\)"}
	}
	if $dry_run { print $plan0.jobYaml; print "---"; print $plan0.serviceYaml; return }

	let name = (^cue export --expression GCP.name --out text $app_info.cue_path | str trim)
	let pushed = if $snapshot { {} } else { ensure-infrastructure $plan0; push-images $app_info.dir $plan0 $name }

	# The providers compose gives the auth service, under what release.cue sets.
	let auth_env = (do { cd $app_info.dir; ^docker compose --profile "*" config --format json } | from json | get services.auth.environment)
	let fixed = (^cue export --expression GCP.auth.oidc --out json $app_info.cue_path | from json | columns)
	let oidc = ($auth_env | transpose key value | where {|e| ($e.key starts-with "OIDC_") and ($e.key not-in $fixed) and not ($e.key ends-with "_CLIENT_SECRET") }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let number = (gc projects describe $plan0.project --format "value(projectNumber)" | str trim)
	let data_file = (mktemp -t gcp.XXXXXX.json | str trim)
	{GCP: {image: {pushed: $pushed}, auth: {oidc: $oidc}, runHost: $"($plan0.service)-($number).($plan0.region).run.app"}} | to json | save -f $data_file
	let plan = (render $app_info.cue_path $data_file)
	rm $data_file
	mkdir dist/gcp
	$plan.jobYaml | save -f dist/gcp/job.yaml
	$plan.serviceYaml | save -f dist/gcp/service.yaml
	if $snapshot { print "gcp: rendered dist/gcp/job.yaml and dist/gcp/service.yaml; nothing applied"; return }

	let p = $plan.project
	let r = $plan.region
	for key in $plan.oidcSecretKeys {
		if not (exists secrets describe $key --project $p) {
			error make {msg: $"secret ($key) is missing: create it with `gcloud secrets create ($key) --project ($p) --data-file=-`"}
		}
	}
	gc run jobs replace dist/gcp/job.yaml --region $r --project $p | ignore
	print $"gcp: building the schema \(($plan.names.job)\)"
	let run = (^gcloud run jobs execute $plan.names.job --region $r --project $p --wait | complete)
	if $run.exit_code != 0 {
		error make {msg: $"($plan.names.job) failed: ($run.stderr | str trim)\nlogs: gcloud logging read 'resource.labels.job_name=($plan.names.job)' --project ($p) --limit 40"}
	}
	gc run services replace dist/gcp/service.yaml --region $r --project $p | ignore
	gc run services add-iam-policy-binding $plan.service --region $r --project $p --member allUsers --role roles/run.invoker | ignore

	let address = $"https://($plan.service)-($number).($r).run.app"
	if ($plan.domain? | is-not-empty) {
		if not (exists beta run domain-mappings describe --domain $plan.domain --region $r --project $p) {
			let made = (^gcloud beta run domain-mappings create --service $plan.service --domain $plan.domain --region $r --project $p | complete)
			if $made.exit_code != 0 { print $"gcp: ($plan.domain) is not mapped yet: ($made.stderr | str trim)" }
		}
		print (gc beta run domain-mappings describe --domain $plan.domain --region $r --project $p --format "table(status.resourceRecords[].type,status.resourceRecords[].name,status.resourceRecords[].rrdata)")
	}
	# Live means the address answers, not that gcloud returned.
	let health = (^curl --silent --output /dev/null --write-out "%{http_code}" --retry 8 --retry-all-errors $"($address)/health")
	if $health != "200" { error make {msg: $"($address)/health answered ($health)"} }
	print $"gcp: ($plan.service) is live at ($address)"
}
