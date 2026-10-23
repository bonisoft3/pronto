# Releases the identity broker to Cloud Run, the one an operator serves for every
# app that embeds identity.#Signin: identity/serve.sh release --project P --domain D
#
# The broker keeps nothing but BROKER_SECRET, which Secret Manager holds and this
# generates once, and its one-time codes, in memory: so one instance at most. The
# provider's client is the operator's, registered once with the provider for
# https://<domain>/callback/<provider>; its secret is stored by the operator under
# <service>-google-client-secret, never passed through here.

const here = path self .
const deno = "denoland/deno:distroless-2.5.0@sha256:5c4530d4babe37ded3566803e9498e2b5d643b915cce701d8b7b82f87a86629e"

def --wrapped gc [...args] {
	let input = $in
	let r = ($input | ^gcloud --quiet ...$args | complete)
	if $r.exit_code != 0 { error make {msg: $"gcloud ($args | str join ' '): ($r.stderr | str trim)"} }
	$r.stdout
}
def --wrapped exists [...args]: nothing -> bool {
	(^gcloud --quiet ...$args | complete).exit_code == 0
}

# The domain onto the service, through Cloud Run's domain-mapping API (gcloud
# reaches it only from its beta component); its DNS records, once Google has them.
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
		if $made.status >= 300 { error make {msg: $"($domain) is not mapped: ($made.body.error?.message? | default ($made.body | to json))"} }
		$made.body
	} else if $got.status >= 300 {
		error make {msg: $"($api)/($domain) answered ($got.status): ($got.body | to json)"}
	} else { $got.body }
	let ready = ($mapping.status?.conditions? | default [] | where type == "Ready" | get 0?)
	if ($ready.status? | default "") != "True" {
		print $"identity: ($domain) is mapped but not ready: ($ready.message? | default 'Google is still provisioning it')"
	}
	let records = ($mapping.status?.resourceRecords? | default [])
	if ($records | is-not-empty) { print $"identity: ($domain)'s DNS records:"; print ($records | select -o type name rrdata | table) }
}

export def main [
	--project: string             # The Google Cloud project
	--domain: string              # Where the broker answers, its issuer: id.example.com
	--google-client-id: string    # The operator's Google client, registered for https://<domain>/callback/google
	--region: string = "us-central1"
	--service: string = "identity-broker"
	--repository: string = "pronto"
] {
	if ([$project $domain $google_client_id] | any { is-empty }) { error make {msg: "--project, --domain and --google-client-id are all required"} }
	# Not a pinned tool, as for release@gcp (PENDING.md#release-targets).
	if (which gcloud | is-empty) { error make {msg: "gcloud is not on PATH: the broker's release runs with the Google Cloud CLI installed"} }
	let p = $project
	let issuer = $"https://($domain)"
	let sa = $"($service)-run@($p).iam.gserviceaccount.com"
	let google_secret = $"($service)-google-client-secret"
	gc services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com --project $p | ignore
	if not (exists secrets describe $google_secret --project $p) {
		error make {msg: $"store the Google client secret first, never through this: read -rs S; printf '%s' \"$S\" | gcloud secrets create ($google_secret) --project ($p) --data-file=-"}
	}
	if not (exists secrets describe $"($service)-secret" --project $p) {
		random chars --length 64 | gc secrets create $"($service)-secret" --project $p --replication-policy automatic --data-file=- | ignore
	}
	if not (exists iam service-accounts describe $sa --project $p) {
		gc iam service-accounts create $"($service)-run" --project $p --display-name "identity broker on Cloud Run" | ignore
	}
	for s in [$"($service)-secret" $google_secret] {
		gc secrets add-iam-policy-binding $s --project $p --member $"serviceAccount:($sa)" --role roles/secretmanager.secretAccessor | ignore
	}
	if not (exists artifacts repositories describe $repository --location $region --project $p) {
		gc artifacts repositories create $repository --repository-format docker --location $region --project $p --description "pronto images" | ignore
	}

	# The broker's own files, on the Deno its image pins, for Cloud Run's linux/amd64.
	let work = (mktemp -d)
	mkdir $"($work)/broker"
	cp $"($here)/oidc.ts" $work
	cp $"($here)/broker/main.ts" $"($here)/broker/core.ts" $"($work)/broker/"
	$"FROM ($deno)\nWORKDIR /app\nCOPY oidc.ts /app/\nCOPY broker /app/broker\nRUN [\"deno\", \"cache\", \"/app/broker/main.ts\"]\nENV PORT=8080\nCMD [\"run\", \"--allow-net\", \"--allow-env\", \"/app/broker/main.ts\"]\n" | save $"($work)/Dockerfile"
	let host = $"($region)-docker.pkg.dev"
	let image = $"($host)/($p)/($repository)/($service)"
	gc auth print-access-token | ^docker login --username oauth2accesstoken --password-stdin $"https://($host)"
	with-env {SOURCE_DATE_EPOCH: "0"} { ^docker buildx build --platform linux/amd64 --provenance=false -t $"($image):release" --push -q $work | ignore }
	rm -rf $work
	let digest = (^docker buildx imagetools inspect $"($image):release" --format '{{json .Manifest}}' | from json | get digest)

	# Each secret by its version now, not `latest`: a version stored since is a new revision,
	# where `latest` would reach only instances started after it.
	let version = {|name| gc secrets versions describe latest --secret $name --project $p --format "value(name)" | str trim | path basename }
	let broker_version = (do $version $"($service)-secret")
	let google_version = (do $version $google_secret)
	let spec = {
		apiVersion: "serving.knative.dev/v1", kind: "Service"
		metadata: {name: $service, labels: {"cloud.googleapis.com/location": $region}, annotations: {"run.googleapis.com/ingress": "all"}}
		spec: {template: {
			metadata: {annotations: {
				"autoscaling.knative.dev/minScale": "0"
				# Its one-time codes live in memory: a code redeemed elsewhere would be unknown.
				"autoscaling.knative.dev/maxScale": "1"
			}}
			spec: {
				serviceAccountName: $sa
				containers: [{
					image: $"($image)@($digest)"
					ports: [{name: "http1", containerPort: 8080}]
					env: [
						{name: "BROKER_ISSUER", value: $issuer}
						{name: "GOOGLE_CLIENT_ID", value: $google_client_id}
						{name: "BROKER_SECRET", valueFrom: {secretKeyRef: {name: $"($service)-secret", key: $broker_version}}}
						{name: "GOOGLE_CLIENT_SECRET", valueFrom: {secretKeyRef: {name: $google_secret, key: $google_version}}}
					]
					startupProbe: {httpGet: {path: "/health", port: 8080}, periodSeconds: 1, failureThreshold: 30}
				}]
			}
		}}
	}
	let file = (mktemp -t --suffix .yaml)
	$spec | to yaml | save -f $file
	gc run services replace $file --region $region --project $p | ignore
	rm $file
	gc run services add-iam-policy-binding $service --region $region --project $p --member allUsers --role roles/run.invoker | ignore
	map-domain $domain $service $p $region
	let number = (gc projects describe $p --format "value(projectNumber)" | str trim)
	let address = $"https://($service)-($number).($region).run.app"
	let health = (^curl --silent --output /dev/null --write-out "%{http_code}" --retry 5 --retry-all-errors $"($address)/health")
	if $health != "200" { error make {msg: $"($address)/health answered ($health)"} }
	print $"identity: the broker is live at ($address), its issuer ($issuer)"
	print $"identity: an app signs in through it with issuer ($issuer) and client `origin` \(identity.#Signin & {signin: broker: "($issuer)"}\)"
}
