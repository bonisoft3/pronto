# release.nu: release@gcp, an app on Cloud Run beside Cloud SQL, with gcloud
# alone (docs/release-targets.md#gcp).
#
# The app's release.cue defines `GCP: schema.#Release & {...}` and
# `gcpRelease: schema.#Build & {release: GCP}` (gcp/schema). Each resource is
# described before it is made, so a release runs again unchanged: the same
# images push the same digests and roll nothing, and initdb finds its marker.

use ../k8s/release.nu [resolve-app]
use verify.nu [start-drivers go-drivers finish-drivers drivers-log cancel-drivers plan-of]
use build.nu [builder stamp gc exists build-account push-images service-jwt]
use local-gate-key.nu

# The services this target runs; anything else in the app's compose project
# needs what it does not build yet (PENDING.md#release-targets).
const runtime = ["database" "crud" "electric" "auth" "caddy"]
# compose's clock is not one of them: Cloud Scheduler is the ticker's clock here.
const unbuilt = ["mesh-events" "conduit" "transform" "airlock" "compute" "render"]

def render [cue_path: string, data?: string]: nothing -> record {
	let inputs = [$cue_path] | append (if ($data | is-not-empty) { [$data] } else { [] })
	let res = (do { ^cue export --expression gcpRelease.plan --out json ...$inputs } | complete)
	if $res.exit_code != 0 { error make {msg: $"($cue_path): ($res.stderr)"} }
	$res.stdout | from json
}

# The plan rendered over what the release knows so far (data), such as the
# service's address.
def plan-with [cue_path: string, data: record]: nothing -> record {
	let f = (mktemp -t gcp.XXXXXX.json | str trim)
	$data | to json | save -f $f
	let plan = (render $cue_path $f)
	rm $f
	$plan
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

# A gcloud call granting a role to an account made a moment before: IAM does not know a new account
# for some seconds ("does not exist"), so the call is asked again, a minute at most, a second apart, before it fails;
# any other refusal fails at once.
def --wrapped gc-fresh [...args] {
	let input = $in
	let until = ((date now) + 1min)
	loop {
		let r = ($input | ^gcloud --quiet ...$args | complete)
		if $r.exit_code == 0 { return $r.stdout }
		if not ($r.stderr =~ "does not exist") or (date now) > $until { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
		sleep 1sec
	}
}

# The app's account reads each secret its containers name (the plan's readSecrets), granted on
# that secret alone, never on the project. A preview's release may grant no role in its project,
# so where its account is refused it says which secret, and the owner's grant on the project, as
# before, still holds.
def grant-secrets [plan: record] {
	let member = $"serviceAccount:($plan.names.serviceAccount)"
	for s in $plan.readSecrets {
		let r = (try { gc-fresh secrets add-iam-policy-binding $s --project $plan.project --member $member --role roles/secretmanager.secretAccessor; {exit_code: 0, stderr: ""} } catch {|e| {exit_code: 1, stderr: $e.msg} })
		if $r.exit_code != 0 {
			if ($plan.preview? | is-not-empty) {
				print $"gcp: (stamp) ($s) not granted to ($member) alone: ($r.stderr | str trim | lines | last)"
			} else {
				error make {msg: $"gcloud secrets add-iam-policy-binding ($s): ($r.stderr | str trim)"}
			}
		}
	}
}

# Whether any sidecar's metrics are scraped, in the cluster's instance or apart.
def scraped [plan: record]: nothing -> bool {
	($plan.scrapeConfig | is-not-empty) or ($plan.sidecarScrapeConfigs? | default {} | is-not-empty)
}

# This script, so a change to how a project is set up sets it up again.
const SELF = path self

# The project as a release leaves it, set up once for what it depends on: the
# plan's project, names, region, repository and database settings, and this
# script. A release since which none changed reads one secret and goes on; the
# setup is some thirty gcloud calls, most of two minutes for each of a
# release's preview and its project, which changed nothing. PRONTO_SETUP=always
# sets it up anyway, after a change made by hand.
def ensure-infrastructure [plan: record] {
	let marker = ($plan.names.job | str replace -r '-initdb$' '-setup')
	let key = ([
		($plan | select -o project region repository preview names sqlTier sqlFlags | to json --raw)
		(scraped $plan | into string)
		(open --raw $SELF)
	] | str join (char nl) | hash sha256 | str substring 0..23)
	if ($env.PRONTO_SETUP? | default "") != "always" {
		let last = (^gcloud --quiet secrets versions access latest --secret $marker --project $plan.project | complete)
		if $last.exit_code == 0 and ($last.stdout | str trim) == $key {
			print $"gcp: (stamp) ($plan.service)'s project is as the last release set it up"
			return
		}
	}
	set-up-project $plan
	ensure-secret $marker $plan.project $key | ignore
}

def set-up-project [plan: record] {
	let p = $plan.project
	let n = $plan.names
	# A preview's release may not enable APIs: the project's first release did.
	if ($plan.preview? | is-empty) {
		gc services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com iam.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com --project $p | ignore
		# Where a sidecar's metrics are scraped to: Managed Service for Prometheus.
		if (scraped $plan) { gc services enable monitoring.googleapis.com --project $p | ignore }
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
		# Its own database alone, by a condition on the instance's name, and (grant-secrets, once
		# they exist) its own secrets alone: an app beside others in one project reaches none of
		# theirs. A role on the whole project an earlier release granted is left to its owner.
		gc-fresh projects add-iam-policy-binding $p --member $"serviceAccount:($n.serviceAccount)" --role roles/cloudsql.client --condition $"expression=resource.name == 'projects/($p)/instances/($n.instance)',title=($n.instance) alone" --quiet | ignore
		if (scraped $plan) {
			gc-fresh projects add-iam-policy-binding $p --member $"serviceAccount:($n.serviceAccount)" --role roles/monitoring.metricWriter --condition None --quiet | ignore
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
		print $"gcp: (stamp) creating Cloud SQL ($n.instance) \(several minutes\)"
		gc sql instances create $n.instance --project $p --region $plan.region --database-version POSTGRES_18 --edition enterprise --tier $plan.sqlTier --storage-size 10 --storage-type HDD --database-flags $plan.sqlFlags --root-password $pg | ignore
	}
	# Flags an earlier release set differently are patched, which restarts it.
	let flags = (gc sql instances describe $n.instance --project $p --format json | from json | get settings.databaseFlags? | default [] | each {|f| $"($f.name)=($f.value)" } | sort | str join ",")
	if $flags != ($plan.sqlFlags | split row "," | sort | str join ",") {
		print $"gcp: (stamp) setting ($plan.sqlFlags) on ($n.instance) \(it restarts\)"
		gc sql instances patch $n.instance --project $p --database-flags $plan.sqlFlags --quiet | ignore
	}
	# The password the URLs carry is the user's, whichever came first.
	gc sql users set-password postgres --instance $n.instance --project $p --password $pg | ignore
	if not (exists sql databases describe $n.database --instance $n.instance --project $p) {
		gc sql databases create $n.database --instance $n.instance --project $p | ignore
	}
}

# What copies a tested preview's images into the release's registry: Google's
# crane, which logs in as the build's account through the worker's metadata.
const copier = "gcr.io/go-containerregistry/gcrane:v0.22.1@sha256:67b9993e083198db3d30ae6d2bb685cc67a45494a3c485ef2fa9994715bee9ff"

# The release's images, copied by digest from the preview its tests ran
# against, so what was tested is, byte for byte, what releases. Cloud Build in
# the release's project copies them, and its account reads the previews'
# repository: a grant its owner makes once (docs/release-targets.md#previews).
# The copy starts while the tests run, as `candidate`; `finish-copy` tags the
# release's only after they passed.
def start-copy [plan: record, name: string, services: list<string>, from: record]: nothing -> record {
	let p = $plan.project
	let refs = ($services | each {|svc|
		let src = ($from.pushed | get -o $svc)
		if $src == null { error make {msg: $"the preview has no ($svc) image to release"} }
		{svc: $svc, src: $"($from.registry)/($name)-($svc)@($src.digest)", digest: $src.digest, repo: $"($plan.registry)/($name)-($svc)"}
	})
	let work = (mktemp -d -t gcp-copy.XXXXXX | str trim)
	{
		steps: ($refs | each {|r| {name: $copier, args: ["cp" $r.src $"($r.repo):candidate"]} })
		options: {logging: "CLOUD_LOGGING_ONLY"}
		timeout: "1200s"
	} | to yaml | save -f $"($work)/cloudbuild.yaml"
	print $"gcp: (stamp) copying the tested ($services | str join ', ') from the preview"
	let build = (gc builds submit --no-source --config $"($work)/cloudbuild.yaml" --project $p --async --format "value(id)" | str trim)
	rm -rf $work
	{build: $build, project: $p, registry: $from.registry, refs: $refs}
}

# The copy to its end: the tested images are in the release's repository, as
# `candidate`, tagged nothing production runs.
def await-copy [copy: record] {
	let p = $copy.project
	mut status = "QUEUED"
	while $status in ["QUEUED" "PENDING" "WORKING"] {
		$status = (gc builds describe $copy.build --project $p --format "value(status)" | str trim)
		if $status in ["QUEUED" "PENDING" "WORKING"] { sleep 1sec }
	}
	if $status != "SUCCESS" {
		let builds = (build-account $p)
		let log = (do { ^gcloud --quiet logging read $"resource.type=\"build\" AND resource.labels.build_id=\"($copy.build)\"" --project $p --order desc --limit 20 --format "value(textPayload)" } | complete | get stdout | lines | reverse | str join (char nl))
		error make {msg: $"the preview's images were not copied \(($status); its repository may not let ($builds) read it: gcloud artifacts repositories add-iam-policy-binding ($copy.registry | split row '/' | last) --project ($copy.registry | split row '/' | get 1) --location ($copy.registry | split row '-docker' | first) --member serviceAccount:($builds) --role roles/artifactregistry.reader\):\n($log)"}
	}
}

# Each copied image tagged the release's, once its digest is the tested one.
def tag-release [copy: record]: nothing -> record {
	print $"gcp: (stamp) tagging the tested images the release's"
	# Each image at once: one after another, its two calls apiece were a minute.
	$copy.refs | par-each --keep-order {|r|
		gc artifacts docker tags add $"($r.repo)@($r.digest)" $"($r.repo):release" | ignore
		let digest = (gc artifacts docker images describe $"($r.repo):release" --format "value(image_summary.digest)" | str trim)
		if $digest != $r.digest { error make {msg: $"($r.repo):release is ($digest), not the tested ($r.digest)"} }
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
			print $"gcp: (stamp) ($domain) is not mapped: ($made.body.error?.message? | default ($made.body | to json))"
			print $"gcp: (stamp) verify it first: gcloud domains verify ($domain)"
			return
		}
		$made.body
	} else if $got.status >= 300 {
		error make {msg: $"($api)/($domain) answered ($got.status): ($got.body | to json)"}
	} else { $got.body }
	let ready = ($mapping.status?.conditions? | default [] | where type == "Ready" | get 0?)
	if ($ready.status? | default "") != "True" {
		print $"gcp: (stamp) ($domain) is mapped but not ready: ($ready.message? | default 'Google is still provisioning it')"
		print $"gcp: (stamp) an unverified domain is verified once by its owner: gcloud domains verify ($domain)"
	}
	let records = ($mapping.status?.resourceRecords? | default [])
	if ($records | is-not-empty) {
		print $"gcp: (stamp) ($domain)'s DNS records:"
		print ($records | select -o type name rrdata | table)
	}
}

# What the schema job applies, as one hash: the job as rendered, which names its image (the
# schema's, or the database's: every migration, policy, seed, publication and hybrid machine
# the initdb directory holds), the commands it runs over them and the roles and secrets it is
# given. Never less than the job, so what differs in any of them differs here.
def job-hash [job_yaml: string]: nothing -> string { $job_yaml | hash sha256 | str substring 0..39 }

# The job hash the live service was released with; null when there is none, the service is not
# ready on its latest revision, or the read fails: then the job runs.
def live-job-hash [plan: record]: nothing -> any {
	try {
		let live = (gc run services describe $plan.service --region $plan.region --project $plan.project --format json | from json)
		if ($live.status?.latestReadyRevisionName? | is-empty) or $live.status.latestReadyRevisionName != $live.status.latestCreatedRevisionName { return null }
		$live.spec?.template?.metadata?.labels?.pronto-job?
	} catch { null }
}

# A job applied and run to its end; its logs are where a failure says why.
def run-job [file: string, name: string, what: string, project: string, region: string] {
	gc run jobs replace $file --region $region --project $project | ignore
	print $"gcp: (stamp) ($what) \(($name)\)"
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
	print $"gcp: (stamp) the ticker's clock \(($clock.name)\) pokes ($clock.uri) each minute"
}

# The blob plane's bucket, in the region, its objects the service account's
# alone: nothing in it is public, since readers reach a picture through the
# door's /img. Made once; the grant is restated on every release.
def ensure-bucket [bucket: string, account: string, project: string, region: string] {
	if not (exists storage buckets describe $"gs://($bucket)" --project $project) {
		gc storage buckets create $"gs://($bucket)" --project $project --location $region --uniform-bucket-level-access --public-access-prevention | ignore
	}
	gc storage buckets add-iam-policy-binding $"gs://($bucket)" --project $project --member $"serviceAccount:($account)" --role roles/storage.objectAdmin | ignore
	print $"gcp: (stamp) pictures are kept in gs://($bucket)"
}

# A preview stopped: what runs against its database (its service, jobs and
# clock), so the database is no one's.
def stop-preview [plan: record] {
	let p = $plan.project
	let r = $plan.region
	let n = $plan.names
	if (exists run services describe $plan.service --region $r --project $p) { gc run services delete $plan.service --region $r --project $p | ignore }
	for svc in ($n.sidecarServices? | default {} | values) {
		if (exists run services describe $svc --region $r --project $p) { gc run services delete $svc --region $r --project $p | ignore }
	}
	for job in [$n.job $n.migrateJob] {
		if (exists run jobs describe $job --region $r --project $p) { gc run jobs delete $job --region $r --project $p | ignore }
	}
	if (exists scheduler jobs describe $n.clock --location $r --project $p) { gc scheduler jobs delete $n.clock --location $r --project $p | ignore }
}

# A preview to deploy afresh on its instance as it stands: stopped, and its
# database dropped and made again empty, for the deploy to build the schema in.
# Dropping it drops the replication slot its electric left there. Making it
# again is here, not left to setup, which a release skips when nothing it sets
# changed: the schema job would find no database at all.
def empty-preview [plan: record] {
	stop-preview $plan
	let n = $plan.names
	# Cloud SQL answers a database on a missing instance with a 403, not a
	# 404: an app's first preview has no instance yet.
	if not (exists sql instances describe $n.instance --project $plan.project) { return }
	if (exists sql databases describe $n.database --instance $n.instance --project $plan.project) {
		print $"gcp: (stamp) emptying the preview ($plan.preview): dropping its database on ($n.instance)"
		gc sql databases delete $n.database --instance $n.instance --project $plan.project | ignore
		gc sql databases create $n.database --instance $n.instance --project $plan.project | ignore
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
	print $"gcp: (stamp) preview ($plan.preview) removed"
}

# What a release or a preview deploys, from the plan release.cue renders for
# it, ending once its address answers; the images it ran, by digest. A
# release given a tested preview's (`from`) runs those, copied, not rebuilt.
# A release staged: everything up to the first code of the release production runs. The
# project, the images (pushed, or the tested ones copied in as `candidate`), the plan
# rendered with their digests and written to dist/gcp, the bucket, the scrape configs and
# the secret grants: declarative, each restated by the next release, none running the app.
# A gated release stages production while its tests run (docs/decisions/2026-10-29-staged-release.md).
# `rendered` is the preview's plan when the caller rendered it already.
def stage [app_info: record, preview: string, dry_run: bool, snapshot: bool, from?: record, --rendered: record]: nothing -> record {
	# The roles the app's schema grants PostgREST's login, as generate wrote them.
	let facts_path = ($app_info.cue_path | path dirname | path join .pronto cluster.json)
	if not ($facts_path | path exists) { error make {msg: $"($facts_path) is missing: generate the app before releasing it"} }
	let facts = (open $facts_path)
	if not $facts.server { error make {msg: $"($facts_path): this app has no server tier to release to GCP"} }
	let base = {GCP: ({database: {tokenRoles: $facts.tokenRoles, replays: ($facts.replays? | default [])}} | merge (if ($preview | is-empty) { {} } else { {preview: $preview} }))}
	let plan0 = if $rendered == null { plan-of $app_info.cue_path $preview } else { $rendered }
	let compose = (do { cd $app_info.dir; ^docker compose --profile "*" config --format json } | from json)
	let services = ($compose.services | columns)
	let refused = ($services | where {|s| $s in $unbuilt })
	if ($refused | is-not-empty) {
		error make {msg: $"release@gcp does not run ($refused | str join ', ') yet \(PENDING.md#release-targets\)"}
	}
	if $dry_run {
		print $plan0.jobYaml; print "---"; print $plan0.serviceYaml
		for y in ($plan0.sidecarServicesYaml | values) { print "---"; print $y }
		return {done: true}
	}

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
	let images = ($runtime | append (if $has_migrate { ["migrate" "schema"] } else { [] }) | append (if $has_ticker { ["ticker"] } else { [] }) | append (if $has_blobs { ["rclone-s3" "imgproxy"] } else { [] }) | append $plan0.sidecars)
	if not $snapshot {
		print $"gcp: (stamp) setting up ($plan0.service)'s project"
		ensure-infrastructure $plan0
	}
	# The tested images, copied in as `candidate`: the copy the gate started while it tested,
	# when it copied these images, else one started now. Tagged the release's in go-live.
	let copy = if $from == null or $snapshot { null } else {
		let started = ($from.copy? | default null)
		let c = if $started != null and (($started.refs | get svc | sort) == ($images | sort)) { $started } else { start-copy $plan0 $name $images $from }
		await-copy $c
		$c
	}
	let pushed = if $snapshot { {} } else if $copy == null { push-images $app_info.dir $plan0 $name $images } else {
		# The plan names an image by its digest, the tested one; the tag is only its name.
		$copy.refs | reduce -f {} {|r, acc| $acc | insert $r.svc {tag: "release", digest: $r.digest} }
	}

	# The providers compose gives the auth service, under what release.cue sets.
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
	# Each sidecar's compose environment, its peers where it finds them: at their
	# loopback ports in the cluster's instance, through the door and at the
	# others' addresses for one apart, which the service's address names. A key
	# release.cue sets is the release's, over compose's, as auth.oidc's are.
	let run_host = $"($plan0.service)-($number).($plan0.region).run.app"
	let peers = (plan-with $app_info.cue_path ({GCP: {runHost: $run_host}} | merge deep $base)).peers
	let own = (^cue export --expression '{for n, c in GCP.sidecars {(n): [for k, _ in c.env {k}]}}' --out json $app_info.cue_path | from json)
	let sidecars = ($plan0.sidecars | reduce -f {} {|n, acc|
		let set = ($own | get -o $n | default [])
		let compose_env = ($compose.services | get $n | get environment? | default {} | transpose key value | where {|e| $e.key not-in $set }
			| reduce -f {} {|e, all| $all | insert $e.key ($peers | get $n | transpose peer at | reduce -f ($e.value | into string) {|l, v| $v | str replace -a $l.peer $l.at }) })
		$acc | insert $n {env: $compose_env}
	})
	let sidecar_env = if ($sidecars | is-empty) { {} } else { {sidecars: $sidecars} }
	{GCP: ({image: {pushed: $pushed}, auth: {oidc: $oidc, env: $auth_own, programProviders: ($auth_env.OIDC_PROVIDERS? | default "")}, runHost: $run_host} | merge $migrate | merge $ticker | merge $blobs | merge $sidecar_env | merge ($base.GCP? | default {}))} | to json | save -f $data_file
	let plan = (render $app_info.cue_path $data_file)
	rm $data_file
	mkdir dist/gcp
	$plan.jobYaml | save -f dist/gcp/job.yaml
	# The service carries the hash of the job it was released with (job-hash), which the next
	# release reads off the live revision to skip a schema job that would change nothing.
	let service = ($plan.serviceYaml | from yaml)
	$service | upsert spec.template.metadata.labels ($service.spec.template.metadata.labels? | default {} | insert pronto-job (job-hash $plan.jobYaml)) | to yaml | save -f dist/gcp/service.yaml
	for s in ($plan.sidecarServicesYaml | transpose name yaml) { $s.yaml | save -f $"dist/gcp/sidecar-($s.name).yaml" }
	if $snapshot { print $"gcp: (stamp) rendered dist/gcp/job.yaml and dist/gcp/service.yaml; nothing applied"; return {done: true} }

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
	for c in ($plan.sidecarScrapeConfigs | transpose secret config) { ensure-secret $c.secret $p $c.config | ignore }
	grant-secrets $plan
	print $"gcp: (stamp) ($plan.service) staged"
	{plan: $plan, pushed: $pushed, has_migrate: $has_migrate, copy: $copy, gated: ($from != null), number: $number}
}

# A staged release made live: its images tagged the release's (a gated one's, now that its
# tests passed), the schema job run, the service and its sidecars replaced, the clock, the
# domains, and the address answering. The first code of the release production runs.
def go-live [staged: record]: nothing -> record {
	let plan = $staged.plan
	let p = $plan.project
	let r = $plan.region
	let has_migrate = $staged.has_migrate
	let number = $staged.number
	let pushed = if $staged.gated and $staged.copy != null { tag-release $staged.copy } else { $staged.pushed }
	# A release's own service only: a preview's database is emptied for each, whatever its label says.
	# PRONTO_RELEASE_FORCE_SCHEMA=1 runs the job all the same (a rotated role password, say).
	let wanted = (job-hash (open --raw dist/gcp/job.yaml))
	if ($plan.preview? | is-empty) and ($env.PRONTO_RELEASE_FORCE_SCHEMA? | is-empty) and (live-job-hash $plan) == $wanted {
		print $"gcp: (stamp) the schema job skipped: ($plan.service) is live with the schema it applies \(PRONTO_RELEASE_FORCE_SCHEMA=1 runs it\)"
	} else {
		run-job dist/gcp/job.yaml $plan.names.job (if $has_migrate { "building the schema and carrying it forward" } else { "building the schema" }) $p $r
	}
	# The service replaced beside the retired migrate job's removal (an earlier release ran it apart, this one's job does).
	let failed = (["service" "migrate"] | par-each {|t|
		try {
			if $t == "service" {
				print $"gcp: (stamp) deploying ($plan.service)"
				gc run services replace dist/gcp/service.yaml --region $r --project $p | ignore
			} else if (exists run jobs describe $plan.names.migrateJob --region $r --project $p) {
				gc run jobs delete $plan.names.migrateJob --region $r --project $p | ignore
			}
			null
		} catch {|e| $e.msg }
	} | compact)
	if ($failed | is-not-empty) { error make {msg: ($failed | str join "\n") } }
	# What follows the door being up is independent: its invoker grant, each sidecar, the
	# ticker's clock and the domains, all at once. Each sidecar apart, once the door it reaches
	# the gateway through is up; public as the door is, which dials it. They and the ticker's
	# clock are each other's strangers, so they are made together.
	let sidecars = ($plan.sidecarServicesYaml | columns | each {|s| {sidecar: $s} })
	let clock = if ($plan.clock? | is-not-empty) { [{clock: $plan.clock}] } else { [] }
	let domains = ([$plan.domain?] | compact | append $plan.aliases | each {|d| {domain: $d} })
	# Each runs to its end, whatever the others answer; the release fails after, with every error.
	let failed = ([{door: true}] | append $sidecars | append $clock | append $domains | par-each {|t|
		try {
			if ($t.door? | default false) {
				if ($plan.iap? | default false) {
					# Behind Identity-Aware Proxy only IAP's own agent invokes the service, and
					# only the people the owner admits reach it: nobody else at all.
					gc services enable iap.googleapis.com --project $p | ignore
					# IAP's service agent, made once a project (gcloud has it only in beta).
					let token = (gc auth print-access-token | str trim)
					^curl --silent --fail --show-error --output /dev/null -X POST -H $"Authorization: Bearer ($token)" $"https://serviceusage.googleapis.com/v1beta1/projects/($number)/services/iap.googleapis.com:generateServiceIdentity"
					gc run services add-iam-policy-binding $plan.service --region $r --project $p --member $"serviceAccount:service-($number)@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker | ignore
					do { ^gcloud --quiet run services remove-iam-policy-binding $plan.service --region $r --project $p --member allUsers --role roles/run.invoker } | complete | ignore
				} else {
					gc run services add-iam-policy-binding $plan.service --region $r --project $p --member allUsers --role roles/run.invoker | ignore
				}
			} else if ($t.domain? | is-not-empty) {
				map-domain $t.domain $plan.service $p $r
			} else if ($t.clock? | is-not-empty) {
				ensure-clock $t.clock (gc secrets versions access latest --secret $plan.names.secrets.SERVICE_JWT --project $p) $p $r
			} else {
				let svc = ($plan.names.sidecarServices | get $t.sidecar)
				print $"gcp: (stamp) ($t.sidecar) apart \(($svc)\)"
				gc run services replace $"dist/gcp/sidecar-($t.sidecar).yaml" --region $r --project $p | ignore
				gc run services add-iam-policy-binding $svc --region $r --project $p --member allUsers --role roles/run.invoker | ignore
			}
			null
		} catch {|e| $e.msg }
	} | compact)
	if ($failed | is-not-empty) { error make {msg: ($failed | str join "\n") } }

	let address = $"https://($plan.service)-($number).($r).run.app"
	# Live means the address answers, not that gcloud returned, which waits for
	# the revision to be ready: half a minute at most, not curl's backoff,
	# whose eighth retry comes four minutes in.
	let health = (^curl --silent --output /dev/null --write-out "%{http_code}" --connect-timeout 5 --retry 30 --retry-delay 1 --retry-max-time 30 --retry-all-errors $"($address)/health")
	# Behind IAP the address answers with its sign-in, a redirect, to a stranger such as this.
	let ok = if ($plan.iap? | default false) { ["200", "302"] } else { ["200"] }
	if $health not-in $ok { error make {msg: $"($address)/health answered ($health)"} }
	print $"gcp: (stamp) ($plan.service) is live at ($address)"
	$pushed
}

# A release from start to end, staged and made live at once: a preview's, a dry run, a
# snapshot, `--no-gate`'s.
def deploy [app_info: record, preview: string, dry_run: bool, snapshot: bool, from?: record, --rendered: record]: nothing -> record {
	let staged = if $rendered == null { stage $app_info $preview $dry_run $snapshot $from } else { stage $app_info $preview $dry_run $snapshot $from --rendered $rendered }
	if ($staged.done? | default false) { return {} }
	go-live $staged
}

# The release's copy of a tested preview's images, started before its tests
# end, where the release's repository is there already; null where it is not,
# for the release to copy them once it made it.
def start-early-copy [cue_path: string, plan: record, from: record]: nothing -> any {
	if not (exists artifacts repositories describe $plan.repository --location $plan.region --project $plan.project) { return null }
	let name = (^cue export --expression GCP.name --out text $cue_path | str trim)
	start-copy $plan $name ($from.pushed | columns) $from
}

# A service's traffic back to the revision before the one serving it, by Cloud Run's
# revisions, newest first. The service's own goes back only where that revision was released
# with the same schema (its pronto-schema label): past a migration it would read a schema that
# is gone, and going back there is a release of the older commit, which its gate tests.
def back-one [service: string, project: string, region: string, --schema] {
	let revisions = (gc run revisions list --service $service --region $region --project $project --format json | from json
		| sort-by {|v| $v.metadata.creationTimestamp } --reverse)
	let serving = (gc run services describe $service --region $region --project $project --format json | from json
		| get status.traffic | where {|t| ($t.percent? | default 0) == 100 } | first | get revisionName)
	let at = ($revisions | enumerate | where {|e| $e.item.metadata.name == $serving } | first | get index)
	let before = ($revisions | skip ($at + 1) | where {|v| $v.status.conditions | any {|c| $c.type == "Ready" and $c.status == "True" } } | first)
	if $before == null { error make {msg: $"($service) has no revision before ($serving) to go back to"} }
	if $schema {
		let now = ($revisions | get $at | get -o metadata.labels.pronto-schema)
		let then = ($before | get -o metadata.labels.pronto-schema)
		if $now == null or $now != $then {
			error make {msg: $"($before.metadata.name) was released with another schema than ($serving) \(($then | default 'none') / ($now | default 'none')\): going back past a migration is a release of that older commit"}
		}
	}
	gc run services update-traffic $service --to-revisions $"($before.metadata.name)=100" --region $region --project $project | ignore
	print $"gcp: (stamp) ($service) serves ($before.metadata.name) again, not ($serving)"
}

# The release's service and its sidecars apart, each back one revision.
def roll-back [plan: record] {
	back-one $plan.service $plan.project $plan.region --schema
	for svc in ($plan.names.sidecarServices? | default {} | values) { back-one $svc $plan.project $plan.region }
}

# The release's local pre-gate: the drivers its rc gate runs, run first against
# the app as host processes (`sayt integrate@local` with INTEGRATE_LOCAL_DRIVERS=all,
# local-drivers.ts), so a failing scenario stops the release in minutes, before
# production is touched. The rc gate still runs after it: a preview finds what only the
# cloud has. A tree that passed it on this machine already (gcp/local-gate-key.nu's ledger,
# stamped by integrate@local itself) skips it. Its output is prefixed, as it runs beside
# the preview's deploy.
def local-gate [app_dir: string] {
	let say = ($app_dir | path join .say.yaml)
	let rules = (open $say | get -o say.integrate.rulemap | default {} | values | compact)
	if not ($rules | any {|r| ($r.platform? | default "") == "local" }) {
		error make {msg: $"($say) has no integrate@local, which the release's local pre-gate runs: add one, or release with --no-local-gate"}
	}
	let key = (local-gate-key key $app_dir)
	if $key != null and (local-gate-key passed $app_dir $key) {
		print $"gcp: (stamp) the local pre-gate skipped: this tree passed it on this machine already \(~/.cache/pronto/local-gate\)"
		return
	}
	print $"gcp: (stamp) the rc gate's drivers on a local stack first \(integrate@local; --no-local-gate skips it\)"
	# The verdict is the exit the shell prints as the stream's last line, not what the pipe
	# raises: a gate with no `gate-exit 0` line failed, whatever else happened.
	let out = (try {
		^sh -c '( cd "$1" && INTEGRATE_LOCAL_DRIVERS=all ./saytw integrate@local ); echo "@@gate-exit $?"' sh $app_dir o+e>| lines | each {|l| if not ($l starts-with "@@gate-exit ") { print $"local-gate| ($l)" }; $l }
	} catch {|e| [$"@@gate-exit pipe: ($e.msg)"] })
	let verdict = ($out | where {|l| $l starts-with "@@gate-exit " } | last 1 | get -o 0 | default "@@gate-exit none")
	if $verdict != "@@gate-exit 0" {
		error make {msg: $"the local pre-gate failed \(($verdict | str replace '@@gate-exit ' 'exit ')\): nothing reached production"}
	}
	# Stamped only for a tree whose key was read, and is the same after the run.
	if $key == null {
		print $"gcp: (stamp) the local pre-gate passed; the tree's key cannot be read, so the pass is not recorded"
	} else if (local-gate-key key $app_dir) != $key {
		print $"gcp: (stamp) the local pre-gate passed; the tree changed during the run, so the pass is not recorded"
	} else {
		local-gate-key stamp $app_dir $key
		print $"gcp: (stamp) the local pre-gate passed"
	}
}

export def main [
	--snapshot      # Build and render only, change nothing in the project
	--dry-run       # Print what would be applied and exit
	--app: string   # Application name or path
	--preview: string # A pull request's own copy beside the release, such as pr-32
	--delete        # Remove the preview, when its pull request closes
	--no-gate       # Release without testing a preview of it first
	--rollback      # Send the release's traffic back to the revision before, where the schema is the same
	--no-local-gate # Skip the local pre-gate (also PRONTO_RELEASE_NO_LOCAL_GATE=1); the rc gate still runs
	--rc            # Run the rc preview gate even where the local gate passed and nothing deploy-shaped changed
] {
	$env.GCP_T0 = (date now)
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
	let rollback = ($rollback or (do $given ROLLBACK))
	let force_rc = ($rc or (do $given RC))
	let no_local_gate = ($no_local_gate or (do $given NO_LOCAL_GATE) or (($env.PRONTO_RELEASE_NO_LOCAL_GATE? | default "") not-in ["" "0" "false"]))
	if $rollback { roll-back (plan-of $app_info.cue_path ""); return }
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
	let local = ($preview | is-empty) and not $dry_run and not $snapshot and not $no_local_gate
	if ($preview | is-not-empty) or $dry_run or $snapshot or $no_gate {
		# Nothing runs beside it here: the gate first.
		if $local { local-gate $app_info.dir }
		deploy $app_info $preview $dry_run $snapshot | ignore
		return
	}
	# The gate's preview is `rc`, whose Cloud SQL instance outlives it: making
	# one is most of ten minutes. Each release starts it on an empty database,
	# so one release at a time; `--preview rc --delete` removes it all.
	let rc = "rc"
	# The rc gate is skipped where the local gate passes, and nothing a deploy is shaped by
	# changed since a release passed rc (docs/decisions/2026-11-01-local-gate-replaces-rc.md).
	let deploy_key = (local-gate-key deploy-key $app_info.dir)
	let rc_why = if $force_rc { "--rc" } else if $no_local_gate { "--no-local-gate: no local pass stands in for it" } else if $deploy_key == null { "the deploy-shaped files cannot be read" } else if not (local-gate-key rc-passed $app_info.dir $deploy_key) { "the deploy-shaped files (release.cue, compose, infra, program.cue, mise) changed since a release passed it" } else { "" }
	if ($rc_why | is-empty) {
		print $"gcp: (stamp) no rc preview: the deploy-shaped files are those of a release that passed it, so the local gate stands in for it \(--rc runs it\)"
		local-gate $app_info.dir
		deploy $app_info "" false false | ignore
		return
	}
	print $"gcp: (stamp) the rc preview runs: ($rc_why)"
	# The preview's plan and production's, rendered together; the staging below reuses them.
	let plans = (["rc" ""] | par-each --keep-order {|v| plan-of $app_info.cue_path (if $v == "rc" { $rc } else { "" }) })
	let rc_plan = ($plans | first)
	let prod_plan = ($plans | last)
	print $"gcp: (stamp) testing a preview \(($rc)\) before the release"
	#
	# Nothing of the release touches production until every gate passed. So the local
	# pre-gate runs beside the preview's emptying, the tests' build and the preview's
	# deploy, none of which reach production, and the tests are told to run (go-drivers)
	# only once it passed. A gate that fails stops the preview's deploy where it is.
	# The jobs report here: `gate` (null for a pass, else why), `drivers` (the tests' build, the
	# moment it started), `tested` (the preview deployed) or `built` (why it did not).
	let dir = $app_info.dir
	let gate_job = if $local { job spawn {
		try { local-gate $dir; {gate: null} | job send 0 } catch {|e| {gate: $e.msg} | job send 0 }
	} }
	let deploy_job = job spawn {
		try {
			empty-preview $rc_plan
			let drivers = (start-drivers $dir $rc_plan)
			{drivers: $drivers} | job send 0
			let tested = (try { deploy $app_info $rc false false --rendered $rc_plan } catch {|e| cancel-drivers $drivers; error make {msg: $e.msg} })
			{tested: $tested} | job send 0
		} catch {|e| {built: $e.msg} | job send 0 }
	}
	#
	# The tests' own images build in Cloud Build while the preview deploys, and
	# run once it is up; while they run, the release's project copies the
	# preview's images, which it tags the release's only once they passed.
	let failure = (try {
		mut gated = not $local
		mut drivers: any = null
		mut tested: any = null
		while not $gated or $tested == null {
			let m = (job recv)
			if ($m.drivers? | is-not-empty) { $drivers = $m.drivers }
			if ($m.tested? | is-not-empty) { $tested = $m.tested }
			if "gate" in $m {
				if $m.gate != null {
					try { job kill $deploy_job }
					# What it sent before it was killed may be queued still: the tests' build is cancelled
					# whenever it was submitted. (An image build the deploy had submitted runs on to its
					# end, nobody waiting for it.)
					loop {
						let q = (try { job recv --timeout 200ms } catch { null })
						if $q == null { break }
						if ($q.drivers? | is-not-empty) { $drivers = $q.drivers }
					}
					if $drivers != null { cancel-drivers $drivers }
					error make {msg: $m.gate}
				}
				$gated = true
			}
			if ($m.built? | is-not-empty) {
				if $gate_job != null { try { job kill $gate_job } }
				error make {msg: $m.built}
			}
		}
		let drivers = $drivers
		let tested = $tested
		go-drivers $drivers
		let from = {registry: $rc_plan.registry, pushed: $tested}
		let copy = (start-early-copy $app_info.cue_path $prod_plan $from)
		# Production staged while the tests run, none of it the app's code, and made live
		# only once they passed (docs/decisions/2026-10-29-staged-release.md).
		let both = (["stage" "tests"] | par-each {|t|
			if $t == "stage" {
				try { {staged: (stage $app_info "" false false ($from | merge {copy: $copy}) --rendered $prod_plan)} } catch {|e| {staging: $e.msg} }
			} else {
				try { finish-drivers $drivers; {} } catch {|e| {tests: $e.msg} }
			}
		} | reduce -f {} {|it, acc| $acc | merge $it })
		if ($both.tests? | is-not-empty) { error make {msg: $both.tests} }
		if ($both.staging? | is-not-empty) { error make {msg: $"the tests passed, but production was not staged: ($both.staging)"} }
		go-live $both.staged | ignore
		# The tests' log, read once the release is live rather than before it.
		print $"gcp: (stamp) what the tests printed:"
		try { drivers-log $drivers } catch {|e| print $"gcp: (stamp) the tests' log was not read: ($e.msg)" }
		# A release the rc gate passed: the deploy-shaped files it passed with.
		local-gate-key rc-stamp $app_info.dir $deploy_key
		null
	} catch {|e| $e.msg })
	stop-preview $rc_plan
	if $failure != null { error make {msg: $failure} }
}
