#!/usr/bin/env nu
# Tests for release-k8s module
# Run with: nu plugins/sayt/release_k8s_test.nu

use std/assert

use release.nu [
	OPERATORS
	get-operator-cache-dir
	fetch-verified
	resolve-app
	render-manifests
	read-environment
	ensure-observability
	apply-sops-secrets
]

def main [] {
	print "Running release-k8s tests...\n"

	test_operators_metadata
	test_resolve_app_by_name
	test_resolve_app_nonexistent_fails
	test_schema_jobs
	test_read_environment
	test_render_manifests_kind
	test_render_manifests_eks
	test_render_manifests_aks
	test_dapr_annotations
	test_external_secrets_manifests
	test_observability_manifests
	test_fetch_verified_checksum_mismatch
	test_fetch_verified_cache_hit
	test_release_k8s_dry_run_cli
	test_release_nu_k8s_platform_cli
	test_cloud_release_refused
	test_sayt_sh_release_k8s_cli

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

def test_resolve_app_by_name [] {
	print "test resolve-app finds golaberto..."
	let app = (resolve-app "golaberto")
	assert equal $app.name "golaberto"
	assert ($app.cue_path | path exists)

	print "test resolve-app finds truco..."
	let truco = (resolve-app "truco")
	assert equal $truco.name "truco"
	assert ($truco.cue_path | path exists)
}

def test_resolve_app_nonexistent_fails [] {
	print "test resolve-app fails loudly on nonexistent app..."
	try {
		resolve-app "does-not-exist-at-all"
		assert false "resolve-app should have failed"
	} catch { |err|
		assert ($err.msg | str contains "No release.cue for does-not-exist-at-all")
	}
}

def test_schema_jobs [] {
	print "test the schema is built by the app's own database and migrate images..."
	let app = (resolve-app "golaberto")
	let data = (mktemp -t migrate.XXXXXX.json | str trim)
	{App: {migrate: {env: {REQUIRED_TABLES: "schedule"}}}} | to json | save -f $data
	let yaml = (render-manifests $app.cue_path "kind" --data $data)
	rm $data
	# The release once compiled its own migration list, which dropped *seed*
	# files and mecha's staged steps: k8s ran a schema integrate never tested.
	assert ($yaml | str contains "name: golaberto-initdb")
	assert ($yaml | str contains "image: localhost:5001/golaberto-database:latest")
	assert ($yaml | str contains "docker_process_init_files /docker-entrypoint-initdb.d/*")
	assert ($yaml | str contains "name: golaberto-migrate")
	assert ($yaml | str contains "image: localhost:5001/golaberto-migrate:latest")
	assert ($yaml | str contains "value: schedule")
	# An app with no pgroll migrations (no migrate service) runs no migrate Job.
	assert not ((render-manifests (resolve-app "truco").cue_path "kind") | str contains "truco-migrate")
	assert not ($yaml | str contains "postInitApplicationSQLRefs")
	# One credential for postgres: CloudNativePG's superuser and owner secret is
	# the one crud, auth and the Jobs read.
	assert ($yaml | str contains "superuserSecret:\n    name: golaberto-db-postgres")
	assert not ($yaml | str contains "golaberto-db-app")
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

def test_render_manifests_kind [] {
	print "test render-manifests for Kind..."
	let app = (resolve-app "golaberto")
	let yaml = (render-manifests $app.cue_path "kind")

	assert ($yaml | str contains "kind: Cluster")
	# Every service runs the app's own compose image: CloudNativePG's stock
	# postgres lacked the plv8 mecha's database image installs.
	for svc in ["database" "crud" "electric" "auth" "caddy" "render"] {
		assert ($yaml | str contains $"localhost:5001/golaberto-($svc):latest")
	}
	assert ($yaml | str contains "postgresUID: 999")

	# CloudNativePG refuses `latest` and a bare digest ("can't detect
	# upgrades"): a release names each image by the tag and digest it pushed.
	let digest = "sha256:" + ("0" | fill -c "0" -w 64)
	let data = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: {image: {pushed: {database: {tag: "18", digest: $digest}}}}} | to json | save -f $data
	let pinned = (render-manifests $app.cue_path "kind" --data $data)
	rm $data
	assert ($pinned | str contains $"imageName: localhost:5001/golaberto-database:18@($digest)")
	assert ($pinned | str contains "image: localhost:5001/golaberto-caddy:latest")
	assert ($yaml | str contains "image: localhost:5001/golaberto-caddy:latest")
	assert ($yaml | str contains "image: localhost:5001/golaberto-auth:latest")
	assert ($yaml | str contains "name: golaberto-auth-secrets")
	assert ($yaml | str contains "name: golaberto-crud")
	assert ($yaml | str contains "name: golaberto-auth")
	assert ($yaml | str contains "name: golaberto-caddy")
	assert ($yaml | str contains "name: golaberto-electric")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "name: golaberto-gateway")
	assert ($yaml | str contains "name: golaberto-route")
	assert ($yaml | str contains "gatewayClassName: eg")
	assert ($yaml | str contains "certificateRefs:")
	assert ($yaml | str contains "- name: golaberto-tls")
	# Envoy Gateway merges every app's Gateway onto one hostPort proxy; listeners
	# scoped to the app's hostname are what keep two apps' :443 from conflicting.
	assert ($yaml | str contains "hostname: golaberto.localhost")
	assert ($yaml | str contains "value: https://golaberto.localhost")
	assert ($yaml | str contains "kind: NetworkPolicy")
	assert ($yaml | str contains "name: golaberto-caddy-netpol")
	assert ($yaml | str contains "name: golaberto-backends-netpol")
	assert ($yaml | str contains "name: golaberto-database-netpol")
	# Caddy proxies SSR routes to the short name `render`; without it every rendered page is a 502.
	assert ($yaml | str contains "image: localhost:5001/golaberto-render:latest")
	assert ($yaml | str contains "name: golaberto-render")
	assert ($yaml | str contains "name: render\n")

	let truco = (resolve-app "truco")
	let truco_yaml = (render-manifests $truco.cue_path "kind")
	assert ($truco_yaml | str contains "kind: Cluster")
	assert ($truco_yaml | str contains "name: truco-db")
	assert ($truco_yaml | str contains "name: truco-auth-secrets")
	assert ($truco_yaml | str contains "name: truco-crud")
	assert ($truco_yaml | str contains "name: truco-electric")
	assert ($truco_yaml | str contains "name: truco-auth")
	assert ($truco_yaml | str contains "name: truco-caddy")
	assert ($truco_yaml | str contains "name: truco-gateway")
	assert ($truco_yaml | str contains "name: truco-route")
	assert ($truco_yaml | str contains "gatewayClassName: eg")
	assert ($truco_yaml | str contains "image: localhost:5001/truco-caddy:latest")
	assert ($truco_yaml | str contains "image: localhost:5001/truco-auth:latest")
	assert ($truco_yaml | str contains "certificateRefs:")
	assert ($truco_yaml | str contains "- name: truco-tls")
	assert ($truco_yaml | str contains "hostname: truco.localhost")
	assert not ($truco_yaml | str contains "truco-render")
	# Caddy dials short Service names (crud, auth, electric); two apps sharing a
	# namespace would route one app's traffic to the other's backends.
	assert not ($yaml | str contains "namespace: default")
	assert not ($truco_yaml | str contains "namespace: default")
	assert ($yaml | str contains "namespace: golaberto")
	assert ($truco_yaml | str contains "namespace: truco")
}

def test_render_manifests_eks [] {
	print "test render-manifests for AWS EKS..."
	let app = (resolve-app "golaberto")
	let yaml = (render-manifests $app.cue_path "eks")

	assert ($yaml | str contains "kind: Cluster")
	assert ($yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/golaberto-caddy:latest")
	assert ($yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/golaberto-auth:latest")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "gatewayClassName: amazon-vpc-lattice")
	assert ($yaml | str contains "- golaberto.eks.internal.net")

	let truco = (resolve-app "truco")
	let truco_yaml = (render-manifests $truco.cue_path "eks")
	assert ($truco_yaml | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/truco-caddy:latest")
	assert ($truco_yaml | str contains "gatewayClassName: amazon-vpc-lattice")
	assert ($truco_yaml | str contains "- truco.eks.internal.net")
}

def test_render_manifests_aks [] {
	print "test render-manifests for Azure AKS..."
	let app = (resolve-app "golaberto")
	let yaml = (render-manifests $app.cue_path "aks")

	assert ($yaml | str contains "kind: Cluster")
	assert ($yaml | str contains "image: myacr.azurecr.io/golaberto-caddy:latest")
	assert ($yaml | str contains "image: myacr.azurecr.io/golaberto-auth:latest")
	assert ($yaml | str contains "kind: Gateway")
	assert ($yaml | str contains "kind: HTTPRoute")
	assert ($yaml | str contains "gatewayClassName: azure-alb-external")
	assert ($yaml | str contains "- golaberto.aks.internal.net")
}

def test_dapr_annotations [] {
	print "test every pod joins the dapr mesh and caddy dials through its sidecar..."
	let app = (resolve-app "golaberto")
	let yaml = (render-manifests $app.cue_path "kind")

	# Caddy's Caddyfile names upstreams by app id (dapr-app-id), the same short
	# names compose uses, so ids carry no app prefix; namespaces keep apps apart.
	for id in ["crud" "auth" "electric" "caddy" "render"] {
		assert ($yaml | str contains $"dapr.io/app-id: ($id)\n")
	}
	assert ($yaml | str contains "dapr.io/config: golaberto-dapr-config")
	assert ($yaml | str contains "name: PRONTO_MESH\n              value: localhost:3500")
	assert ($yaml | str contains "value: http://localhost:3500/v1.0/invoke/caddy/method")
	assert ($yaml | str contains "name: OTEL_DENO")
	assert ($yaml | str contains "kind: Configuration")
	assert ($yaml | str contains "endpointAddress: jaeger.observability.svc.cluster.local:4317")
	# Sidecars reach each other on daprd's internal gRPC port.
	assert ($yaml | str contains "port: 50002")
	assert ($yaml | str contains "kubernetes.io/metadata.name: dapr-system")
}

def test_external_secrets_manifests [] {
	print "test external secrets manifest emitted when externalSecrets.enabled is true..."
	let cue_code = '
package test
import (
	"bonisoft.org/plugins/pronto/k8s/schema"
	"bonisoft.org/plugins/pronto/k8s/envs"
)
App: schema.#ReleaseSpec & {
	name: "truco"
	externalSecrets: enabled: true
}
esoManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
'
	let root = (do { git rev-parse --show-toplevel } | complete | get stdout | str trim)
	let tmp = ($root | path join "plugins" "pronto" "k8s" "eso_spec.cue")
	$cue_code | save -f -r $tmp
	let yaml = (cue export --expression esoManifests --out text $tmp)
	rm -f $tmp

	assert ($yaml | str contains "kind: ExternalSecret")
	assert ($yaml | str contains "name: truco-auth-secrets")
	assert ($yaml | str contains "key: truco/PGRST_JWT_SECRET")
	assert ($yaml | str contains "key: truco/ELECTRIC_SECRET")
	assert ($yaml | str contains "key: truco/ELECTRIC_PASSWORD")
	assert not ($yaml | str contains "kind: Password")

	# Without a store, ESO generates each secret once in-cluster; no value is a
	# literal in the spec, which once shipped electric:electric on a BYPASSRLS role.
	let app = (resolve-app "golaberto")
	let kind_yaml = (render-manifests $app.cue_path "kind")
	assert ($kind_yaml | str contains "kind: Password")
	assert ($kind_yaml | str contains "name: golaberto-electric-password")
	assert ($kind_yaml | str contains "type: kubernetes.io/basic-auth")
	assert ($kind_yaml | str contains "passwordSecret:\n          name: golaberto-electric-db")
	assert ($kind_yaml | str contains "postgresql://electric:$(ELECTRIC_PASSWORD)@database")
	assert not ($kind_yaml | str contains "electric:electric")
	assert not ($kind_yaml | str contains "please-override")
}

def test_observability_manifests [] {
	print "test observability stack CUE definitions export correctly..."
	let root = (do { git rev-parse --show-toplevel } | complete | get stdout | str trim)
	let obs_cue = ($root | path join "plugins" "pronto" "k8s" "observability" "observability.cue")
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
	let bad_entry = {
		name: "test-mismatch-operator"
		url: "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml"
		checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	}

	try {
		fetch-verified $bad_entry
		assert false "fetch-verified should have failed with checksum mismatch"
	} catch { |err|
		assert ($err.msg | str contains "Checksum mismatch for test-mismatch-operator")
	}
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
	print "test plugins/pronto/k8s/release.nu --dry-run prints manifests without cluster mutation..."
	let root = (do { git rev-parse --show-toplevel } | complete | get stdout | str trim)
	let res = (do { nu ($root | path join "plugins/pronto/k8s/release.nu") --dry-run --app golaberto } | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "kind: Service")
	assert ($res.stdout | str contains "kind: Deployment")
	assert ($res.stdout | str contains "kind: Gateway")
	assert ($res.stdout | str contains "kind: HTTPRoute")
	assert ($res.stdout | str contains "localhost:5001/golaberto-caddy:latest")
}

def test_release_nu_k8s_platform_cli [] {
	print "test plugins/pronto/k8s/release.nu --dry-run -e eks renders EKS manifests..."
	let root = (do { git rev-parse --show-toplevel } | complete | get stdout | str trim)
	let res = (do {
		cd ($root | path join "apps" "golaberto")
		nu ($root | path join "plugins/pronto/k8s/release.nu") --dry-run -e eks
	} | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/golaberto-caddy:latest")
	assert ($res.stdout | str contains "gatewayClassName: amazon-vpc-lattice")
}

def test_cloud_release_refused [] {
	print "test a cloud release that would deploy is refused before touching anything..."
	let root = (git rev-parse --show-toplevel | str trim)
	# The Kind path alone provisions operators, observability and TLS; an EKS
	# release once went ahead without them.
	let res = (do { nu ($root | path join "plugins/pronto/k8s/release.nu") --app golaberto -e eks } | complete)
	assert ($res.exit_code != 0)
	assert ($res.stderr | str contains "release to eks is not implemented")
}

def test_sayt_sh_release_k8s_cli [] {
	print "test sayt.sh release@k8s --dry-run via app .say.yaml rulemap..."
	let root = (do { git rev-parse --show-toplevel } | complete | get stdout | str trim)
	let res = (do { ^($root | path join "plugins/sayt/sayt.sh") -d apps/golaberto release@k8s --dry-run } | complete)

	assert equal $res.exit_code 0
	assert ($res.stdout | str contains "localhost:5001/golaberto-caddy:latest")
	assert ($res.stdout | str contains "gatewayClassName: eg")
}
