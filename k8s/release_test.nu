#!/usr/bin/env nu
# Run with: nu k8s/release_test.nu

const pronto_dir = path self ..
const k8s_dir = path self .
const fixtures_dir = path self testdata

use std/assert

use release.nu [
	tenant-manifests
	tenant-refusals
	tenant-repo
	node-registry-manifests
	node-registry-in-use
	node-registry-keep-tag
	node-buildkit-manifests
	OPERATORS
	get-operator-cache-dir
	fetch-verified
	resolve-app
	render-manifests
	read-environment
	auth-provider-environment
	auth-provider-secret
	runtime-services
	schema-copy-steps
	release-tree
	release-override
	defines
	default-environment
	envoy-proxy
	tunnel-manifests
	app-services-environment
	seed-configmaps
	seed-fill
	apply-alert-rules
	check-backup-secrets
	sops-platform
	sops-age-key
	apply-environment-secrets
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
	test_resolve_app_by_path
	test_resolve_app_nonexistent_fails
	test_schema_jobs
	test_auth_providers
	test_auth_provider_secrets
	test_release_tree
	test_read_environment
	test_render_manifests_kind
	test_tenant_release
	test_render_manifests_eks
	test_render_manifests_metal
	test_render_ready_through_the_door
	test_app_services
	test_app_service_jail
	test_container_resources_and_files
	test_service_host
	test_service_database_login
	test_seed_configmaps
	test_alerting
	test_door_egress
	test_auth_oidc_egress
	test_service_clock
	test_metrics_export
	test_blobs
	test_initdb_replays
	test_database_backup
	test_app_services_environment
	test_pods_hand_over
	test_environment_access
	test_schema_jobs_wait_for_database
	test_release_override
	test_tunnel_manifests
	test_node_registry_manifests
	test_node_registry_in_use
	test_node_buildkit_manifests
	test_environment_build_buildkit
	test_environment_secrets
	test_envoy_proxy
	test_render_manifests_aks
	test_dapr_annotations
	test_timeout_budget_nests
	test_external_secrets_manifests
	test_observability_manifests
	test_fetch_verified_checksum_mismatch
	test_fetch_verified_cache_hit
	test_release_k8s_dry_run_cli
	test_release_nu_k8s_platform_cli
	test_cloud_release_refused
	test_preview_renders_apart
	test_preview_origin_https
	test_preview_delete_needs_a_preview
	test_preview_schema_from

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

def test_auth_oidc_egress [] {
	print "test auth may reach a sign-in provider's broker on 443 alone, and only when the app names one..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t oidc.XXXXXX.json | str trim)
	{App: {auth: {oidc: {OIDC_PROVIDERS: "google", OIDC_GOOGLE_INTERNAL: "https://id.example.com"}}}} | to json | save -f $data
	let pols = (render-manifests $app.cue_path "metal" --data $data | from yaml | where kind == "NetworkPolicy" and metadata.name == "sample-auth-oidc-egress")
	rm $data
	assert equal ($pols | length) 1
	let pol = ($pols | first)
	assert equal $pol.spec.podSelector.matchLabels."app.kubernetes.io/component" "auth"
	assert equal $pol.spec.egress.0.ports [{port: 443, protocol: "TCP"}]
	assert ("192.168.0.0/16" in $pol.spec.egress.0.to.0.ipBlock.except) "nothing private"
	# No provider, no hole: the backends' own policy is all auth has.
	assert not ((render-manifests $app.cue_path "metal") | str contains "sample-auth-oidc-egress")
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
	assert equal $split.android ""
	assert (($pod.spec.containers.0.env | where name == "WEBAUTHN_ANDROID_ORIGINS") | is-empty)
	# The app's Android certificates, as compose gives auth them, reach its pod.
	let fp = "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C"
	let android = (auth-provider-environment ($environment | insert WEBAUTHN_ANDROID_ORIGINS $fp))
	{App: {auth: ($android | reject secretValues)}} | to json | save -f $data
	let with_android = (render-manifests $app.cue_path "kind" --data $data | from yaml | where kind == "Deployment" and metadata.name == "sample-auth" | first)
	assert equal ($with_android.spec.template.spec.containers.0.env | where name == "WEBAUTHN_ANDROID_ORIGINS" | first | get value) $fp
	let rotated = (auth-provider-environment ($environment | update OIDC_GOOGLE_CLIENT_SECRET "rotated-credential"))
	assert ($rotated.oidcSecretDigest != $split.oidcSecretDigest)
	let public_client = (auth-provider-environment ($environment | update OIDC_GOOGLE_CLIENT_SECRET ""))
	assert equal $public_client.oidcSecrets []
	assert equal $public_client.oidcSecretDigest ""
	{App: {auth: {oidc: {OIDC_GOOGLE_CLIENT_SECRET: "must-be-refused"}}}} | to json | save -f $data
	let refused = (try { render-manifests $app.cue_path "kind" --data $data; false } catch {|err|
		assert ($err.msg | str contains "field not allowed")
		true
	})
	rm $data
	assert $refused
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
	assert ($yaml | str contains "docker_process_init_files /docker-entrypoint-initdb.d/!(950_fixture.sql)")
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
	# A metal cluster is the operator's: the app's release.cue gives it.
	let sample = (resolve-app ($fixtures_dir | path join "sample"))
	let minimal = (resolve-app ($fixtures_dir | path join "minimal"))
	let metal = (read-environment "metal" $sample.cue_path)
	assert equal $metal.context "home"
	assert equal $metal.build {by: "cloudbuild", project: "ops"}
	assert equal $metal.ingress.by "tunnel"
	assert equal $metal.imagePullPolicy "IfNotPresent"
	# Kind is pronto's own, whether or not the app gives a metal cluster.
	assert equal (read-environment "kind" $sample.cue_path | get build.by) "docker"
	assert equal (default-environment $sample.cue_path) "metal"
	assert equal (default-environment $minimal.cue_path) "kind"
	assert not (defines $minimal.cue_path "Metal")
}

# A node's registry listens on its loopback alone: only a release's SSH tunnel
# reaches it, never the network the node is on.
def test_node_registry_manifests [] {
	print "test node-registry-manifests listens on the node's loopback..."
	let deployment = (node-registry-manifests | from yaml | where kind == "Deployment" | first)
	let spec = $deployment.spec.template.spec
	assert $spec.hostNetwork
	let addr = ($spec.containers.0.env | where name == "REGISTRY_HTTP_ADDR" | first | get value)
	assert equal $addr "127.0.0.1:5000"
	assert ($spec.containers.0.image =~ "@sha256:[0-9a-f]{64}$")
}

def test_render_manifests_kind [] {
	print "test render-manifests for Kind..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let yaml = (render-manifests $app.cue_path "kind")

	assert ($yaml | str contains "kind: Cluster")
	let db = ($yaml | from yaml | where kind == "Cluster" | first)
	assert equal $db.spec.stopDelay 120 "a stop of the primary is bounded, not CloudNativePG's 1800 s"
	assert equal $db.spec.smartShutdownTimeout 15
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

def test_render_manifests_metal [] {
	print "test render-manifests for a metal cluster behind a tunnel..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let docs = (render-manifests $app.cue_path "metal" | from yaml)
	let caddy = ($docs | where kind == "Deployment" and metadata.name == "sample-caddy" | first)
	assert equal ($caddy.spec.template.spec.containers | where name == "caddy" | first | get image) "us-central1-docker.pkg.dev/ops/pronto/sample-caddy:latest"
	assert equal ($caddy.spec.template.spec.containers | where name == "caddy" | first | get imagePullPolicy) "IfNotPresent"
	# Cloudflare holds the certificate: the gateway listens on HTTP alone.
	let gateway = ($docs | where kind == "Gateway" | first)
	assert equal ($gateway.spec.listeners | get name) ["http"]
	assert equal ($gateway.spec.listeners.0.hostname) "sample.apps.example.com"
	assert equal ($docs | where kind == "Cluster" | first | get spec.storage.storageClass) "local-path"
	# Kind keeps its HTTPS listener.
	let kind_gateway = (render-manifests $app.cue_path "kind" | from yaml | where kind == "Gateway" | first)
	assert equal ($kind_gateway.spec.listeners | get name) ["http" "https"]
}

def test_tenant_release [] {
	print "test a tenant's release: its namespace and address alone..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t tenant.XXXXXX.json | str trim)
	{App: {tenant: "studio-ana", tenantHost: "mines-ana-games.example.com"}} | to json | save -f $data
	let docs = (render-manifests $app.cue_path "metal" --data $data | tenant-manifests "studio-ana" | from yaml)
	assert equal ($docs | where kind in ["Namespace" "NetworkPolicy"] | length) 0
	assert equal ($docs | get metadata.namespace | uniq) ["studio-ana"]
	# The objects keep the release's name: only where they live and answer changes.
	assert equal ($docs | where kind == "Cluster" | first | get metadata.name) "sample-db"
	assert equal ($docs | where kind == "Gateway" | first | get spec.listeners.0.hostname) "mines-ana-games.example.com"
	assert equal ($docs | where kind == "HTTPRoute" | first | get spec.hostnames) ["mines-ana-games.example.com"]
	# Anything outside the namespace is refused, never dropped.
	assert ((try { render-manifests $app.cue_path "metal" | tenant-manifests "studio-ana"; false } catch { true }))
	# Never a preview too.
	{App: {tenant: "studio-ana", preview: "rc"}} | to json | save -f $data
	assert ((try { render-manifests $app.cue_path "metal" --data $data; false } catch { true }))
	let built = {build: {by: "buildkit"}}
	assert equal (tenant-refusals "" "" "" $built $app.dir "metal") []
	assert equal (tenant-refusals "studio-ana" "a.example.com" "" $built $app.dir "metal" "i.json") []
	assert equal (tenant-refusals "studio-ana" "" "" $built $app.dir "metal" "i.json" | length) 1
	assert equal (tenant-refusals "" "a.example.com" "" $built $app.dir "metal" | length) 1
	assert equal (tenant-refusals "studio-ana" "a.example.com" "rc" $built $app.dir "metal" "i.json" | length) 1
	assert equal (tenant-refusals "studio-ana" "a.example.com" "" {build: {by: "node"}} $app.dir "metal" "i.json" | length) 1
	# A tenant's release builds nothing with the publisher's rights: it is given its images, or a buildkit to build them on.
	assert equal (tenant-refusals "studio-ana" "a.example.com" "" $built $app.dir "metal" "tcp://buildkitd:1234") []
	assert equal (tenant-refusals "studio-ana" "a.example.com" "" $built $app.dir "metal" | length) 1
	assert equal (tenant-refusals "" "" "" $built $app.dir "metal" "i.json" | length) 1
	# Its images are under its namespace's name, as the schema names them.
	{App: {tenant: "studio-ana", tenantHost: "mines-ana-games.example.com", image: {pushed: {caddy: {tag: "t1", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}} | to json | save -f $data
	let caddy = (render-manifests $app.cue_path "metal" --data $data | from yaml | where kind == "Deployment" and metadata.name == "sample-caddy" | first | get spec.template.spec.containers | where name == "caddy" | first | get image)
	assert equal $caddy $"us-central1-docker.pkg.dev/ops/pronto/(tenant-repo studio-ana sample caddy):t1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	rm $data
}

def test_release_override [] {
	print "test the release tree as a compose file read over the app's own..."
	let project = {services: {
		caddy: {build: {additional_contexts: {app-crud: "service:app-crud", app-served: "service:app-served", root: "/w"}}}
		render: {build: {additional_contexts: {app-served: "service:app-served"}}}
		crud: {build: {context: "/w"}}
		app-served: {build: {context: "/w"}}
		app-served-release: {build: {context: "/w"}}
	}}
	# Only what changes, so the app's own paths stay the build's.
	assert equal ($project | to yaml | release-override | from yaml) {services: {
		caddy: {build: {additional_contexts: {app-served: "service:app-served-release"}}}
		render: {build: {additional_contexts: {app-served: "service:app-served-release"}}}
	}}
	let refused = (try { $project | reject services.app-served-release | to yaml | release-override; "" } catch {|e| $e.msg })
	assert ($refused | str contains "has no app-served-release")
}

def test_render_ready_through_the_door [] {
	print "test render starts on its own health, is ready only once the door answers it, and lives on its own health..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let render = (render-manifests $app.cue_path "metal" | from yaml | where kind == "Deployment" and metadata.name == "sample-render" | first | get spec.template.spec.containers | where name == "render" | first)
	let probe = ($render.readinessProbe.exec.command | str join " ")
	assert ($probe | str contains "DOOR") "readiness reads the door"
	assert ($probe | str contains "/shell/shell.json") "readiness reads a page's shell through the door"
	assert ($probe | str contains "/health") "readiness keeps render's own health"
	assert equal $render.livenessProbe.httpGet.path "/health"
	# A pod still syncing its tables is given time to start before liveness may kill it (PRONTO-107).
	assert equal $render.startupProbe.httpGet.path "/health"
	assert (($render.startupProbe.periodSeconds * $render.startupProbe.failureThreshold) >= 120) "render may take compose's start_period to start"
}

def test_container_resources_and_files [] {
	print "test a container's own resources over the release's, and a service's files from a ConfigMap..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t resources.XXXXXX.json | str trim)
	{App: {
		containerResources: {electric: {limits: {memory: "1Gi"}}, flagd: {requests: {cpu: "20m"}}}
		services: {flagd: {port: 8693, env: {}, files: {"/etc/flags-live": "sample-flags"}}}
	}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let container = {|dep, name| $objs | where kind == "Deployment" and metadata.name == $dep | first | get spec.template.spec.containers | where name == $name | first }
	let electric = (do $container "sample-electric" "electric")
	assert equal $electric.resources.limits.memory "1Gi"
	assert equal $electric.resources.limits.cpu "500m" "the release's own where the container names none"
	assert equal $electric.resources.requests.memory "64Mi"
	assert equal (do $container "sample-crud" "crud" | get resources.limits.memory) "256Mi" "another container keeps the release's"
	let flagd = ($objs | where kind == "Deployment" and metadata.name == "sample-flagd" | first)
	let c = ($flagd.spec.template.spec.containers | where name == "flagd" | first)
	assert equal $c.resources.requests.cpu "20m"
	assert equal $c.volumeMounts [{name: "files-sample-flags", mountPath: "/etc/flags-live", readOnly: true}]
	assert equal $flagd.spec.template.spec.volumes [{name: "files-sample-flags", configMap: {name: "sample-flags"}}]
	let billing = (render-manifests $app.cue_path "metal" | from yaml | where kind == "Deployment" and metadata.name == "sample-caddy" | first)
	assert ($billing.spec.template.spec.volumes? | default [] | all {|v| not ($v.name | str starts-with "files-") }) "no files, no volumes for them"
}

def test_service_host [] {
	print "test a service's own hostname: a gateway listener, a route straight to it, its port open to the gateway, and a Secret's variable over compose's..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t host.XXXXXX.json | str trim)
	{App: {services: {
		"billing-broker": {port: 28463, host: "billing.example.com", env: {BROKER_ISSUER: "https://billing.example.com", BROKER_SECRET: "dev"}, secrets: {BROKER_SECRET: "billing-broker"}}
		analyst: {port: 8689, env: {}}
	}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let gw = ($objs | where kind == "Gateway" | first)
	let listener = ($gw.spec.listeners | where name == "host-billing-broker" | first)
	assert equal [$listener.hostname $listener.protocol $listener.port] ["billing.example.com" "HTTP" 80]
	assert equal ($gw.spec.listeners | where name == "host-analyst" | length) 0 "a service with no host gets no listener"
	let route = ($objs | where kind == "HTTPRoute" and metadata.name == "sample-billing-broker-route" | first)
	assert equal $route.spec.hostnames ["billing.example.com"]
	assert equal $route.spec.parentRefs [{name: "sample-gateway", sectionName: "host-billing-broker"}]
	assert equal ($route.spec.rules.0.backendRefs) [{name: "billing-broker", port: 28463}]
	assert equal ($objs | where kind == "HTTPRoute" | length) 2 "the app's route and the broker's"
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol" | first)
	assert ($pol.spec.ingress | any {|r| ($r.from? == null) and ($r.ports == [{port: 28463, protocol: "TCP"}]) }) "the gateway reaches the broker's port"
	let vars = ($objs | where kind == "Deployment" and metadata.name == "sample-billing-broker" | first | get spec.template.spec.containers.0.env)
	let secret = ($vars | where name == "BROKER_SECRET")
	assert equal ($secret | length) 1 "the Secret's variable alone, not compose's too"
	assert equal ($secret.0.valueFrom.secretKeyRef) {name: "billing-broker", key: "BROKER_SECRET"}
	assert equal ($vars | where name == "BROKER_ISSUER" | get value) ["https://billing.example.com"]
	let plain = (render-manifests $app.cue_path "metal" | from yaml)
	assert equal ($plain | where kind == "HTTPRoute" | length) 1 "no service host, no route of its own"
}

def test_service_database_login [] {
	print "test a service's own database login: a managed role, a generated password, its URL in the service's variable, and egress to the database..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t login.XXXXXX.json | str trim)
	{App: {
		database: {logins: {analytics_reader: {inRoles: ["analytics_viewer"]}}}
		services: {exporter: {port: 9399, env: {SQLEXPORTER_TARGET_DSN: "postgres://dev"}, database: {login: "analytics_reader", env: "SQLEXPORTER_TARGET_DSN"}}}
	}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	let role = ($objs | where kind == "Cluster" | first | get spec.managed.roles | where name == "analytics_reader" | first)
	assert equal [$role.login $role.inherit $role.inRoles $role.passwordSecret.name] [true true ["analytics_viewer"] "sample-analytics-reader-db"]
	let es = ($objs | where kind == "ExternalSecret" and metadata.name == "sample-analytics-reader-db" | first)
	assert equal $es.spec.target.template.type "kubernetes.io/basic-auth"
	assert equal $es.spec.target.template.data.username "analytics_reader"
	assert equal $es.spec.target.template.data.url "postgres://analytics_reader:{{ .ANALYTICS_READER_PASSWORD }}@database:5432/sample?sslmode=disable"
	assert equal ($objs | where kind == "Password" and metadata.name == "sample-analytics-reader-password" | length) 1 "the password is generated in-cluster"
	let vars = ($objs | where kind == "Deployment" and metadata.name == "sample-exporter" | first | get spec.template.spec.containers.0.env | where name == "SQLEXPORTER_TARGET_DSN")
	assert equal ($vars | length) 1 "the login's URL alone, not compose's too"
	assert equal $vars.0.valueFrom.secretKeyRef {name: "sample-analytics-reader-db", key: "url"}
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-exporter-database-egress" | first)
	assert equal $pol.spec.policyTypes ["Egress"]
	assert equal $pol.spec.egress [{to: [{podSelector: {matchLabels: {"cnpg.io/cluster": "sample-db"}}}], ports: [{port: 5432, protocol: "TCP"}]}]
	let stores = (mktemp -t login.XXXXXX.json | str trim)
	{App: {externalSecrets: {enabled: true}, database: {logins: {analytics_reader: {inRoles: []}}}}} | to json | save -f $stores
	let withStore = (render-manifests $app.cue_path "metal" --data $stores | from yaml | where kind == "ExternalSecret" and metadata.name == "sample-analytics-reader-db" | first)
	assert equal $withStore.spec.data [{secretKey: "ANALYTICS_READER_PASSWORD", remoteRef: {key: "sample/ANALYTICS_READER_PASSWORD"}}]
	{App: {services: {exporter: {port: 9399, env: {}, database: {login: "nobody"}}}}} | to json | save -f $data
	let bad = (try { render-manifests $app.cue_path "metal" --data $data | from yaml; false } catch { true })
	assert $bad "a login the app does not declare fails the release"
	rm $data $stores
}

def test_alerting [] {
	print "test an app's alerting rules: a vmalert of its own, and the rules written each release..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let none = (render-manifests $app.cue_path "metal" | from yaml)
	assert (($none | where metadata.name == "sample-vmalert") | is-empty) "no rules, no vmalert"
	let data = (mktemp -t alerting.XXXXXX.json | str trim)
	{App: {alerting: {rules: ["observability/journeys.rules.yaml"]}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	let dep = ($objs | where kind == "Deployment" and metadata.name == "sample-vmalert" | first)
	let c = ($dep.spec.template.spec.containers | first)
	assert ($c.args | any {|a| $a == "-datasource.url=http://vmsingle.observability.svc.cluster.local:8428" }) "it reads the cluster's VictoriaMetrics"
	assert ($c.args | any {|a| $a == "-notifier.blackhole" }) "with no notifier, alerts are kept as series"
	assert equal $dep.spec.template.spec.volumes [{name: "rules", configMap: {name: "sample-alert-rules"}}]
	{App: {services: {"journeys-collector": {port: 8686, env: {}, metrics: {port: 9598}}}}} | to json | save -f $data
	let col = (render-manifests $app.cue_path "metal" --data $data | from yaml | where kind == "Deployment" and metadata.name == "sample-journeys-collector" | first | get spec.template)
	assert equal [$col.metadata.annotations."prometheus.io/scrape" $col.metadata.annotations."prometheus.io/port" $col.metadata.annotations."prometheus.io/path"] ["true" "9598" "/metrics"] "a service's metrics are scraped"
	assert ($col.spec.containers.0.ports | any {|p| $p.containerPort == 9598 }) "its metrics port is declared, which pod discovery keeps"
	{App: {services: {exporter: {port: 9399, env: {}, metrics: {port: 9399}}}}} | to json | save -f $data
	let own = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	assert equal ($own | where kind == "Deployment" and metadata.name == "sample-exporter" | first | get spec.template.spec.containers.0.ports | length) 1 "metrics on the service's own port: the port once"
	assert equal ($own | where kind == "Service" and metadata.name == "exporter" | first | get spec.ports | length) 1 "and the Service's port once"
	{App: {alerting: {rules: ["a.rules.yaml"], notifier: "http://alertmanager.observability:9093"}}} | to json | save -f $data
	let notified = (render-manifests $app.cue_path "metal" --data $data | from yaml | where metadata.name == "sample-vmalert" | first | get spec.template.spec.containers.0.args)
	rm $data
	assert ("-notifier.url=http://alertmanager.observability:9093" in $notified and not ("-notifier.blackhole" in $notified)) "a named notifier gets the alerts"

	let dir = (mktemp -d)
	mkdir $"($dir)/bin" $"($dir)/app/observability"
	"groups: []\n" | save $"($dir)/app/observability/journeys.rules.yaml"
	let log = $"($dir)/kubectl.log"
	$"#!/bin/sh\necho \"$@\" >> ($log)\n" | save $"($dir)/bin/kubectl"
	^chmod +x $"($dir)/bin/kubectl"
	with-env {PATH: ($env.PATH | prepend $"($dir)/bin")} { apply-alert-rules "sample" ["observability/journeys.rules.yaml"] $"($dir)/app" "sample" }
	let call = (open $log | lines | where {|l| $l starts-with "create" } | first)
	assert (($call | str starts-with "create configmap sample-alert-rules -n sample --from-file=journeys.rules.yaml=") and ($call | str ends-with "/app/observability/journeys.rules.yaml --dry-run=client -o yaml")) $"the rules are written under their names: ($call)"
	let twice = (try { with-env {PATH: ($env.PATH | prepend $"($dir)/bin")} { apply-alert-rules "sample" ["a/x.yaml" "b/x.yaml"] $"($dir)/app" "sample" }; false } catch { true })
	assert $twice "two files of one name are refused"
	rm -r $dir
}

def test_database_backup [] {
	print "test a database's backups: the plugin archives its WAL to a Cloud Storage bucket, nightly base backups, signed in with no key..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let none = (render-manifests $app.cue_path "metal" | from yaml)
	assert (($none | where kind in ["ObjectStore" "ScheduledBackup"]) | is-empty) "no backup, no object store"
	assert (($none | where kind == "Cluster" | first | get spec.plugins? | default []) | is-empty) "and no archiver"
	let data = (mktemp -t backup.XXXXXX.json | str trim)
	let provider = "projects/123/locations/global/workloadIdentityPools/node/providers/k3s"
	{App: {database: {backup: {bucket: "pronto-backups", provider: $provider, serviceAccount: "backups@p.iam.gserviceaccount.com", audience: "k3s-node"}}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let store = ($objs | where kind == "ObjectStore" | first)
	assert equal $store.metadata.name "sample-backup"
	assert equal $store.spec.retentionPolicy "30d"
	assert equal $store.spec.configuration.destinationPath "gs://pronto-backups/sample"
	assert equal $store.spec.configuration.googleCredentials {gkeEnvironment: true} "Google's default credentials, no key Secret"
	assert ($store.spec.configuration.s3Credentials? == null) "no S3 keys"
	assert equal $store.spec.instanceSidecarConfiguration.env [{name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/projected/gcp-credentials.json"}]
	let creds = ($objs | where kind == "ConfigMap" and metadata.name == "sample-backup" | first | get data."credentials.json" | from json)
	assert equal $creds.type "external_account"
	assert equal $creds.audience $"//iam.googleapis.com/($provider)"
	assert equal $creds.credential_source.file "/projected/gcp-token" "the Cluster's projected token"
	assert ($creds.service_account_impersonation_url | str contains "backups@p.iam.gserviceaccount.com")
	let cluster = ($objs | where kind == "Cluster" | first)
	assert equal $cluster.spec.plugins [{name: "barman-cloud.cloudnative-pg.io", isWALArchiver: true, parameters: {barmanObjectName: "sample-backup"}}] "the plugin archives the Cluster's WAL"
	assert equal $cluster.spec.projectedVolumeTemplate.sources [
		{serviceAccountToken: {path: "gcp-token", audience: "k3s-node", expirationSeconds: 3600}}
		{configMap: {name: "sample-backup", items: [{key: "credentials.json", path: "gcp-credentials.json"}]}}
	] "the token and the credential under /projected, which the sidecar shares"
	let nightly = ($objs | where kind == "ScheduledBackup" | first)
	assert equal [$nightly.spec.cluster.name $nightly.spec.method $nightly.spec.schedule $nightly.spec.immediate] ["sample-db" "plugin" "0 0 6 * * *" true]
	let at = {|kind| $objs | enumerate | where item.kind == $kind | first | get index }
	assert ((do $at "ObjectStore") < (do $at "Cluster")) "the store is there before the Cluster names it"
	assert ((check-backup-secrets [$store] "sample") == null) "a store with no keys needs no Secret"

	print "  ...or to an S3-compatible bucket, its keys a Secret the release checks"
	let data = (mktemp -t backup.XXXXXX.json | str trim)
	{App: {database: {backup: {endpoint: "https://usc1.contabostorage.com", bucket: "pronto-backups"}}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let store = ($objs | where kind == "ObjectStore" | first)
	assert equal $store.spec.configuration.destinationPath "s3://pronto-backups/sample"
	assert equal $store.spec.configuration.endpointURL "https://usc1.contabostorage.com"
	assert equal $store.spec.configuration.s3Credentials {accessKeyId: {name: "sample-backup-s3", key: "ACCESS_KEY_ID"}, secretAccessKey: {name: "sample-backup-s3", key: "ACCESS_SECRET_KEY"}}
	assert equal $store.spec.configuration.wal.compression "gzip"
	assert ($store.spec.instanceSidecarConfiguration? == null) "no Google credential"
	assert (($objs | where kind == "ConfigMap" and metadata.name == "sample-backup") | is-empty) "no credential ConfigMap"
	let cluster = ($objs | where kind == "Cluster" | first)
	assert ($cluster.spec.projectedVolumeTemplate? == null) "no projected token"
	assert equal $cluster.spec.plugins [{name: "barman-cloud.cloudnative-pg.io", isWALArchiver: true, parameters: {barmanObjectName: "sample-backup"}}]
	let dir = (mktemp -d)
	mkdir $"($dir)/bin"
	$"#!/bin/sh\ncat \"($dir)/secret.json\" 2>/dev/null || exit 1\n" | save $"($dir)/bin/kubectl"
	^chmod +x $"($dir)/bin/kubectl"
	let check = {|| with-env {PATH: ($env.PATH | prepend $"($dir)/bin")} { check-backup-secrets [$store] "sample" } }
	assert (try { do $check; false } catch { true }) "a missing Secret is refused"
	{data: {ACCESS_KEY_ID: "YQ=="}} | to json | save -f $"($dir)/secret.json"
	assert (try { do $check; false } catch { true }) "a Secret without both keys is refused"
	{data: {ACCESS_KEY_ID: "YQ==", ACCESS_SECRET_KEY: "Yg=="}} | to json | save -f $"($dir)/secret.json"
	do $check
	rm -r $dir

	let data = (mktemp -t backup.XXXXXX.json | str trim)
	{App: {database: {backup: {endpoint: "https://usc1.contabostorage.com", bucket: "pronto-backups", provider: $provider}}}} | to json | save -f $data
	let both = (try { let out = (render-manifests $app.cue_path "metal" --data $data); "rendered" } catch { "refused" })
	rm $data
	assert equal $both "refused" "an endpoint and a provider at once are refused"
}

def test_initdb_replays [] {
	print "test initdb replays the app's own migrations over a database it already built, as on Cloud Run..."
	# A copy of sample beside it, so cue finds pronto's schema, whose facts name two migrations.
	let dir = ($fixtures_dir | path join $".replays-(random uuid)")
	cp -r ($fixtures_dir | path join "sample") $dir
	open ($dir | path join .pronto cluster.json) | upsert replays ["700_gold.sql" "780_standin.sql"] | to json | save -f ($dir | path join .pronto cluster.json)
	let job = (render-manifests ($dir | path join release.cue) "metal" | from yaml | where kind == "Job" and metadata.name == "sample-initdb" | first)
	rm -r $dir
	let script = ($job.spec.template.spec.containers.0.command | last)
	assert ($script | str contains "010_machines.sql $(cd /docker-entrypoint-initdb.d && ls [0-7][0-9][0-9]_mecha_actors.sql 2>/dev/null) 700_gold.sql 780_standin.sql; do") $"the replays follow the generated steps: ($script)"
	assert ($script | str contains "--single-transaction") "010_machines in one transaction"
	# A database built on V8's plv8 moves onto pljs before the machines' code is replayed (PRONTO-279).
	let repoint = ($script | str index-of "DO $repoint$")
	assert ($repoint > 0 and $repoint < ($script | str index-of "for step in")) $"the plv8 repoint runs before the replays: ($script)"
	assert ($script | str contains "\nSQL\n") "the repoint's heredoc ends at the start of a line"
	assert ($script | str contains "pg_available_extension_versions WHERE name = 'plv8' AND version = plv8_installed") "only a version the image lacks is repointed"
}

def test_metrics_export [] {
	print "test an app's metrics sent on to Managed Service for Prometheus, signed in through workload identity..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t mexport.XXXXXX.json | str trim)
	{App: {services: {"journeys-collector": {port: 8686, env: {}, metrics: {port: 9598}}}}} | to json | save -f $data
	let none = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	assert (($none | where metadata.name? == "sample-metrics-export") | is-empty) "no export, no collector"
	let pol = ($none | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol" | first)
	assert ($pol.spec.ingress | any {|r| ($r.from.0.namespaceSelector?.matchLabels?."kubernetes.io/metadata.name"? == "observability") and ($r.ports | any {|p| $p.port == 9598 }) }) "the cluster's VictoriaMetrics may scrape a service's metrics"
	let svc = ($none | where kind == "Service" and metadata.name == "journeys-collector" | first)
	assert ($svc.spec.ports | any {|p| $p.name == "metrics" and $p.port == 9598 }) "the Service carries the metrics port"
	{App: {
		services: {"journeys-collector": {port: 8686, env: {}, metrics: {port: 9598}}}
		metricsExport: {project: "brawl-chess", provider: "projects/504479523278/locations/global/workloadIdentityPools/contabo/providers/k3s", serviceAccount: "metrics-writer@brawl-chess.iam.gserviceaccount.com", audience: "contabo-k3s"}
	}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let cm = ($objs | where kind == "ConfigMap" and metadata.name == "sample-metrics-export" | first)
	let config = ($cm.data."config.yaml" | from yaml)
	assert equal ($config.receivers.prometheus.config.scrape_configs | first | get static_configs.0.targets) ["journeys-collector.sample.svc.cluster.local:9598"]
	assert equal $config.exporters.googlemanagedprometheus.project "brawl-chess"
	let creds = ($cm.data."credentials.json" | from json)
	assert equal $creds.audience "//iam.googleapis.com/projects/504479523278/locations/global/workloadIdentityPools/contabo/providers/k3s"
	assert ($creds.service_account_impersonation_url | str ends-with "metrics-writer@brawl-chess.iam.gserviceaccount.com:generateAccessToken")
	let dep = ($objs | where kind == "Deployment" and metadata.name == "sample-metrics-export" | first)
	assert equal $dep.spec.template.spec.serviceAccountName "sample-metrics-export"
	let token = ($dep.spec.template.spec.volumes | where name == "token" | first | get projected.sources.0.serviceAccountToken)
	assert equal $token.audience "contabo-k3s" "the token is minted for the provider's audience"
	assert (($objs | where kind == "ServiceAccount" and metadata.name == "sample-metrics-export") | is-not-empty)
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol" | first)
	assert ($pol.spec.ingress | any {|r| ($r.from.0.podSelector?.matchLabels?."app.kubernetes.io/component"? == "metrics-export") and ($r.ports | any {|p| $p.port == 9598 }) }) "the collector may scrape the metrics port"
}

def test_blobs [] {
	print "test the blob plane: rclone over a bucket and imgproxy, in the mesh, signed in through workload identity..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t blobs.XXXXXX.json | str trim)
	{App: {services: {ticker: {port: 9998, env: {}}}}} | to json | save -f $data
	let none = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	assert (($none | where metadata.name? in ["sample-rclone-s3" "sample-imgproxy" "sample-blobs" "rclone-s3" "imgproxy"]) | is-empty) "no blobs, no blob plane"
	{App: {
		services: {ticker: {port: 9998, env: {}}}
		blobs: {bucket: "brawl-chess-metal-staging-blobs", provider: "projects/504479523278/locations/global/workloadIdentityPools/contabo/providers/contabo-k3s", serviceAccount: "metal-blobs@brawl-chess.iam.gserviceaccount.com", audience: "contabo-k3s"}
	}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let rc = ($objs | where kind == "Deployment" and metadata.name == "sample-rclone-s3" | first)
	let img = ($objs | where kind == "Deployment" and metadata.name == "sample-imgproxy" | first)
	assert equal $rc.spec.template.metadata.annotations."dapr.io/app-id" "rclone-s3"
	assert equal $rc.spec.template.metadata.annotations."dapr.io/app-port" "3900"
	assert equal $img.spec.template.metadata.annotations."dapr.io/app-id" "imgproxy"
	assert equal $img.spec.template.metadata.annotations."dapr.io/app-port" "8081"
	assert equal $rc.spec.template.spec.serviceAccountName "sample-blobs"
	let c = ($rc.spec.template.spec.containers | first)
	assert equal $c.command ["rclone"]
	assert equal $c.args ["serve" "s3" "--addr=0.0.0.0:3900" "--vfs-cache-mode=off" "objects:"]
	let renv = ($c.env | reduce -f {} {|e, acc| $acc | insert $e.name $e.value })
	assert equal $renv.RCLONE_CONFIG_OBJECTS_UPSTREAMS "mecha-objects=gcs:brawl-chess-metal-staging-blobs"
	assert equal $renv.RCLONE_CONFIG_GCS_ENV_AUTH "true"
	assert equal $renv.RCLONE_CONFIG_GCS_BUCKET_POLICY_ONLY "true"
	assert equal $renv.GOOGLE_APPLICATION_CREDENTIALS "/etc/gcp/credentials.json"
	assert ($c.image | str contains "sample-rclone-s3") "built from the app's compose service"
	let cm = ($objs | where kind == "ConfigMap" and metadata.name == "sample-blobs" | first)
	let creds = ($cm.data."credentials.json" | from json)
	assert equal $creds.type "external_account"
	assert equal $creds.audience "//iam.googleapis.com/projects/504479523278/locations/global/workloadIdentityPools/contabo/providers/contabo-k3s"
	assert ($creds.service_account_impersonation_url | str ends-with "metal-blobs@brawl-chess.iam.gserviceaccount.com:generateAccessToken")
	let token = ($rc.spec.template.spec.volumes | where name == "token" | first | get projected.sources.0.serviceAccountToken)
	assert equal $token.audience "contabo-k3s" "the token is minted for the provider's audience"
	assert (($objs | where kind == "ServiceAccount" and metadata.name == "sample-blobs") | is-not-empty)
	let ienv = (($img.spec.template.spec.containers | first).env | reduce -f {} {|e, acc| $acc | insert $e.name $e.value })
	assert equal $ienv.IMGPROXY_S3_ENDPOINT "http://rclone-s3.sample.svc.cluster.local:3900"
	assert equal $ienv.IMGPROXY_ONLY_PRESETS "true"
	assert equal ($objs | where kind == "Service" and metadata.name in ["rclone-s3" "imgproxy"] | get metadata.name | sort) ["imgproxy" "rclone-s3"]
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol" | first)
	assert ($pol.spec.podSelector.matchExpressions.0.values | all {|v| $v in ["ticker" "rclone-s3" "imgproxy"] }) "the services' policy covers the blob plane"
	assert ($pol.spec.egress | any {|r| ($r.ipBlock? | is-empty) and ($r.to?.0?.ipBlock?.cidr? == "0.0.0.0/0") and ($r.ports == [{port: 443, protocol: "TCP"}]) }) "Google's APIs on 443"
	assert ($pol.spec.egress | any {|r| ($r.to?.0?.podSelector? | is-not-empty) and ($r.ports | any {|p| $p.port == 3900 }) }) "imgproxy reaches rclone"
	assert ($pol.spec.ingress | any {|r| $r.ports | any {|p| $p.port == 8081 } }) "the mesh reaches imgproxy"
}

def test_service_clock [] {
	print "test a service's clock pokes it each minute with the service token, as Cloud Scheduler pokes the ticker..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t clock.XXXXXX.json | str trim)
	{App: {services: {ticker: {port: 9998, env: {}, clock: {}}, flagd: {port: 8693, env: {}}}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let crons = ($objs | where kind == "CronJob")
	assert equal ($crons | get metadata.name) ["sample-ticker-clock"] "only the service with a clock gets one"
	let cron = ($crons | first)
	assert equal [$cron.spec.schedule $cron.spec.concurrencyPolicy] ["* * * * *" "Forbid"]
	let c = ($cron.spec.jobTemplate.spec.template.spec.containers | first)
	assert ($c.command | last | str contains "u=http://ticker.sample.svc.cluster.local:9998") ($c.command | last)
	assert ($c.command | last | str contains "-X POST -H \"Authorization: Bearer $SERVICE_JWT\" \"$u/poke?caller=k8s-cronjob\"") ($c.command | last)
	assert equal ($c.env | first | get valueFrom.secretKeyRef) {name: "sample-service-jwt", key: "SERVICE_JWT"}
	assert equal $cron.spec.jobTemplate.spec.template.metadata.labels."app.kubernetes.io/name" "sample" "the services' network policy admits it"
}

def test_door_egress [] {
	print "test the door may reach the internet on 443 alone, for an upstream a plugin names (Umami)..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let pol = (render-manifests $app.cue_path "metal" | from yaml | where kind == "NetworkPolicy" and metadata.name == "sample-caddy-netpol" | first)
	let out = ($pol.spec.egress | where {|r| ($r.to?.0?.ipBlock? | is-not-empty) })
	assert equal ($out | length) 1
	assert equal ($out.0.ports) [{port: 443, protocol: "TCP"}]
	assert ("10.0.0.0/8" in $out.0.to.0.ipBlock.except) "nothing private"
}

def test_seed_configmaps [] {
	print "test a missing ConfigMap is seeded from the app's file, and one that exists only gains what it lacks..."
	let dir = (mktemp -d)
	mkdir $"($dir)/bin" $"($dir)/app/flags"
	'{"flags": {"old": {"defaultVariant": "on"}, "new": {"defaultVariant": "off"}}}' | save $"($dir)/app/flags/flags.json"
	let log = $"($dir)/kubectl.log"
	# A stand-in kubectl: `get` finds kept-flags (old set by the operator, new missing) and full-flags
	# (already holding both); every call is logged.
	let kept = ({data: {"flags.json": ({flags: {old: {defaultVariant: "off"}}} | to json)}} | to json -r)
	let full = ({data: {"flags.json": ({flags: {old: {defaultVariant: "off"}, new: {defaultVariant: "on"}}} | to json)}} | to json -r)
	$"#!/bin/sh\necho \"$@\" >> ($log)\nif [ \"$1\" = get ]; then case \"$3\" in kept-flags\) echo '($kept)';; full-flags\) echo '($full)';; *\) exit 1;; esac; fi\n" | save $"($dir)/bin/kubectl"
	^chmod +x $"($dir)/bin/kubectl"
	with-env {PATH: ($env.PATH | prepend $"($dir)/bin")} {
		seed-configmaps {flagd: {seed: {sample-flags: "flags/flags.json", kept-flags: "flags/flags.json", full-flags: "flags/flags.json"}}, billing: {port: 8688}} $"($dir)/app" "sample"
	}
	let calls = (open $log | lines)
	assert ($calls | any {|c| $c == $"create configmap sample-flags -n sample --from-file=flags.json=($dir)/app/flags/flags.json" }) "the missing one is made from the app's file"
	assert ($calls | all {|c| not ($c | str starts-with "create configmap kept-flags") }) "one that exists is never written over"
	let patch = ($calls | where {|c| $c | str starts-with "patch configmap kept-flags" })
	assert (($patch | length) == 1) "the one that lacks a flag is patched once"
	assert ($calls | all {|c| not ($c | str starts-with "patch configmap full-flags") }) "one that lacks nothing is left alone"
	let filled = (seed-fill {flags: {old: {defaultVariant: "off"}}} {flags: {old: {defaultVariant: "on", targeting: {}}, new: {defaultVariant: "off"}}, "$schema": "x"})
	assert ($filled.flags.old == {defaultVariant: "off"}) "a flag the operator set keeps its value, and gains nothing deeper"
	assert ($filled.flags.new == {defaultVariant: "off"}) "a flag it lacks comes with the seed's default"
	assert ($filled."$schema" == "x") "a top-level key it lacks is added"
	let bad = (try { with-env {PATH: ($env.PATH | prepend $"($dir)/bin")} { seed-configmaps {flagd: {seed: {other: "nope.json"}}} $"($dir)/app" "sample" }; false } catch { true })
	assert $bad "a seed that is not there fails the release"
	rm -r $dir
}

def test_app_services [] {
	print "test an app's own service runs in the mesh beside the cluster's, reached by the door..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let none = (render-manifests $app.cue_path "metal" | from yaml)
	assert (($none | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol") | is-empty) "no services, no policy for them"
	let data = (mktemp -t services.XXXXXX.json | str trim)
	{App: {services: {billing: {port: 8688, env: {CRUD_URL: "http://localhost:3500/v1.0/invoke/crud/method", BILLING_BROKER: "https://broker.example"}}}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let dep = ($objs | where kind == "Deployment" and metadata.name == "sample-billing" | first)
	assert equal $dep.spec.template.metadata.annotations."dapr.io/app-id" "billing"
	let c = ($dep.spec.template.spec.containers | first)
	assert equal $c.image "us-central1-docker.pkg.dev/ops/pronto/sample-billing:latest"
	let vars = ($c.env | reduce -f {} {|e, acc| $acc | insert $e.name ($e.value? | default $e.valueFrom?) })
	assert equal $vars.PORT "8688"
	assert equal $vars.CRUD_URL "http://localhost:3500/v1.0/invoke/crud/method"
	assert equal $vars.ORIGIN "https://sample.apps.example.com"
	assert equal $vars.SERVICE_JWT.secretKeyRef.name "sample-service-jwt"
	assert equal ($objs | where kind == "Service" and metadata.name == "billing" | first | get spec.ports.0.port) 8688
	let caddy = ($objs | where kind == "Deployment" and metadata.name == "sample-caddy" | first | get spec.template.spec.containers | where name == "caddy" | first)
	assert (($caddy.env | where name == "PRONTO_UPSTREAM_BILLING" | first | get value) == "localhost:3500") "the door reaches it through the mesh"
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-services-netpol" | first)
	assert equal $pol.spec.podSelector.matchExpressions.0.values ["billing"]
	assert ($pol.spec.egress | any {|e| ($e.ports? | default [] | any {|p| $p.port == 443 }) }) "it reaches a broker on 443"
}

def test_app_service_jail [] {
	print "test a service may run a jail, act as a Google account, reach past the services' policy and keep scratch folders..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let data = (mktemp -t jail.XXXXXX.json | str trim)
	{App: {services: {
		builder: {
			port: 8690
			jail: true
			google: {provider: "projects/1/locations/global/workloadIdentityPools/contabo/providers/contabo-k3s", serviceAccount: "studio-run@p.iam.gserviceaccount.com", audience: "contabo-k3s"}
			egress: [{cidr: "203.0.113.7/32", port: 6443}, {cidr: "0.0.0.0/0", except: ["10.0.0.0/8"], port: 80}]
			scratch: {"/workspace": "20Gi"}
		}
		billing: {port: 8688}
	}}} | to json | save -f $data
	let objs = (render-manifests $app.cue_path "metal" --data $data | from yaml)
	rm $data
	let pod = ($objs | where kind == "Deployment" and metadata.name == "sample-builder" | first | get spec.template.spec)
	assert equal $pod.hostUsers false "its root is no one on the node"
	assert equal $pod.securityContext {appArmorProfile: {type: "Unconfined"}, seccompProfile: {type: "Unconfined"}}
	let c = ($pod.containers | first)
	assert equal $c.securityContext.procMount "Unmasked"
	assert equal $pod.serviceAccountName "sample-builder"
	assert (($objs | where kind == "ServiceAccount" and metadata.name == "sample-builder") | is-not-empty)
	assert equal ($c.volumeMounts | where mountPath == "/var/run/secrets/gcp" | first | get readOnly) true
	assert equal ($pod.volumes | where name == "google-token" | first | get projected.sources.0.serviceAccountToken.audience) "contabo-k3s"
	let ws = ($c.volumeMounts | where mountPath == "/workspace" | first | get name)
	assert equal ($pod.volumes | where name == $ws | first | get emptyDir.sizeLimit) "20Gi"
	let pol = ($objs | where kind == "NetworkPolicy" and metadata.name == "sample-builder-egress" | first)
	assert equal $pol.spec.podSelector.matchLabels."app.kubernetes.io/component" "builder"
	assert equal $pol.spec.egress.0 {to: [{ipBlock: {cidr: "203.0.113.7/32"}}], ports: [{port: 6443, protocol: "TCP"}]}
	assert equal $pol.spec.egress.1.to.0.ipBlock.except ["10.0.0.0/8"]
	# A service that asks for none of it gets none.
	let plain = ($objs | where kind == "Deployment" and metadata.name == "sample-billing" | first | get spec.template.spec)
	assert (($plain | get -o hostUsers) == null) "no user namespace"
	assert (($plain | get -o serviceAccountName) == null) "no account of its own"
	assert (($plain.containers.0 | get -o securityContext) == null)
	assert (($objs | where kind == "NetworkPolicy" and metadata.name == "sample-billing-egress") | is-empty)
}

def test_app_services_environment [] {
	print "test an app's own service's environment is compose's, its peers through the mesh, under release.cue's..."
	let compose = {services: {
		crud: {environment: {}}
		"billing-broker": {environment: {}}
		billing: {environment: {CRUD_URL: "http://crud:3000", BILLING_BROKER: "http://billing-broker:28463", BILLING_DOCUMENT: "{}", SERVICE_JWT: "dev", PORT: "8688", ORIGIN: "https://localhost"}}
	}}
	let given = (app-services-environment $compose ["billing"] {billing: ["BILLING_BROKER"]})
	assert equal $given {billing: {env: {CRUD_URL: "http://localhost:3500/v1.0/invoke/crud/method", BILLING_DOCUMENT: "{}"}}}
}

def test_pods_hand_over [] {
	print "test a replaced pod keeps serving while the mesh learns of its successor..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let docs = (render-manifests $app.cue_path "metal" | from yaml | where kind == "Deployment")
	for c in ["crud" "electric" "auth" "caddy" "render"] {
		let d = ($docs | where metadata.name == $"sample-($c)" | first)
		assert equal ($d.spec.template.spec.containers | where name == $c | first | get lifecycle.preStop.sleep.seconds) 15 $"($c) pauses before it stops"
		assert equal ($d.spec.template.metadata.annotations | get "dapr.io/block-shutdown-duration") "20s" $"($c)'s sidecar outlasts the pause"
	}
}

def test_environment_access [] {
	print "test an environment's access names an SSH target..."
	let schema = ($k8s_dir | path join "schema" "release.cue")
	let check = {|v| do { $v | ^cue vet -c $schema -d "#Environment" json: - } | complete }
	let base = {name: "metal", registry: "r", gatewayClassName: "eg", storageClass: "s", imagePullPolicy: "IfNotPresent", domainSuffix: "d"}
	assert equal (($base | merge {access: {ssh: "pronto@144.91.92.217"}} | to json | do $check $in).exit_code) 0
	assert equal (($base | to json | do $check $in).exit_code) 0 "access is optional"
	assert (($base | merge {access: {ssh: "144.91.92.217"}} | to json | do $check $in).exit_code != 0) "a target names its user"
}

def test_tunnel_manifests [] {
	print "test the tunnel carries every request to the gateway's named Service..."
	let docs = (tunnel-manifests "6ff42ae2-765d-4adf-8112-31c55c1551ef" | from yaml)
	let config = ($docs | where kind == "ConfigMap" | first | get data."config.yaml" | from yaml)
	assert equal $config.tunnel "6ff42ae2-765d-4adf-8112-31c55c1551ef"
	assert equal $config.ingress [{service: "http://pronto-gateway.envoy-gateway-system.svc.cluster.local:80"}]
	let deployment = ($docs | where kind == "Deployment" | first)
	let container = ($deployment.spec.template.spec.containers | first)
	assert ($container.image =~ '^cloudflare/cloudflared:[0-9.]+@sha256:[0-9a-f]{64}$')
	assert equal ($deployment.spec.template.spec.volumes | where name == "credentials" | first | get secret.secretName) "tunnel-credentials"
}

def test_envoy_proxy [] {
	print "test the tunnel's proxy is a Service by name, under the class eg..."
	let docs = (envoy-proxy "tunnel-proxy" {envoyService: {type: "ClusterIP", name: "pronto-gateway"}} | from yaml)
	assert equal ($docs | get kind) ["EnvoyProxy" "GatewayClass"]
	assert equal ($docs.0.spec.provider.kubernetes.envoyService.name) "pronto-gateway"
	assert equal ($docs.1.metadata.name) "eg"
	assert equal ($docs.1.spec.parametersRef.name) "tunnel-proxy"
}

def test_schema_jobs_wait_for_database [] {
	print "test each schema job begins once the database answers it..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let jobs = (render-manifests $app.cue_path "metal" | from yaml | where kind == "Job")
	assert ($jobs | is-not-empty)
	for job in $jobs {
		let wait = ($job.spec.template.spec.initContainers | first)
		assert equal $wait.name "database-ready"
		assert ($wait.command | last | str contains "pg_isready")
		assert equal ($wait.env | where name == "PGHOST" | first | get value) "database"
	}
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
	# Nothing in the mesh: a sidecar timeout that fires mid-response panics daprd
	# (dapr/dapr#10371); a breaker opens on clients' 401s and shapes' 409s; a retry
	# replays a write. The hops are bounded outside it (gateway, caddy, render, Postgres).
	assert ($resiliency.policies.timeouts? == null)
	assert ($resiliency.targets.apps? == null)
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
	# Its samples outlive the pod (PRONTO-189).
	let vm = ($yaml | from yaml)
	assert equal ($vm | where kind == PersistentVolumeClaim | get metadata.name) [vmsingle-data]
	let vmd = ($vm | where kind == Deployment and metadata.name == vmsingle | first).spec
	assert equal $vmd.strategy.type Recreate
	assert ($vmd.template.spec.containers.0.volumeMounts | any {|m| $m.name == "data" and $m.mountPath == "/vmsingle-data" })
	assert equal ($vmd.template.spec.volumes | where name == data | first).persistentVolumeClaim.claimName vmsingle-data
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
	# VictoriaMetrics reaches any pod's metrics port (an app's collector, an exporter), not a fixed list.
	let pol = ($yaml | split row "---" | each { from yaml } | where {|o| ($o.kind? == "NetworkPolicy") and ($o.metadata.name? == "observability-netpol") } | first)
	assert ($pol.spec.egress | any {|e| ($e.to? == [{namespaceSelector: {}}]) and ($e.ports? == null) }) "scrapes reach every pod of the cluster"
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
	let res = (do { nu ($k8s_dir | path join "release.nu") --dry-run --app ($fixtures_dir | path join "minimal") } | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "kind: Service")
	assert ($res.stdout | str contains "kind: Deployment")
	assert ($res.stdout | str contains "kind: Gateway")
	assert ($res.stdout | str contains "kind: HTTPRoute")
	assert ($res.stdout | str contains "localhost:5001/minimal-caddy:latest")
	# An app that gives a metal cluster releases there when not told otherwise,
	# and to Kind when told.
	let metal = (do { nu ($k8s_dir | path join "release.nu") --dry-run --app ($fixtures_dir | path join "sample") } | complete)
	assert ($metal.stdout | str contains "us-central1-docker.pkg.dev/ops/pronto/sample-caddy:latest")
	let kind = (do { nu ($k8s_dir | path join "release.nu") --dry-run --app ($fixtures_dir | path join "sample") -e kind } | complete)
	assert ($kind.stdout | str contains "localhost:5001/sample-caddy:latest")
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
	assert equal $runtime.feldera.databaseEnvironment [FELDERA_DATABASE_URL]
	assert not (($runtime | to json) | str contains "dev-password")
	assert not ("FELDERA_DATABASE_URL" in $runtime.feldera.env)
	# Feldera expands its connector credential in its own process. Both pods
	# must read the operator's password rather than the Compose development URI.
	for target in [kind gke] {
		let rendered = (render-manifests $app.cue_path $target)
		assert not ($rendered | str contains "dev-password")
		let deployments = ($rendered | from yaml | where kind == Deployment)
		for service in [{name: compute, database: DATABASE_URL}, {name: feldera, database: FELDERA_DATABASE_URL}] {
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
	for name in [compute feldera conduit redis transform] {
		let spec = ($deployments | where metadata.name == $"native-($name)" | first | get spec)
		assert equal $spec.replicas 1
		assert equal $spec.strategy.type "Recreate"
	}
	assert equal ($docs | where kind == "PersistentVolumeClaim" | get metadata.name | sort) [native-compute native-feldera native-redis]
	let compute = ($deployments | where metadata.name == native-compute | first | get spec.template.spec.containers.0.env)
	assert equal ($compute | where name == SERVICE_JWT | first | get valueFrom.secretKeyRef.name) native-service-token
	assert equal ($compute | where name == FELDERA_URL | first | get value) "http://feldera:8080"
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

def test_preview_renders_apart [] {
	print "test a preview is the release under another name: its own namespace, no public name, no backups..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let base = (render-manifests $app.cue_path metal)
	let overlay = (mktemp -t preview.XXXXXX.json | str trim)
	# The sample gives no backup: this one does, to show a preview takes none.
	{App: {preview: rc, database: {backup: {bucket: "sample-backups", endpoint: "https://s3.example.com"}}}} | to json | save -f $overlay
	let kept = (mktemp -t kept.XXXXXX.json | str trim)
	{App: {database: {backup: {bucket: "sample-backups", endpoint: "https://s3.example.com"}}}} | to json | save -f $kept
	let released = (render-manifests $app.cue_path metal --data $kept | from yaml)
	let preview = (render-manifests $app.cue_path metal --data $overlay | from yaml)
	rm $overlay $kept
	assert equal ($released | where kind == "Namespace" | get metadata.name) [sample]
	assert equal ($preview | where kind == "Namespace" | get metadata.name) [sample-rc]
	# Every namespaced object is in the preview's namespace, and none keeps the release's name.
	let namespaced = ($preview | where {|d| ($d.metadata?.namespace? | is-not-empty) })
	assert equal ($namespaced | get metadata.namespace | uniq) [sample-rc]
	assert equal ($preview | where kind in ["Deployment" "Service"] | get metadata.name | where {|n| $n starts-with "sample-" and not ($n starts-with "sample-rc") }) []
	# A preview runs the release's own images, by the same names: none is named for the preview.
	let images = {|docs| $docs | each {|d| ($d.spec?.template?.spec?.containers? | default []) | get -o image | compact } | flatten | append ($docs | where kind == "Cluster" | get -o spec.imageName | compact) | uniq | sort }
	assert equal (do $images $preview) (do $images $released)
	# The released one backs its database up; the preview does neither the store nor the schedule.
	assert ($released | where kind == "ObjectStore" | is-not-empty)
	assert equal ($preview | where kind in ["ObjectStore" "ScheduledBackup"]) []
	# No public name: its host is its own, and its origin the port-forwarded door's, with a passkey rp of localhost.
	assert ((($base | from yaml | where kind == "Gateway" | get 0.spec.listeners.0.hostname)) == "sample.apps.example.com")
	assert equal ($preview | where kind == "Gateway" | get 0.spec.listeners.0.hostname) "sample-rc.apps.example.com"
	let text = ($preview | to yaml)
	assert ($text | str contains "http://localhost:18080")
	assert not ($text | str contains "https://sample.apps.example.com")
}

def test_preview_origin_https [] {
	print "test a preview may say it is reached over https at localhost, behind a local TLS front, and nowhere else..."
	let app = (resolve-app ($fixtures_dir | path join "sample"))
	let overlay = (mktemp -t preview-https.XXXXXX.json | str trim)
	{App: {preview: rc, previewOrigin: "https://localhost:18443"}} | to json | save -f $overlay
	let text = (render-manifests $app.cue_path metal --data $overlay)
	rm $overlay
	assert ($text | str contains "https://localhost:18443")
	assert not ($text | str contains "http://localhost:18080")
	let bad = (mktemp -t preview-bad.XXXXXX.json | str trim)
	{App: {preview: rc, previewOrigin: "https://evil.example:443"}} | to json | save -f $bad
	let refused = (try { render-manifests $app.cue_path metal --data $bad | ignore; false } catch { true })
	rm $bad
	assert $refused
}

def test_preview_delete_needs_a_preview [] {
	print "test --delete is refused without --preview, so a release is never deleted from here..."
	let res = (do { nu ($k8s_dir | path join "release.nu") --app ($fixtures_dir | path join "sample") --delete } | complete)
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "--delete removes a preview")
}

def test_node_registry_in_use [] {
	print "test a prune keeps every node-registry digest the cluster names, and only those..."
	let objects = ({items: [
		{spec: {containers: [{image: "127.0.0.1:5000/app-render:latest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {image: "daprio/daprd:1.15"}]}}
		{spec: {template: {spec: {containers: [{image: "127.0.0.1:5000/app-render@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}}}}
		{spec: {imageName: "127.0.0.1:5000/app-database:18@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
		{spec: {containers: [{image: "127.0.0.1:5000/app-crud:latest"} {image: "us-docker.pkg.dev/p/r/x@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}}
		{spec: {containers: [{image: "127.0.0.1:5000/app-render:latest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}
	]} | to json)
	assert equal (node-registry-in-use $objects) [
		{repo: "app-render", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
		{repo: "app-render", digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
		{repo: "app-database", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	]
	assert equal (node-registry-keep-tag "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") "keep-bbbbbbbbbbbbbbbb"
}

def test_node_buildkit_manifests [] {
	print "test the node's builder is rootless, on the node's loopback, pushing to its registry over HTTP..."
	let docs = (node-buildkit-manifests | from yaml)
	let spec = ($docs | where kind == "Deployment" | first | get spec.template.spec)
	assert $spec.hostNetwork
	let c = ($spec.containers | first)
	assert ($c.image =~ '^moby/buildkit:v[0-9.]+-rootless@sha256:[0-9a-f]{64}$')
	assert equal $c.securityContext.runAsUser 1000
	assert ("--net=host" in $c.command)
	let addr = ($c.args | skip until {|a| $a == "--addr" } | get 1)
	assert equal $addr "tcp://127.0.0.1:1234"
	let toml = ($docs | where kind == "ConfigMap" | first | get data."buildkitd.toml")
	assert ($toml | str contains '[registry."127.0.0.1:5000"]')
	assert ($toml | str contains "http = true")
	let role = ($docs | where kind == "ClusterRole" | first)
	assert equal ($role.rules | where {|r| "pods/portforward" in $r.resources } | get verbs.0) ["create"]
}

def test_environment_build_buildkit [] {
	print "test build.by buildkit needs no SSH and pushes to the node's registry..."
	let schema = ($k8s_dir | path join "schema" "release.cue")
	let base = {name: "metal", gatewayClassName: "eg", storageClass: "s", imagePullPolicy: "IfNotPresent", domainSuffix: "d"}
	let check = {|v| do { $v | ^cue vet -c $schema -d "#Environment" json: - } | complete }
	assert equal (($base | merge {build: {by: "buildkit"}, registry: "127.0.0.1:5000"} | to json | do $check $in).exit_code) 0
	assert (($base | merge {build: {by: "buildkit"}, registry: "us-docker.pkg.dev/p/r"} | to json | do $check $in).exit_code != 0) "buildkit pushes to the node's registry alone"
}

def test_environment_secrets [] {
	print "test a released environment's secrets: the pinned sops names this machine, SOPS_AGE_KEY wins, no file applies nothing..."
	assert ((sops-platform) =~ '^(darwin|linux)\.(amd64|arm64)$')
	assert equal (with-env {SOPS_AGE_KEY: "AGE-SECRET-KEY-1TEST"} { sops-age-key }) "AGE-SECRET-KEY-1TEST"
	let dir = (mktemp -d)
	# No secrets.metal.enc.yaml: returns before fetching sops, reading a key or calling kubectl.
	assert equal (with-env {PATH: []} { apply-environment-secrets $dir "metal" "ns" }) null
	let entry = {name: "sops-test", ext: "bin", url: "https://example.invalid/not-called", checksum: $"sha256:("x" | hash sha256)"}
	"x" | save -f -r ((get-operator-cache-dir) | path join "sops-test.bin")
	assert equal (fetch-verified $entry) ((get-operator-cache-dir) | path join "sops-test.bin")
	rm -r $dir
}

# A preview's database starts as production's schema (--schema-from): roles without passwords, the
# objects with their owners, pgroll's rows and initdb's marker, each read from the released primary
# and loaded into the preview's, and never into a release's own database.
def test_preview_schema_from [] {
	print "test --schema-from copies production's schema, not its rows, into a preview only..."
	let source = {namespace: "brawl-chess", pod: "brawl-chess-db-1", database: "app"}
	let target = {namespace: "brawl-chess-rc", pod: "brawl-chess-rc-db-1", database: "app"}
	let steps = (schema-copy-steps $source $target --pgroll)
	assert equal ($steps | get what) ["roles" "schema" "pgroll" "initdb marker"]
	assert ($steps | all {|s| ($s.from | take 5) == [kubectl exec -i -n brawl-chess] and ($s.into | take 5) == [kubectl exec -i -n brawl-chess-rc] })
	let roles = ($steps | where what == roles | first)
	assert ("--no-role-passwords" in $roles.from) "a preview never holds production's password hashes"
	assert (not $roles.strict) "the preview's own roles exist already"
	let schema = ($steps | where what == schema | first)
	assert ("--schema-only" in $schema.from)
	assert (not ("--no-owner" in $schema.from)) "objects keep production's owners, whose roles were copied"
	assert ($steps | where what != roles | all {|s| $s.strict and ("ON_ERROR_STOP=1" in $s.into) })
	assert ("--data-only" in ($steps | where what == pgroll | first).from)
	assert ("--schema=pgroll" in ($steps | where what == pgroll | first).from)
	assert (($steps | where what == "initdb marker" | first).from | last | str contains "COMMENT ON DATABASE %I IS %L;', 'app'")
	assert equal (schema-copy-steps $source $target | get what) ["roles" "schema" "initdb marker"]
	let res = (do { nu ($k8s_dir | path join "release.nu") --app ($fixtures_dir | path join "sample") --schema-from brawl-chess } | complete)
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "--schema-from copies a schema into a preview")
}
