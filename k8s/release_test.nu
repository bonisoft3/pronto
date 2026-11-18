#!/usr/bin/env nu
# Run with: nu k8s/release_test.nu

const pronto_dir = path self ..
const k8s_dir = path self .
const fixtures_dir = path self testdata

use std/assert
use ../release-schema.nu [fresh-schema-runtime]

use release.nu [
	OPERATORS
	get-operator-cache-dir
	fetch-verified
	resolve-app
	render-manifests
	read-environment
	auth-provider-environment
	auth-provider-secret
	runtime-services
	airlock-services
	airlock-secrets
	roles-reconciled
	opaque-secret
	release-tree
	cluster-address-blocks
	wall-probe
	wall-probes
	before-probes
	wall-target
	wall-job-name
	wall-key
	selects
	foreign-policies
	pod-families
	ready-nodes
	wall-verdict
	wall_probe_program
	unranged-pod-addresses
]

def main [] {
	let cache = (mktemp -d)
	with-env {XDG_CACHE_HOME: $cache, LOCALAPPDATA: $cache} { run-tests }
	rm -r $cache
}

def run-tests [] {
	print "Running release-k8s tests...\n"

	test_operators_metadata
	test_native_runtime
	test_airlock_manifests
	test_airlock_wall
	test_wall_probes
	test_airlock_secrets
	test_airlock_seal
	test_airlock_refusals
	test_resolve_app_by_path
	test_resolve_app_nonexistent_fails
	test_schema_jobs
	test_auth_providers
	test_auth_provider_secrets
	test_trusted_keys
	test_release_tree
	test_read_environment
	test_render_manifests_kind
	test_crud_database_recovery
	test_render_manifests_eks
	test_render_manifests_aks
	test_dapr_annotations
	test_pods_hand_over
	test_timeout_budget_nests
	test_external_secrets_manifests
	test_observability_manifests
	test_fetch_verified_checksum_mismatch
	test_fetch_verified_cache_hit
	test_release_k8s_dry_run_cli
	test_release_nu_k8s_platform_cli
	test_cloud_release_refused

	print "\nAll release-k8s tests passed!"
}

def test_operators_metadata [] {
	print "test operator manifest definitions are valid and pinned..."
	assert ($OPERATORS | is-not-empty)
	assert ($OPERATORS | any { |it| $it.name == "external-secrets" })

	for op in $OPERATORS {
		assert ($op.name | is-not-empty)
		assert ($op.url | str starts-with "https://")
		assert ($op.checksum | str starts-with "sha256:")
		assert (($op.checksum | str replace "sha256:" "" | str length) == 64)
	}
}

def test_resolve_app_by_path [] {
	print "test resolve-app finds sample..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	assert equal $app.name "sample"
	assert ($app.cue_path | path exists)

	print "test resolve-app finds minimal..."
	let minimal = (resolve-app ($fixtures_dir | path join "minimal"))
	assert equal $minimal.name "minimal"
	assert ($minimal.cue_path | path exists)
}

def test_resolve_app_nonexistent_fails [] {
	print "test resolve-app fails loudly in a directory without a release spec..."
	try {
		do { cd $fixtures_dir; resolve-app }
		assert false "resolve-app should have failed"
	} catch { |err|
		assert ($err.msg | str contains $"No release.cue for ($fixtures_dir)")
	}
}

def test_auth_providers [] {
	print "test the auth service is given the providers and clients compose gives it..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t oidc.XXXXXX.json | str trim)
	{App: {auth: {oidc: {OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com"}}}} | to json | save -f $data
	let auth = (render-manifests $app.cue_path "kind" --data $data | from yaml | where kind == "Deployment" and metadata.name == "sample-auth" | first)
	rm $data
	let vars = ($auth.spec.template.spec.containers.0.env | reduce -f {} {|e, acc| $acc | insert $e.name ($e.value? | default "") })
	assert equal $vars.OIDC_PROVIDERS "google"
	assert equal $vars.OIDC_GOOGLE_CLIENT_ID "client.apps.googleusercontent.com"
	# Given none, the auth service is deployed as before.
	assert not ((render-manifests $app.cue_path "kind") | str contains "OIDC_")
}

# The door's own tree is the dev stack's, with no ICE servers: a gcp or k8s
# release baked from it would duel on one network and fail between two homes.
def test_release_tree [] {
	print "test a release bakes the door and the renderer over the release's tree..."
	let project = {services: {
		caddy: {build: {additional_contexts: {app-crud: "service:app-crud", app-served: "service:app-served", root: "/w"}}}
		render: {build: {additional_contexts: {app-served: "service:app-served"}}}
		crud: {build: {context: "/w"}}
		app-served: {build: {context: "/w"}}
		app-served-release: {build: {context: "/w"}}
	}}
	let released = ($project | to yaml | release-tree | from yaml)
	assert equal $released.services.caddy.build.additional_contexts {app-crud: "service:app-crud", app-served: "service:app-served-release", root: "/w"}
	assert equal $released.services.render.build.additional_contexts {app-served: "service:app-served-release"}
	assert equal $released.services.crud $project.services.crud
	let unreleased = ($project | reject services.app-served-release | to yaml)
	let refused = (try { $unreleased | release-tree; "" } catch {|e| $e.msg })
	assert ($refused | str contains "the project builds from service:app-served, and has no app-served-release to release it from")
}

def test_auth_provider_secrets [] {
	print "test provider secrets stay outside release metadata and roll auth on rotation..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let environment = {
		OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "client"
		OIDC_GOOGLE_CLIENT_SECRET: "private-provider-credential", DATABASE_URL: "unrelated"
	}
	let split = (auth-provider-environment $environment)
	assert equal $split.oidc {OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "client"}
	assert equal $split.secretValues {OIDC_GOOGLE_CLIENT_SECRET: "private-provider-credential"}
	let payload = (auth-provider-secret "sample" "sample" $split.secretValues)
	assert equal $payload.metadata {name: "sample-oidc", namespace: "sample"}
	assert ($payload.stringData? == null)
	assert equal ($payload.data.OIDC_GOOGLE_CLIENT_SECRET | decode base64 | decode utf-8) "private-provider-credential"
	assert equal (auth-provider-secret "sample" "sample" {}).data {}
	let metadata = ($split | reject secretValues)
	assert not (($metadata | to json) | str contains "private-provider-credential")
	let data = (mktemp --suffix .json)
	{App: {auth: $metadata}} | to json | save -f $data
	let yaml = (render-manifests $app.cue_path "kind" --data $data)
	assert not ($yaml | str contains "private-provider-credential")
	let pod = ($yaml | from yaml | where kind == "Deployment" and metadata.name == "sample-auth" | first | get spec.template)
	let secret = ($pod.spec.containers.0.env | where name == "OIDC_GOOGLE_CLIENT_SECRET" | first)
	assert equal $secret.valueFrom.secretKeyRef {name: "sample-oidc", key: "OIDC_GOOGLE_CLIENT_SECRET"}
	assert ($secret.value? == null)
	assert equal ($pod.metadata.annotations | get "pronto.dev/oidc-secret-digest") $split.oidcSecretDigest
	let rotated = (auth-provider-environment ($environment | update OIDC_GOOGLE_CLIENT_SECRET "rotated-credential"))
	assert ($rotated.oidcSecretDigest != $split.oidcSecretDigest)
	let public_client = (auth-provider-environment ($environment | update OIDC_GOOGLE_CLIENT_SECRET ""))
	assert equal $public_client.oidcSecrets []
	assert equal $public_client.oidcSecretDigest ""
	let with_release_broker = (auth-provider-environment {
		OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "origin"
		OIDC_GOOGLE_ISSUER: "http://localhost:28443", OIDC_GOOGLE_INTERNAL: "http://identity:28443/"
	} {google: {releaseIssuer: "https://id.example.com"}})
	assert equal $with_release_broker.oidc.OIDC_GOOGLE_ISSUER "https://id.example.com"
	assert equal $with_release_broker.oidc.OIDC_GOOGLE_INTERNAL "https://id.example.com"
	{App: {auth: {oidc: {OIDC_GOOGLE_CLIENT_SECRET: "must-be-refused"}}}} | to json | save -f $data
	let refused = (try { render-manifests $app.cue_path "kind" --data $data; false } catch {|err|
		assert ($err.msg | str contains "field not allowed")
		true
	})
	rm $data
	assert $refused
}

def test_trusted_keys [] {
	print "test a trusted issuer's keys stay outside the manifests, and crud verifies them for its audience..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let plain = (render-manifests $app.cue_path "kind" | from yaml | where kind == "Deployment" and metadata.name == "sample-crud" | first | get spec.template)
	assert equal ($plain.spec.containers.0.env | where name == "PGRST_JWT_SECRET" | first | get valueFrom.secretKeyRef) {name: "sample-auth-secrets", key: "PGRST_JWT_SECRET"}
	assert ($plain.spec.containers.0.env | where name == "PGRST_JWT_AUD" | is-empty)
	# crud tells the floor the roles the program declares, none here.
	assert equal ($plain.spec.containers.0.env | where name == "PGRST_APP_SETTINGS_TOKEN_ROLES" | first | get value) ""
	let digest = ("{\"keys\":[]}" | hash sha256)
	let data = (mktemp --suffix .json)
	{App: {trustedKeysDigest: $digest, trustedAudience: ""}} | to json | save -f $data
	let yaml = (render-manifests $app.cue_path "kind" --data $data)
	rm $data
	let pod = ($yaml | from yaml | where kind == "Deployment" and metadata.name == "sample-crud" | first | get spec.template)
	let crud = $pod.spec.containers.0.env
	assert equal ($crud | where name == "PGRST_JWT_SECRET" | length) 1
	assert equal ($crud | where name == "PGRST_JWT_SECRET" | first | get valueFrom.secretKeyRef) {name: "sample-trusted-keys", key: "PGRST_JWKS"}
	assert (($crud | where name == "PGRST_JWT_AUD" | first | get value) ends-with "/crud")
	assert equal ($pod.metadata.annotations | get "pronto.dev/trusted-keys-digest") $digest
	# The key set is a Secret the release applies through stdin, never a manifest.
	assert not ($yaml | str contains "PGRST_JWKS:")
	let named = (mktemp --suffix .json)
	{App: {trustedKeysDigest: $digest, trustedAudience: "https://api.example/crud"}} | to json | save -f $named
	let aud = (render-manifests $app.cue_path "kind" --data $named | from yaml | where kind == "Deployment" and metadata.name == "sample-crud" | first | get spec.template.spec.containers.0.env | where name == "PGRST_JWT_AUD" | first | get value)
	rm $named
	assert equal $aud "https://api.example/crud"
}

def test_schema_jobs [] {
	print "test the schema is built by the app's own database and migrate images..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t migrate.XXXXXX.json | str trim)
	{App: {migrate: {env: {REQUIRED_TABLES: "schedule"}}}} | to json | save -f $data
	let yaml = (render-manifests $app.cue_path "kind" --data $data)
	rm $data
	# The release once compiled its own migration list, which dropped *seed*
	# files and mecha's staged steps: k8s ran a schema integrate never tested.
	assert ($yaml | str contains "name: sample-initdb")
	assert ($yaml | str contains "image: localhost:5001/sample-database:latest")
	assert ($yaml | str contains "docker_process_init_files /docker-entrypoint-initdb.d/*")
	# A built database without the queue's or the airlock's schema, which the
	# program's first effect needs, is refused rather than half upgraded.
	let rerun = ($yaml | from yaml | where kind == Job and metadata.name == sample-initdb | first | get spec.template.spec.containers.0.command.2)
	assert ($rerun | str contains "for step in graphile_worker airlock; do") $rerun
	assert ($rerun | str contains "SELECT 1 FROM pg_namespace WHERE nspname = '${step}'") $rerun
	assert ($yaml | str contains "name: sample-migrate")
	assert ($yaml | str contains "image: localhost:5001/sample-migrate:latest")
	assert ($yaml | str contains "value: schedule")
	# An app with no ledger migrations or reconciliation (no migrate service) runs no migrate Job.
	assert not ((render-manifests (resolve-app ($fixtures_dir | path join "minimal")).cue_path "kind") | str contains "minimal-migrate")
	assert not ($yaml | str contains "postInitApplicationSQLRefs")
	# One credential for postgres: CloudNativePG's superuser and owner secret is
	# the one auth and the Jobs read.
	assert ($yaml | str contains "superuserSecret:\n    name: sample-db-postgres")
	assert not ($yaml | str contains "sample-db-app")
	# PostgREST logs in as authenticator, never postgres: it applies a token
	# role's statement_timeout only when that role is granted to its login.
	assert ($yaml | str contains "value: postgres://authenticator:$(AUTHENTICATOR_PASSWORD)@database:5432/sample")
	let authenticator = ($yaml | from yaml | where kind == "Cluster" | first | get spec.managed.roles | where name == "authenticator" | first)
	# The schema's own token roles, which the operator would otherwise revoke;
	# a fixed list named roles an app without auth never creates.
	assert equal $authenticator.inRoles (open ((resolve-app ($fixtures_dir | path join "sample")).cue_path | path dirname | path join .pronto cluster.json) | get tokenRoles)
	assert equal $authenticator.inRoles ["anon" "app_user" "service"]
	assert equal $authenticator.inherit false
	# The schema creates the roles it joins, never the bootstrap: one way for a
	# fresh database and one that gains a declared role alike.
	assert (($yaml | from yaml | where kind == "Cluster" | first | get spec.bootstrap.initdb.postInitSQL?) == null)
	# authenticator is reconciled when the database holds it as the spec says,
	# whatever an attempt made before the schema's roles stood could not do.
	assert (roles-reconciled {byStatus: {reconciled: [electric authenticator]}, cannotReconcile: {authenticator: ["role \"reader\" does not exist"]}})
	assert not (roles-reconciled {byStatus: {reconciled: [electric], pending-reconciliation: [authenticator]}})
	assert not (roles-reconciled {byStatus: {reconciled: [electric authenticator], pending-reconciliation: [electric]}})
	assert not (roles-reconciled {})
	# Enforcing CNIs: OTLP/HTTP to Jaeger, and the instance manager's API server.
	assert ($yaml | str contains "port: 4318")
	assert ($yaml | str contains "port: 6443")
	# One Service per component under its compose name; the database's on
	# CloudNativePG's current role label, routes only from the app's namespace.
	assert equal ($yaml | from yaml | where kind == "Service" | get metadata.name | sort) ["auth" "caddy" "crud" "database" "electric" "render"]
	assert ($yaml | str contains "cnpg.io/instanceRole: primary")
	assert not ($yaml | str contains "from: All")
	# caddy's tracing exports OTLP over gRPC, Deno over HTTP.
	assert ($yaml | str contains "name: PRONTO_TRACING\n              value: \"on\"")
	assert ($yaml | str contains "value: http://jaeger.observability.svc.cluster.local:4317")
	assert ($yaml | str contains "value: http://jaeger.observability.svc.cluster.local:4318")
}

def test_read_environment [] {
	print "test read-environment reads each target's registry and platform..."
	# A wrong field name here once went unnoticed behind a hard-coded registry.
	assert equal (read-environment "kind" | get registry) "localhost:5001"
	assert equal (read-environment "eks" | get platform) "linux/amd64"
	assert equal (read-environment "aks" | get platform) "linux/amd64"
}

def test_crud_database_recovery [] {
	print "test a database outage neither restarts CRUD nor removes its retryable response from discovery..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let crud = (render-manifests $app.cue_path "kind" | from yaml | where kind == "Deployment" and metadata.name == "sample-crud" | first | get spec.template.spec.containers | where name == "crud" | first)
	assert equal $crud.livenessProbe.httpGet {path: "/live", port: 3001}
	assert equal $crud.readinessProbe.httpGet {path: "/live", port: 3001}
	assert equal $crud.startupProbe {httpGet: {path: "/ready", port: 3001}, periodSeconds: 2, failureThreshold: 150}
}

def test_render_manifests_kind [] {
	print "test render-manifests for Kind..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let yaml = (render-manifests $app.cue_path "kind")

	assert ($yaml | str contains "kind: Cluster")
	# Every service runs the app's own compose image: CloudNativePG's stock
	# postgres lacked the plv8 mecha's database image installs.
	for svc in ["database" "crud" "electric" "auth" "caddy" "render"] {
		assert ($yaml | str contains $"localhost:5001/sample-($svc):latest")
	}
	assert ($yaml | str contains "postgresUID: 999")

	# CloudNativePG refuses `latest` and a bare digest ("can't detect
	# upgrades"): a release names each image by the tag and digest it pushed.
	let digest = "sha256:" + ("0" | fill -c "0" -w 64)
	let data = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: {image: {pushed: {database: {tag: "18", digest: $digest}}}}} | to json | save -f $data
	let pinned = (render-manifests $app.cue_path "kind" --data $data)
	rm $data
	assert ($pinned | str contains $"imageName: localhost:5001/sample-database:18@($digest)")
	assert ($pinned | str contains "image: localhost:5001/sample-caddy:latest")
	assert ($yaml | str contains "image: localhost:5001/sample-caddy:latest")
	assert ($yaml | str contains "image: localhost:5001/sample-auth:latest")
	assert ($yaml | str contains "name: sample-auth-secrets")
	assert ($yaml | str contains "name: sample-crud")
	assert ($yaml | str contains "name: sample-auth")
	assert ($yaml | str contains "name: sample-caddy")
	assert ($yaml | str contains "name: sample-electric")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "name: sample-gateway")
	assert ($yaml | str contains "name: sample-route")
	assert ($yaml | str contains "gatewayClassName: eg")
	assert ($yaml | str contains "certificateRefs:")
	assert ($yaml | str contains "- name: sample-tls")
	# Envoy Gateway merges every app's Gateway onto one hostPort proxy; listeners
	# scoped to the app's hostname are what keep two apps' :443 from conflicting.
	assert ($yaml | str contains "hostname: sample.localhost")
	assert ($yaml | str contains "value: https://sample.localhost")
	assert ($yaml | str contains "kind: NetworkPolicy")
	assert ($yaml | str contains "name: sample-caddy-netpol")
	assert ($yaml | str contains "name: sample-backends-netpol")
	assert ($yaml | str contains "name: sample-database-netpol")
	# Caddy proxies SSR routes to the short name `render`; without it every rendered page is a 502.
	assert ($yaml | str contains "image: localhost:5001/sample-render:latest")
	assert ($yaml | str contains "name: sample-render")
	assert ($yaml | str contains "name: render\n")

	let minimal = (resolve-app ($fixtures_dir | path join "minimal"))
	let minimal_yaml = (render-manifests $minimal.cue_path "kind")
	assert ($minimal_yaml | str contains "kind: Cluster")
	assert ($minimal_yaml | str contains "name: minimal-db")
	assert ($minimal_yaml | str contains "name: minimal-auth-secrets")
	assert ($minimal_yaml | str contains "name: minimal-crud")
	assert ($minimal_yaml | str contains "name: minimal-electric")
	assert ($minimal_yaml | str contains "name: minimal-auth")
	assert ($minimal_yaml | str contains "name: minimal-caddy")
	assert ($minimal_yaml | str contains "name: minimal-gateway")
	assert ($minimal_yaml | str contains "name: minimal-route")
	assert ($minimal_yaml | str contains "gatewayClassName: eg")
	assert ($minimal_yaml | str contains "image: localhost:5001/minimal-caddy:latest")
	assert ($minimal_yaml | str contains "image: localhost:5001/minimal-auth:latest")
	assert ($minimal_yaml | str contains "certificateRefs:")
	assert ($minimal_yaml | str contains "- name: minimal-tls")
	assert ($minimal_yaml | str contains "hostname: minimal.localhost")
	assert not ($minimal_yaml | str contains "minimal-render")
	# Caddy dials short Service names (crud, auth, electric); two apps sharing a
	# namespace would route one app's traffic to the other's backends.
	assert not ($yaml | str contains "namespace: default")
	assert not ($minimal_yaml | str contains "namespace: default")
	assert ($yaml | str contains "namespace: sample")
	assert ($minimal_yaml | str contains "namespace: minimal")
}

def test_render_manifests_eks [] {
	print "test render-manifests for AWS EKS..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let yaml = (render-manifests $app.cue_path "eks")

	assert ($yaml | str contains "kind: Cluster")
	assert ($yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-caddy:latest")
	assert ($yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-auth:latest")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "gatewayClassName: amazon-vpc-lattice")
	assert ($yaml | str contains "- sample.eks.internal.net")

	let minimal = (resolve-app ($fixtures_dir | path join "minimal"))
	let minimal_yaml = (render-manifests $minimal.cue_path "eks")
	assert ($minimal_yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/minimal-caddy:latest")
	assert ($minimal_yaml | str contains "gatewayClassName: amazon-vpc-lattice")
	assert ($minimal_yaml | str contains "- minimal.eks.internal.net")
}

def test_render_manifests_aks [] {
	print "test render-manifests for Azure AKS..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let yaml = (render-manifests $app.cue_path "aks")

	assert ($yaml | str contains "kind: Cluster")
	assert ($yaml | str contains "image: myacr.azurecr.io/sample-caddy:latest")
	assert ($yaml | str contains "image: myacr.azurecr.io/sample-auth:latest")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "gatewayClassName: azure-alb-external")
	assert ($yaml | str contains "- sample.aks.internal.net")
}

def test_pods_hand_over [] {
	print "test a replaced pod keeps serving while the mesh learns of its successor..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let docs = (render-manifests $app.cue_path "kind" | from yaml | where kind == "Deployment")
	let crud = (fresh-schema-runtime ($docs | where metadata.name == sample-crud | first | to yaml) | from yaml)
	assert equal ($crud.spec.template.spec.containers | where name == crud | first | get startupProbe.httpGet.path) "/ready"
	for c in ["crud" "electric" "auth" "caddy" "render"] {
		let d = ($docs | where metadata.name == $"sample-($c)" | first)
		assert equal ($d.spec.template.spec.containers | where name == $c | first | get lifecycle.preStop.sleep.seconds) 15 $"($c) pauses before it stops"
		assert equal ($d.spec.template.metadata.annotations | get "dapr.io/block-shutdown-duration") "20s" $"($c)'s sidecar outlasts the pause"
	}
}

def test_dapr_annotations [] {
	print "test every pod joins the dapr mesh and caddy dials through its sidecar..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let yaml = (render-manifests $app.cue_path "kind")

	# Caddy's Caddyfile names upstreams by app id (dapr-app-id), the same short
	# names compose uses, so ids carry no app prefix; namespaces keep apps apart.
	for id in ["crud" "auth" "electric" "caddy" "render"] {
		assert ($yaml | str contains $"dapr.io/app-id: ($id)\n")
	}
	assert ($yaml | str contains "dapr.io/config: sample-dapr-config")
	# A door hatch is dialed like the cluster's own services.
	for up in ["CRUD" "AUTH" "ELECTRIC" "TICKER" "RCLONE_S3" "IMGPROXY" "RENDER" "PRINT_COMMERCE"] {
		assert ($yaml | str contains $"name: PRONTO_UPSTREAM_($up)\n              value: localhost:3500")
	}
	assert ($yaml | str contains "value: http://localhost:3500/v1.0/invoke/caddy/method")
	assert ($yaml | str contains "name: OTEL_DENO")
	assert ($yaml | str contains "kind: Configuration")
	assert ($yaml | str contains "endpointAddress: jaeger.observability.svc.cluster.local:4317")
	# Sidecars reach each other on daprd's internal gRPC port.
	assert ($yaml | str contains "port: 50002")
	assert ($yaml | str contains "kubernetes.io/metadata.name: dapr-system")
}


def test_timeout_budget_nests [] {
	print "test the timeouts nest, and every hop takes its bound from resilience..."
	let budget_dir = ($pronto_dir | path join "resilience")
	let resilience = (do { cd $budget_dir; cue export . -e resilience --out json } | from json)
	let budget = $resilience.timeouts
	let objects = (render-manifests (resolve-app ($fixtures_dir | path join "sample")).cue_path "kind" | from yaml)
	let route = ($objects | where kind == "HTTPRoute" | first | get spec.rules | each {|r| [($r.matches | first | get path.value) $r.timeouts.request] } | into record)
	assert equal $route {"/": $"($budget.gateway.default)s", "/electric/": $"($budget.gateway.electric)s"}
	let resiliency = ($objects | where kind == "Resiliency" | first | get spec)
	assert equal $resiliency.policies.timeouts ($budget.mesh | items {|id, s| [$id $"($s)s"] } | into record)
	# Timeouts alone. Dapr 1.14 counts every answer outside 200-399 as a
	# failure, so a breaker opened on clients' 401s and shapes' 409s; and no
	# retry policy, so a write is never replayed.
	# The door hatch takes the `hatch` hop's bound under its own app id; the
	# hop is a policy, not an app.
	assert equal $resiliency.targets.apps.print-commerce {timeout: "hatch"}
	assert ($resiliency.targets.apps.hatch? == null)
	assert equal ($resiliency.targets.apps | values | where {|t| $t.circuitBreaker? != null } | length) 0
	assert ($resiliency.policies.circuitBreakers? == null)
	assert ($resiliency.policies.retries? == null)
	assert equal ($objects | where kind == "BackendTrafficPolicy" | first | get spec.circuitBreaker) $resilience.gateway
	assert equal ($objects | where kind == "BackendTrafficPolicy" | first | get spec.targetRefs.0.name) "sample-route"
	# Caddy names hops; the numbers are the budget's alone.
	let caddyfile = (open ($pronto_dir | path join "assets" "Caddyfile"))
	assert not ($caddyfile | str contains "_timeout ")
	# The render and hatch hops are emitted per app (emit.cue), not in the asset.
	assert equal ($caddyfile | parse --regex '(?m)^\s*import bounded-(?<hop>[a-z]+)$' | get hop | uniq | sort) ($budget.door | columns | where $it not-in ["render" "hatch"] | sort)
	# A budget that does not nest is refused, not deployed: a sidecar bound past
	# caddy's in front of it, and a gateway bound under Electric's gate plus
	# Electric, which run one after the other on the same request.
	for broken in [
		{bound: ($budget | update mesh.crud ($budget.door.crud + 1)), names: "door.crud"}
		{bound: ($budget | update gateway.electric ($budget.door.electric + 1)), names: "gateway.electric"}
	] {
		let tmp = (mktemp --suffix .json)
		{timeouts: $broken.bound, gateway: $resilience.gateway} | to json | save -f $tmp
		let refused = (do { cd $budget_dir; cue vet -d "#Resilience" . $tmp } | complete)
		rm $tmp
		assert ($refused.exit_code != 0)
		assert ($refused.stderr | str contains $broken.names)
	}
}

def test_external_secrets_manifests [] {
	print "test external secrets manifest emitted when externalSecrets.enabled is true..."
	let data = (mktemp -t external-secrets.XXXXXX.json | str trim)
	{App: {externalSecrets: {enabled: true}}} | to json | save -f $data
	let yaml = (render-manifests (resolve-app ($fixtures_dir | path join "minimal")).cue_path "kind" --data $data)
	rm $data

	assert ($yaml | str contains "kind: ExternalSecret")
	assert ($yaml | str contains "name: minimal-auth-secrets")
	assert ($yaml | str contains "key: minimal/PGRST_JWT_SECRET")
	assert ($yaml | str contains "key: minimal/ELECTRIC_SECRET")
	assert ($yaml | str contains "key: minimal/ELECTRIC_PASSWORD")
	assert not ($yaml | str contains "kind: Password")

	# Without a store, ESO generates each secret once in-cluster; no value is a
	# literal in the spec, which once shipped electric:electric on a BYPASSRLS role.
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let kind_yaml = (render-manifests $app.cue_path "kind")
	assert ($kind_yaml | str contains "kind: Password")
	assert ($kind_yaml | str contains "name: sample-electric-password")
	assert ($kind_yaml | str contains "type: kubernetes.io/basic-auth")
	assert ($kind_yaml | str contains "passwordSecret:\n          name: sample-electric-db")
	assert ($kind_yaml | str contains "postgresql://electric:$(ELECTRIC_PASSWORD)@database")
	assert not ($kind_yaml | str contains "electric:electric")
	assert not ($kind_yaml | str contains "please-override")
}

def test_observability_manifests [] {
	print "test observability stack CUE definitions export correctly..."
	let obs_cue = ($k8s_dir | path join "observability" "observability.cue")
	let yaml = (cue export --expression '(#ObservabilityStack & {domainSuffix: "localhost"}).manifests' --out text $obs_cue)

	assert ($yaml | str contains "name: vmsingle")
	assert ($yaml | str contains "image: docker.io/victoriametrics/victoria-metrics:v1.106.1@sha256:54b283129634239db62798fd8d92e8d8d4372a0b114e72967eb233dbb264ff53")
	assert ($yaml | str contains "name: jaeger")
	assert ($yaml | str contains "image: docker.io/jaegertracing/all-in-one:1.64.0@sha256:7e9591218e7ddd51e568ef892e3ea190ae420ecf97c4d718910a3f57e076c216")
	assert ($yaml | str contains "name: vector")
	assert ($yaml | str contains "image: docker.io/timberio/vector:0.43.0-alpine@sha256:7bcb75f71f93d312d928182e6a07f6df14a18d030785bb3197ac01128bd287a3")
	assert ($yaml | str contains "name: telemetry-route")
	assert ($yaml | str contains "parentRefs:\n    - name: telemetry")
	assert ($yaml | str contains "hostname: telemetry.localhost")
	assert ($yaml | str contains "value: /vmui")
	assert ($yaml | str contains "value: /jaeger")
	assert ($yaml | str contains "name: observability-netpol")
}

def test_fetch_verified_checksum_mismatch [] {
	print "test fetch-verified throws loud error on sha256 mismatch..."
	deno run --no-config --allow-net=127.0.0.1 --allow-run=nu ($fixtures_dir | path join "checksum-mismatch.ts") ($k8s_dir | path join "release.nu")
}

def test_fetch_verified_cache_hit [] {
	print "test fetch-verified reuses cached verified file..."
	let cache_dir = (get-operator-cache-dir)
	mkdir $cache_dir

	let test_content = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: test-cache\n"
	let test_hash = ($test_content | hash sha256)
	let test_file = ($cache_dir | path join "test-cache-hit.yaml")
	$test_content | save -f -r $test_file

	let entry = {
		name: "test-cache-hit"
		url: "https://example.invalid/not-called"
		checksum: $"sha256:($test_hash)"
	}

	# Should succeed without hitting the network because cached hash matches
	let resolved = (fetch-verified $entry)
	assert equal $resolved $test_file
	rm -f $test_file
}

def test_release_k8s_dry_run_cli [] {
	print "test release.nu --dry-run prints manifests without cluster mutation..."
	let res = (do { nu ($k8s_dir | path join "release.nu") --dry-run --app ($fixtures_dir | path join "sample") } | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "kind: Service")
	assert ($res.stdout | str contains "kind: Deployment")
	assert ($res.stdout | str contains "kind: Gateway")
	assert ($res.stdout | str contains "kind: HTTPRoute")
	assert ($res.stdout | str contains "localhost:5001/sample-caddy:latest")
}

def test_release_nu_k8s_platform_cli [] {
	print "test release.nu --dry-run -e eks renders EKS manifests..."
	let res = (do {
		cd ($fixtures_dir | path join "sample")
		nu ($k8s_dir | path join "release.nu") --dry-run -e eks
	} | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-caddy:latest")
	assert ($res.stdout | str contains "gatewayClassName: amazon-vpc-lattice")
}

def test_cloud_release_refused [] {
	print "test a cloud release that would deploy is refused before touching anything..."
	# The Kind path alone provisions operators, observability and TLS; an EKS
	# release once went ahead without them.
	let res = (do { nu ($k8s_dir | path join "release.nu") --app ($fixtures_dir | path join "sample") -e eks } | complete)
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "release to eks is not implemented")
}


def test_native_runtime [] {
	print "test native CDC services persist state and never deploy compose credentials..."
	let app = (resolve-app ($fixtures_dir | path join native))
	let runtime = (runtime-services (open ($app.dir | path join compose.yaml)))
	assert equal $runtime.compute.databaseEnvironment [DATABASE_URL]
	assert equal $runtime.risingwave.databaseEnvironment []
	assert not (($runtime | to json) | str contains "dev-password")
	for target in [kind gke] {
		let rendered = (render-manifests $app.cue_path $target)
		assert not ($rendered | str contains "dev-password")
		let deployments = ($rendered | from yaml | where kind == Deployment)
		for service in [{name: compute, database: DATABASE_URL}] {
			let variables = ($deployments | where metadata.name == $"native-($service.name)" | first | get spec.template.spec.containers.0.env)
			let password = ($variables | where name == PGPASSWORD | first)
			assert equal $password.valueFrom.secretKeyRef {name: native-db-postgres, key: password}
			assert ($password.value? == null)
			assert equal ($variables | where name == $service.database | first | get value) 'postgresql://postgres:$(PGPASSWORD)@database:5432/native?sslmode=disable'
		}
	}
	let rendered = (render-manifests $app.cue_path kind)
	let docs = ($rendered | from yaml)
	assert not ($rendered | str contains "dev-password")
	assert not ($rendered | str contains "dev-token")
	let deployments = ($docs | where kind == "Deployment")
	for name in [compute risingwave conduit redis transform] {
		let spec = ($deployments | where metadata.name == $"native-($name)" | first | get spec)
		assert equal $spec.replicas 1
		assert equal $spec.strategy.type "Recreate"
	}
	assert equal ($docs | where kind == "PersistentVolumeClaim" | get metadata.name | sort) [native-redis]
	let rw_container = ($deployments | where metadata.name == native-risingwave | first | get spec.template.spec.containers.0)
	assert ($rw_container.volumeMounts? == null)
	assert equal $rw_container.args ["single_node"]
	let compute_container = ($deployments | where metadata.name == native-compute | first | get spec.template.spec.containers.0)
	assert ($compute_container.volumeMounts? == null)
	let rw_netpol = ($docs | where kind == "NetworkPolicy" and metadata.name == "native-risingwave" | first | get spec.ingress.0)
	assert equal $rw_netpol.from.0.podSelector.matchLabels."app.kubernetes.io/component" "compute"
	let compute = ($deployments | where metadata.name == native-compute | first | get spec.template.spec.containers.0.env)
	assert equal ($compute | where name == SERVICE_JWT | first | get valueFrom.secretKeyRef.name) native-service-token
	assert equal ($compute | where name == RISINGWAVE_URL | first | get value) "http://risingwave:4566"
	let conduit = ($deployments | where metadata.name == native-conduit | first | get spec.template.spec.containers.0.env)
	assert equal ($conduit | where name == CONDUIT_DB_TYPE | first | get value) postgres
	assert equal ($conduit | where name == CONDUIT_DB_POSTGRES_CONNECTION_STRING | first | get value) '$(DATABASE_URL)'
	assert equal ($docs | where kind == Cluster | first | get spec.postgresql.parameters.max_replication_slots) "128"
	let refused = (try { runtime-services {services: {compute: {environment: {DUCKSTREAM_ENGINE: duckdb-snapshot}}}}; false } catch { true })
	assert $refused
	let gcp = (do { nu ($pronto_dir | path join gcp release.nu) --dry-run --app $app.dir } | complete)
	assert equal $gcp.exit_code 0
	assert ($gcp.stdout | str contains "us-central1-docker.pkg.dev/test-project/pronto/native-compute:latest")
	assert ($gcp.stdout | str contains "storageClassName: standard-rwo")
	assert ($gcp.stdout | str contains "kind: PersistentVolumeClaim")
}


# The fixture's compose project and facts: an effect through an origin, one
# through a container bridge, one through an isolate bridge, and one through
# a bridge only docker runs.
def effects-manifests [--data: record]: nothing -> list {
	let app = (resolve-app ($fixtures_dir | path join effects))
	if $data == null { return (render-manifests $app.cue_path kind | from yaml) }
	let file = (mktemp -t effects.XXXXXX.json | str trim)
	{App: $data} | to json | save -f $file
	let yaml = (render-manifests $app.cue_path kind --data $file)
	rm $file
	$yaml | from yaml
}

def test_airlock_manifests [] {
	print "test the airlock, its daprd and its bridges run compose's images, the daprd on k8s's endpoints..."
	let docs = (effects-manifests)
	let deployment = {|name| $docs | where kind == Deployment and metadata.name == $name | first | get spec.template }
	# The daprd is its own pod on compose's image, never the airlock's sidecar,
	# and holds k8s's endpoints over the image's, which are docker's.
	let mesh = (do $deployment effects-airlock-mesh)
	assert (($mesh.metadata.annotations? | default {} | columns | where {|a| $a starts-with "dapr.io/" }) | is-empty)
	assert equal ($mesh.spec.containers | length) 1
	assert equal $mesh.spec.containers.0.image "localhost:5001/effects-airlock-mesh:latest"
	assert equal ($mesh.spec.containers.0.volumeMounts | each {|m| [$m.mountPath $m.subPath] }) [[/dapr/airlock/charge.yaml charge.yaml] [/dapr/airlock/echo.yaml echo.yaml] [/dapr/airlock/fetch.yaml fetch.yaml] [/dapr/airlock/render.yaml render.yaml]]
	assert equal $mesh.spec.volumes.0.configMap.name effects-airlock-endpoints
	let endpoints = ($docs | where kind == ConfigMap and metadata.name == effects-airlock-endpoints | first | get data | items {|f, y| $y | from yaml } | reduce -f {} {|e, acc| $acc | insert $e.metadata.name $e.spec.baseUrl })
	assert equal $endpoints {charge: "https://api.acquirer.example", echo: "http://echo:8080", fetch: "http://transport:8080", render: "http://pdf:8080"}
	assert ($mesh.metadata.annotations."pronto.dev/endpoints-digest" =~ '^[0-9a-f]{64}$')
	# The airlock runs compose's image, told its target, the door's origin and
	# the ledger's owner; its secrets are references.
	let airlock = (do $deployment effects-airlock)
	assert equal $airlock.spec.containers.0.image "localhost:5001/effects-airlock:latest"
	let vars = $airlock.spec.containers.0.env
	let value = {|name| $vars | where name == $name | first | get -o value }
	assert equal (do $value AIRLOCK_TARGET) k8s
	assert equal (do $value ORIGIN) "https://effects.localhost"
	assert equal (do $value MESH_URL) "http://airlock-mesh:3500"
	assert equal (do $value AIRLOCK_DIR) /airlock
	assert equal (do $value DATABASE_URL) 'postgresql://postgres:$(PGPASSWORD)@database:5432/effects?sslmode=disable'
	assert equal ($vars | where name == PGPASSWORD | first | get valueFrom.secretKeyRef) {name: effects-db-postgres, key: password}
	assert equal ($vars | where name == ACQUIRER_KEY | first | get valueFrom.secretKeyRef) {name: effects-airlock, key: ACQUIRER_KEY}
	# The seal keys are references to the same Secret, the replaced one only
	# through a rotation; the airlock is never told it is the local stack's.
	assert equal ($vars | where name == AIRLOCK_SEAL_KEY | first | get valueFrom.secretKeyRef) {name: effects-airlock, key: AIRLOCK_SEAL_KEY}
	assert equal ($vars | where name == AIRLOCK_SEAL_KEY_PREVIOUS | first | get valueFrom.secretKeyRef) {name: effects-airlock, key: AIRLOCK_SEAL_KEY_PREVIOUS, optional: true}
	assert ($vars | where name == AIRLOCK_SEAL_DEV | is-empty)
	# A release's airlock, which refuses the development key by its id
	# however the release spells it, where the byte check above sees bytes.
	assert equal (do $value AIRLOCK_RELEASE) k8s
	# The ledger's upgrade runs as a Job on its own image, after initdb.
	let jobs = ($docs | where kind == Job | get metadata.name)
	assert equal $jobs [effects-initdb effects-airlock-upgrade]
	assert equal ($docs | where kind == Job and metadata.name == effects-airlock-upgrade | first | get spec.template.spec.containers.0.image) "localhost:5001/effects-airlock-upgrade:latest"
	# A bridge on k8s runs its container's image, a container bridge and an
	# isolate alike, under the container's name; the docker-only one does not.
	for b in [{c: echo, build: echo-appliance} {c: transport, build: transport-appliance}] {
		let spec = ($docs | where kind == Deployment and metadata.name == $"effects-bridge-($b.c)" | first | get spec)
		assert equal $spec.replicas 1 $"($b.c) stays up for the call that needs it"
		assert equal $spec.template.spec.containers.0.image $"localhost:5001/effects-($b.build):latest"
		assert equal $spec.template.spec.containers.0.envFrom [{secretRef: {name: $"effects-bridge-($b.c)", optional: true}}]
		assert equal $spec.template.spec.containers.0.readinessProbe.tcpSocket.port 8080
	}
	assert equal ($docs | where kind == Service | get metadata.name | where $it in [airlock airlock-mesh echo transport pdf] | sort) [airlock airlock-mesh echo transport]
	assert ($docs | where metadata.name == effects-pdf | is-empty)
	# The ticker's wake reaches the airlock as compose's does.
	let ticker = (do $deployment effects-ticker | get spec.containers.0.env | where name == WAKE_URLS | first | get value)
	assert equal $ticker "http://airlock:9997/healthz"
	# No value compose resolved for a secret, a bridge's environment or the
	# database lands in a manifest.
	let yaml = ($docs | to yaml)
	for leaked in [sk_live_from_the_environment tt_from_the_environment dev-password dev-token ZGV2LXNlYWwta2V5] {
		assert not ($yaml | str contains $leaked) $"($leaked) is in the manifests"
	}
	# A rotated secret rolls the airlock, and a bridge's environment its pod.
	let digest = ("a" | fill -c "a" -w 64)
	let rolled = (effects-manifests --data {airlock: {secretDigest: $digest, bridges: {echo: {envDigest: $digest}}}})
	assert equal ($rolled | where kind == Deployment and metadata.name == effects-airlock | first | get spec.template.metadata.annotations."pronto.dev/airlock-secret-digest") $digest
	assert equal ($rolled | where kind == Deployment and metadata.name == effects-bridge-echo | first | get spec.template.metadata.annotations."pronto.dev/env-digest") $digest
}

def test_airlock_wall [] {
	print "test compose's networks are NetworkPolicies: the airlock reaches only its database and daprd..."
	let policies = (effects-manifests | where kind == NetworkPolicy)
	let policy = {|name| $policies | where metadata.name == $name | first | get spec }
	let component = {|c| {"app.kubernetes.io/component": $c, "app.kubernetes.io/name": effects} }
	let airlock = (do $policy effects-airlock)
	assert equal $airlock.policyTypes [Ingress Egress]
	# In: the ticker's wake alone. Out: DNS, the database and the daprd; no
	# address block, so nothing past the cluster.
	assert equal $airlock.ingress [{from: [{podSelector: {matchLabels: (do $component ticker)}}], ports: [{port: 9997, protocol: TCP}]}]
	assert equal ($airlock.egress | length) 3
	# DNS goes to the cluster's resolver alone: port 53 anywhere is a way out.
	let resolver = {namespaceSelector: {matchLabels: {"kubernetes.io/metadata.name": kube-system}}, podSelector: {matchLabels: {"k8s-app": kube-dns}}}
	for p in [effects-airlock effects-airlock-mesh effects-bridge-echo effects-bridge-transport] {
		assert equal ((do $policy $p).egress.0.to) [$resolver] $"($p)'s DNS goes past the cluster's resolver"
	}
	assert equal ($airlock.egress | skip 1 | get to | flatten | each {|t| $t.podSelector.matchLabels }) [{"cnpg.io/cluster": effects-db} (do $component airlock-mesh)]
	assert not (($airlock | to json) | str contains ipBlock)
	# The daprd: the airlock in; the bridges it calls, by port, and the world
	# but the cluster's own and the cloud's metadata addresses out.
	let mesh = (do $policy effects-airlock-mesh)
	assert equal $mesh.ingress [{from: [{podSelector: {matchLabels: (do $component airlock)}}], ports: [{port: 3500, protocol: TCP}]}]
	let peers = ($mesh.egress | skip 1 | get -o to | compact | flatten | where podSelector? != null | get podSelector.matchLabels."app.kubernetes.io/component")
	assert equal $peers [echo transport]
	let world = ($mesh.egress | last | get to)
	assert equal $world.0.ipBlock.cidr 0.0.0.0/0
	for internal in [10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8] {
		assert ($internal in $world.0.ipBlock.except) $"the daprd reaches ($internal)"
	}
	# Each bridge: the daprd in, the world out, and nothing of the cluster.
	for c in [echo transport] {
		let bridge = (do $policy $"effects-bridge-($c)")
		assert equal $bridge.ingress [{from: [{podSelector: {matchLabels: (do $component airlock-mesh)}}], ports: [{port: 8080, protocol: TCP}]}]
		assert equal ($bridge.egress | skip 1 | get -o to | compact | flatten | where podSelector? != null) []
		assert equal ($bridge.egress | last | get to) $world
	}
	# The app's own services admit its pods by name, a bridge's never: one
	# whose plugin holds it to its policy only once it runs has the database
	# and the services in reach until then. None of the three holds a token
	# for the API.
	let docs = (effects-manifests)
	let excluded = {matchLabels: {"app.kubernetes.io/name": effects}, matchExpressions: [{key: "pronto.dev/bridge", operator: DoesNotExist}]}
	# Nor does a rule open to every source, but the door's.
	for p in [effects-database-netpol effects-backends-netpol effects-ticker] {
		let open = ($docs | where kind == NetworkPolicy and metadata.name == $p | first | get spec.ingress | where {|r| ($r.from? | default []) | is-empty })
		assert equal $open [] $"($p) admits every source"
	}
	for p in [effects-database-netpol effects-backends-netpol effects-caddy-netpol effects-ticker] {
		let named = ($docs | where kind == NetworkPolicy and metadata.name == $p | first | get spec.ingress | get -o from | compact | flatten | where podSelector? == {matchLabels: {"app.kubernetes.io/name": effects}})
		assert equal $named [] $"($p) admits a bridge by the app's name"
		assert (($docs | where kind == NetworkPolicy and metadata.name == $p | first | get spec.ingress | get -o from | compact | flatten | where podSelector? == $excluded) | is-not-empty) $"($p) admits none of the app's pods by name"
	}
	for d in [effects-bridge-echo effects-bridge-transport] {
		assert equal ($docs | where kind == Deployment and metadata.name == $d | first | get spec.template.metadata.labels."pronto.dev/bridge") "true"
	}
	# A bridge's objects carry the label too, by which a later release removes
	# those of a bridge no longer on k8s.
	assert equal ($docs | where {|d| ($d.metadata.labels?."pronto.dev/bridge"? | default "") == "true" } | each {|d| $"($d.kind)/($d.metadata.name)" } | sort) [Deployment/effects-bridge-echo Deployment/effects-bridge-transport NetworkPolicy/effects-bridge-echo NetworkPolicy/effects-bridge-transport Service/echo Service/transport]
	assert equal (opaque-secret effects-bridge-echo effects {} --labels {"pronto.dev/bridge": "true"} | get metadata.labels) {"pronto.dev/bridge": "true"}
	assert ("labels" not-in (opaque-secret effects-airlock effects {} | get metadata))
	for d in [effects-airlock effects-airlock-mesh effects-bridge-echo effects-bridge-transport] {
		assert equal ($docs | where kind == Deployment and metadata.name == $d | first | get spec.template.spec.automountServiceAccountToken) false $"($d) holds a token for the API"
	}
	# The cluster's own addresses, by family, which may be public.
	let addresses = [203.0.113.7/32 198.51.100.0/24 2001:db8::7/128]
	let read = (effects-manifests --data {airlock: {clusterAddresses: $addresses, resolvers: [169.254.20.10/32]}} | where kind == NetworkPolicy)
	# DNS also goes to the resolver the kubelets name, a node-local cache's.
	for p in [effects-airlock effects-airlock-mesh effects-bridge-echo effects-bridge-transport] {
		assert equal ($read | where metadata.name == $p | first | get spec.egress.0.to) [$resolver {ipBlock: {cidr: 169.254.20.10/32}}]
	}
	for p in [effects-airlock-mesh effects-bridge-echo effects-bridge-transport] {
		let world = ($read | where metadata.name == $p | first | get spec.egress | last | get to)
		assert equal ($world.0.ipBlock.except | last 2) [203.0.113.7/32 198.51.100.0/24] $"($p) reaches the cluster's public IPv4 addresses"
		assert equal ($world.1.ipBlock.except | last) 2001:db8::7/128 $"($p) reaches the cluster's public IPv6 addresses"
	}
}

def test_wall_probes [] {
	print "test the wall is certified by probes standing as the airlock and its daprd, with the world as the control..."
	# A pod address outside every private range and every node's pod range is
	# one the release cannot keep the daprd and bridges from.
	let pods = [
		{spec: {}, status: {podIPs: [{ip: 10.244.0.7}]}}
		{spec: {}, status: {podIPs: [{ip: 203.0.113.40} {ip: "2001:db8:1::9"}]}}
		{spec: {}, status: {podIPs: [{ip: "2001:db8:2::9"}]}}
		{spec: {hostNetwork: true}, status: {podIPs: [{ip: 198.51.100.3}]}}
	]
	let ranged = [{spec: {podCIDRs: [10.244.0.0/24 "2001:db8:1::/64"]}} {spec: {}}]
	assert equal (unranged-pod-addresses $pods $ranged) [203.0.113.40 "2001:db8:2::9"]
	# The cluster's addresses: each node's and the API server's, whole-host,
	# and the nodes' pod ranges.
	let nodes = [
		{status: {addresses: [{type: InternalIP, address: 10.0.0.4} {type: ExternalIP, address: 203.0.113.7} {type: Hostname, address: node-a} {type: InternalIP, address: "2001:db8::4"}]}, spec: {podCIDRs: [10.244.0.0/24 "2001:db8:1::/64"]}}
		{status: {addresses: [{type: ExternalIP, address: 203.0.113.8}]}, spec: {podCIDR: 10.244.1.0/24}}
	]
	let slices = [{endpoints: [{addresses: [198.51.100.9]} {addresses: [203.0.113.7]}]}]
	assert equal (cluster-address-blocks $nodes $slices) [10.0.0.4/32 10.244.0.0/24 10.244.1.0/24 198.51.100.9/32 "2001:db8:1::/64" "2001:db8::4/128" 203.0.113.7/32 203.0.113.8/32]
	# A probe is held by the policies of the pod it stands for, on its node,
	# under a Job, which no ReplicaSet adopts, and is never a Service's
	# endpoint.
	let probe = (wall-probe effects effects bridge-echo echo {"pronto.dev/bridge": "true"} node-a localhost:5001/effects-airlock:latest IfNotPresent [{host: 1.1.1.1, port: 443, want: true}])
	assert equal $probe.kind Job
	assert equal $probe.metadata.name effects-wall-bridge-echo
	assert equal $probe.spec.template.metadata.labels {"app.kubernetes.io/name": effects, "app.kubernetes.io/component": echo, "pronto.dev/probe": wall, "pronto.dev/bridge": "true"}
	assert equal $probe.spec.template.spec.nodeName node-a
	assert equal $probe.spec.template.spec.automountServiceAccountToken false
	assert equal $probe.spec.template.spec.containers.0.image localhost:5001/effects-airlock:latest
	assert equal $probe.spec.template.spec.containers.0.command.0 deno
	assert equal $probe.spec.template.spec.containers.0.readinessProbe.tcpSocket.port 1
	assert equal ($probe.spec.template.spec.containers.0.env.0.value | from json) [{host: 1.1.1.1, port: 443, want: true}]
	# Each role probes what it may reach and what it may not.
	let probes = (wall-probes [echo:8080] pronto-wall-target)
	let wants = ($probes | each {|p| {($p.as): ($p.targets | each {|t| $"($t.host):($t.port)=($t.want)" })} } | reduce -f {} {|r, acc| $acc | merge $r })
	assert equal $wants {
		airlock: ["database:5432=true" "airlock-mesh:3500=true" "1.1.1.1:443=false" "pronto-wall-target:8080=false" "echo:8080=false"]
		airlock-mesh: ["1.1.1.1:443=true" "echo:8080=true" "database:5432=false" "pronto-wall-target:8080=false"]
		echo: ["1.1.1.1:443=true" "database:5432=false" "airlock-mesh:3500=false" "pronto-wall-target:8080=false"]
		wall-control: ["pronto-wall-target:8080=true" "airlock-mesh:3500=false" "airlock:9997=false" "echo:8080=false"]
	}
	assert equal ($probes | where as == echo | first | get labels) {"pronto.dev/bridge": "true"}
	# Each family the cluster runs has its world; each address its key.
	assert equal (pod-families [{status: {podIPs: [{ip: 10.244.0.4} {ip: "fd00:1::4"}]}}]) [IPv4 IPv6]
	assert equal (pod-families [{status: {podIPs: [{ip: 10.244.0.4}]}}]) [IPv4]
	let dual = (wall-probes [] pronto-wall-target --families [IPv4 IPv6] | where as == airlock-mesh | first | get targets | where want | get host)
	assert equal $dual [1.1.1.1 "2606:4700:4700::1111"]
	# Before the airlock's pods start, each role tries only what needs none
	# of them: the world and the listener.
	let before = (before-probes [echo:8080] [IPv4] | each {|p| {($p.as): ($p.targets | each {|t| $"($t.host)=($t.want)" })} } | reduce -f {} {|r, acc| $acc | merge $r })
	assert equal $before {
		airlock: ["1.1.1.1=false" "pronto-wall-target=false"]
		airlock-mesh: ["1.1.1.1=true" "pronto-wall-target=false"]
		echo: ["1.1.1.1=true" "pronto-wall-target=false"]
		wall-control: ["pronto-wall-target=true"]
	}
	# A bridge's probe tries every other bridge.
	assert equal (wall-probes [echo:8080 transport:8080] pronto-wall-target | where as == echo | first | get targets | where not want | get host) [database airlock-mesh pronto-wall-target transport]
	assert equal (wall-key {host: database, address: "fd00::a", port: 5432}) "database@fd00::a:5432"
	assert equal (wall-key {host: database, port: 5432}) "database:5432"
	# Each Job's name is its role's, which no container's name can take.
	assert equal ($probes | get job) [airlock airlock-mesh bridge-echo control]
	# The control stands outside the app, so none of its policies holds it.
	assert equal ($probes | where as == wall-control | first | get labels) {"app.kubernetes.io/name": pronto-wall-target-control}
	# The listener: open to all, outside the app's name, behind its Service.
	let target = (wall-target effects effects localhost:5001/effects-airlock:latest IfNotPresent)
	assert equal ($target | get kind) [Job Service]
	assert equal $target.0.spec.template.metadata.labels."app.kubernetes.io/name" effects-wall-target
	assert equal $target.0.spec.template.spec.containers.0.readinessProbe.tcpSocket.port 8080
	assert ("nodeName" not-in $target.0.spec.template.spec)
	assert equal $target.1.metadata.name pronto-wall-target
	assert equal $target.1.spec.selector {"app.kubernetes.io/name": effects-wall-target, "app.kubernetes.io/component": wall-target}
	# A Job's name stays within 63 characters whatever the container's.
	let long = (wall-job-name effects $"bridge-("x" | fill -c x -w 50)")
	assert (($long | str length) <= 63) $long
	assert ($long != (wall-job-name effects $"bridge-("y" | fill -c y -w 50)"))
	# Another policy selecting one of the airlock's pods is refused: policies
	# add up, so its allowances would open what the airlock's own close.
	let bridge = {"app.kubernetes.io/name": effects, "app.kubernetes.io/component": echo, "pronto.dev/bridge": "true"}
	let policies = [
		{metadata: {name: effects-bridge-echo}, spec: {podSelector: {matchLabels: {"app.kubernetes.io/name": effects, "app.kubernetes.io/component": echo}}}}
		{metadata: {name: allow-web}, spec: {podSelector: {}}}
		{metadata: {name: effects-backends-netpol}, spec: {podSelector: {matchExpressions: [{key: "app.kubernetes.io/component", operator: In, values: [crud auth]}]}}}
		{metadata: {name: no-bridges}, spec: {podSelector: {matchExpressions: [{key: "pronto.dev/bridge", operator: DoesNotExist}]}}}
		{metadata: {name: deployed}, spec: {podSelector: {matchLabels: {"app.kubernetes.io/component": echo}, matchExpressions: [{key: pod-template-hash, operator: Exists}]}}}
		{metadata: {name: database}, spec: {podSelector: {matchLabels: {"cnpg.io/cluster": effects-db}}}}
	]
	# A label a Deployment's pods carry with a value the release cannot know
	# may be what another policy selects them by.
	assert equal (foreign-policies $policies [$bridge] [effects-bridge-echo]) [allow-web deployed]
	# Before they start, any label an admission webhook might add may be: a
	# policy selecting by one the release does not give is refused too, the
	# release's own aside.
	let admitted = ($policies | append {metadata: {name: trusted}, spec: {podSelector: {matchLabels: {"security.example/trusted": "true"}}}})
	assert equal (foreign-policies $admitted [$bridge] [effects-bridge-echo database] --open) [allow-web deployed trusted]
	# A probe goes beside each ready pod, never a predecessor still draining.
	let ready = {type: Ready, status: "True"}
	let pods = [
		{metadata: {deletionTimestamp: "2026-11-16T00:00:00Z"}, spec: {nodeName: node-a}, status: {conditions: [$ready]}}
		{metadata: {}, spec: {nodeName: node-b}, status: {conditions: [$ready]}}
		{metadata: {}, spec: {nodeName: node-c}, status: {conditions: [{type: Ready, status: "False"}]}}
		{metadata: {}, spec: {nodeName: node-b}, status: {conditions: [$ready]}}
	]
	assert equal ($pods | ready-nodes) [node-b]
	# The verdict, from what each probe's rounds found.
	let key = {|t| $"($t.host):($t.port)" }
	let as_wanted = {|p| $p.targets | each {|t| {(do $key $t): (if $t.want { "reached" } else { "TimedOut" })} } | reduce -f {} {|r, acc| $acc | merge $r } }
	let found = {|tweak| $probes | each {|p| let last = (do $tweak $p.as (do $as_wanted $p)); $p | insert result {first: $last, last: $last, held: 3, crossed: []} } }
	let same = {|as, r| $r }
	let judge = {|tweak| (wall-verdict (do $found $tweak)).refusal }
	assert equal (do $judge $same) null
	let unenforced = (do $judge {|as, r| if $as == airlock { $r | upsert "1.1.1.1:443" reached } else { $r } })
	assert ($unenforced | str contains "airlock to 1.1.1.1:443") $unenforced
	assert ($unenforced | str contains "enforces no NetworkPolicy") $unenforced
	let meshed = (do $judge {|as, r| if $as == airlock-mesh { $r | upsert "database:5432" reached } else { $r } })
	assert ($meshed | str contains "airlock-mesh to database:5432") $meshed
	let bridged = (do $judge {|as, r| if $as == echo { $r | upsert "airlock-mesh:3500" reached } else { $r } })
	assert ($bridged | str contains "echo to airlock-mesh:3500") $bridged
	# A bridge whose own policy is missing reaches the listener only that
	# policy keeps it from.
	let unpoliced = (wall-verdict ((do $found {|as, r| if $as == echo { $r | upsert "pronto-wall-target:8080" reached } else { $r } }))).refusal
	assert ($unpoliced | str contains "echo to pronto-wall-target:8080") $unpoliced
	# Behind a firewall that lets nothing out, the forbidden fails whatever
	# the policies: no control, no certificate.
	let firewalled = (do $judge {|as, r| if $as != airlock { $r | upsert "1.1.1.1:443" ConnectionRefused } else { $r } })
	assert ($firewalled | str contains "cannot tell the wall from a network that lets nothing out") $firewalled
	let blind = (do $judge {|as, r| if $as == airlock { $r | reject "database:5432" } else { $r } })
	assert ($blind | str contains "airlock to database:5432 (no answer)") $blind
	# One agreeing round at the deadline is no finding.
	let fleeting = (wall-verdict ((do $found $same) | update 0.result.held 1)).refusal
	assert ($fleeting | str contains "did not hold three rounds running") $fleeting
	# The probe's own program: a round tries every target at once, so a
	# dozen that time out still hold three rounds well inside its budget.
	let dropped = (1..12 | each {|i| {host: $"10.255.255.($i)", port: 443, want: false} })
	let started = (date now)
	let ran = (with-env {PROBE_TARGETS: ($dropped | to json --raw)} { deno eval --no-config $wall_probe_program } | from json)
	assert equal $ran.held 3
	assert equal $ran.crossed []
	assert (((date now) - $started) < 60sec) "the probe tried its targets one after another"
	# Any round past the wall, the first or a later one, is a plugin that
	# starts a pod unprotected: refused, unless the environment's plugin is
	# known to.
	let late = ((do $found $same) | update 2.result.crossed ["database:5432"])
	let unprotected = (wall-verdict $late)
	assert ($unprotected.refusal | str contains "starts a pod unprotected") $unprotected.refusal
	assert equal (wall-verdict $late --late) {refusal: null, early: ["echo to database:5432"]}
}

def test_airlock_secrets [] {
	print "test an effect's secrets and a bridge's environment reach Secrets through stdin, never a manifest..."
	let app = (resolve-app ($fixtures_dir | path join effects))
	let compose = (open ($app.dir | path join compose.yaml))
	let airlock = (airlock-services $compose (open ($app.dir | path join .pronto cluster.json)))
	# Everything but the airlock's wiring and its seal keys is an effect's secret.
	assert equal $airlock.secrets [ACQUIRER_KEY]
	assert $airlock.seal
	assert equal $airlock.env {AIRLOCK_DIR: /airlock, MESH_URL: "http://airlock-mesh:3500", PORT: "9997"}
	assert equal $airlock.bridges {echo: {port: 8080, build: echo-appliance}, transport: {port: 8080, build: transport-appliance}}
	assert equal $airlock.meshEnv {}
	# The release's own environment holds an effect's secret, not compose's,
	# whose value for a simulated effect is `simulator`.
	let sealed = {ACQUIRER_KEY: sk_live_from_the_environment, AIRLOCK_SEAL_KEY: "cmVhbC1rZXk=", AIRLOCK_SEAL_KEY_PREVIOUS: ""}
	let secrets = (with-env $sealed { airlock-secrets ($compose | upsert services.airlock.environment.ACQUIRER_KEY simulator) $airlock })
	assert equal $secrets.values {ACQUIRER_KEY: sk_live_from_the_environment, AIRLOCK_SEAL_KEY: "cmVhbC1rZXk="}
	let unset = (try { with-env ($sealed | merge {ACQUIRER_KEY: ""}) { airlock-secrets $compose $airlock }; "" } catch {|e| $e.msg })
	assert ($unset | str contains "declare ACQUIRER_KEY, which this release's environment does not set") $unset
	assert ($secrets.digest =~ '^[0-9a-f]{64}$')
	assert equal $secrets.bridges.transport.values {TRANSPORT_TOKEN: tt_from_the_environment}
	assert ($secrets.bridges.echo.digest != $secrets.bridges.transport.digest)
	let payload = (opaque-secret effects-airlock effects $secrets.values)
	assert equal $payload.metadata {name: effects-airlock, namespace: effects}
	assert ($payload.stringData? == null)
	assert equal ($payload.data.ACQUIRER_KEY | decode base64 | decode utf-8) sk_live_from_the_environment
	# The blob plane's address is all of the daprd's environment the release keeps.
	let blobs = ($compose | upsert services.airlock-mesh.environment.BLOBS_S3_URL "http://rclone-s3:3900")
	assert equal (airlock-services $blobs (open ($app.dir | path join .pronto cluster.json))).meshEnv {BLOBS_S3_URL: "http://rclone-s3:3900"}
}

def test_airlock_seal [] {
	print "test the seal key comes from the release's environment, is required, and is never the development key..."
	let app = (resolve-app ($fixtures_dir | path join effects))
	let compose = (open ($app.dir | path join compose.yaml))
	let airlock = (airlock-services $compose (open ($app.dir | path join .pronto cluster.json)))
	let refusal = {|vars| try { with-env ({ACQUIRER_KEY: sk_live_from_the_environment, AIRLOCK_SEAL_KEY: "", AIRLOCK_SEAL_KEY_PREVIOUS: ""} | merge $vars) { airlock-secrets $compose $airlock }; "" } catch {|e| $e.msg } }
	assert ((do $refusal {}) | str contains "AIRLOCK_SEAL_KEY is required")
	# compose's value is the development key, however the release spells it.
	for dev in ["ZGV2LXNlYWwta2V5" "ZGV2LXNl\nYWwta2V5==" " ZGV2LXNlYWwta2V5\n"] {
		assert ((do $refusal {AIRLOCK_SEAL_KEY: $dev}) | str contains "development key") $dev
	}
	assert ((do $refusal {AIRLOCK_SEAL_KEY: "cmVhbC1rZXk=", AIRLOCK_SEAL_KEY_PREVIOUS: "ZGV2LXNlYWwta2V5"}) | str contains "development key")
	# A rotation holds the replaced key beside the new one, and rolls the airlock.
	let one = (with-env {ACQUIRER_KEY: a, AIRLOCK_SEAL_KEY: "cmVhbC1rZXk=", AIRLOCK_SEAL_KEY_PREVIOUS: ""} { airlock-secrets $compose $airlock })
	let rotated = (with-env {ACQUIRER_KEY: a, AIRLOCK_SEAL_KEY: "bmV3LWtleQ==", AIRLOCK_SEAL_KEY_PREVIOUS: "cmVhbC1rZXk="} { airlock-secrets $compose $airlock })
	assert equal $rotated.values {ACQUIRER_KEY: a, AIRLOCK_SEAL_KEY: "bmV3LWtleQ==", AIRLOCK_SEAL_KEY_PREVIOUS: "cmVhbC1rZXk="}
	assert ($one.digest != $rotated.digest)
	# Without a secret field the airlock holds no seal key, and none is asked for.
	let plain = ($compose | update services.airlock.environment {|c| $c.services.airlock.environment | reject AIRLOCK_SEAL_KEY AIRLOCK_SEAL_KEY_PREVIOUS AIRLOCK_SEAL_DEV })
	let unsealed = (airlock-services $plain (open ($app.dir | path join .pronto cluster.json)))
	assert not $unsealed.seal
	assert equal (with-env {ACQUIRER_KEY: a, AIRLOCK_SEAL_KEY: ""} { airlock-secrets $plain $unsealed }).values {ACQUIRER_KEY: a}
}

def test_airlock_refusals [] {
	print "test what the k8s release cannot deploy of the airlock is refused, not omitted..."
	let app = (resolve-app ($fixtures_dir | path join effects))
	let compose = (open ($app.dir | path join compose.yaml))
	let facts = (open ($app.dir | path join .pronto cluster.json))
	let refusal = {|f| try { do $f; "" } catch {|e| $e.msg } }
	# The AI gateway is not run: an effect reaching it on k8s is refused, and
	# an app whose effects reach it elsewhere alone releases without it.
	assert ("tsbifrost" not-in (runtime-services ($compose | upsert services.tsbifrost {image: x})))
	let gateway = (do $refusal { airlock-services $compose ($facts | upsert endpoints.k8s.charge "http://tsbifrost:4000") })
	assert ($gateway | str contains "effect charge reaches the AI gateway on k8s") $gateway
	# A bridge's container may not take a name the release's own services hold.
	for name in [redis crud-dapr pronto-wall-target] {
		let taken = (do $refusal { airlock-services ($compose | upsert services.x-appliance {image: x}) ($facts | upsert bridges.1.container $name | upsert bridges.1.build x-appliance) })
		assert ($taken | str contains $"names container ($name)") $taken
	}
	assert ((do $refusal { airlock-services ($compose | reject services.transport-appliance) $facts }) | str contains "builds no transport-appliance")
	assert ((do $refusal { airlock-services $compose ($facts | reject endpoints) }) | str contains "generate the app")
	# A null endpoint is an effect k8s has no sink for; with the policies off
	# the airlock has no wall.
	let unreached = (try { render-manifests (resolve-app ($fixtures_dir | path join unreached)).cue_path kind; "" } catch {|e| $e.msg })
	assert ($unreached | str contains "effect charge names no sink the k8s release reaches") $unreached
	let file = (mktemp -t effects.XXXXXX.json | str trim)
	{App: {networkPolicy: {enabled: false}}} | to json | save -f $file
	let unwalled = (try { render-manifests $app.cue_path kind --data $file; "" } catch {|e| $e.msg })
	rm $file
	assert ($unwalled | str contains "the airlock's wall is its NetworkPolicies") $unwalled
	# Nor an app in a namespace of the cluster's own, whose services admit
	# every pod of theirs.
	let shared = (try { effects-manifests --data {namespace: cnpg-system}; "" } catch {|e| $e.msg })
	assert ($shared | str contains "would share namespace cnpg-system") $shared
	# Nor one CloudNativePG's Services for the database hold.
	let cnpg = (try { effects-manifests --data {airlock: {bridges: {effects-db-rw: {port: 8080, build: echo-appliance}}}}; "" } catch {|e| $e.msg })
	assert ($cnpg | str contains "names container effects-db-rw, which the database's Service names") $cnpg
	# An app without effects renders no airlock.
	assert ((render-manifests (resolve-app ($fixtures_dir | path join sample)).cue_path kind) | from yaml | where {|d| $d.metadata.name =~ airlock } | is-empty)
}
