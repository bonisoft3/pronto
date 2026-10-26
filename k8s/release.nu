# release.nu — Kubernetes release engine with immutable verified operators
#
# Cluster & operator lifecycle powered by kind + ctlptl and verified remote manifests.
# No vendored operator YAMLs in git; remote manifests are pinned to immutable URLs
# with SHA256 checksums verified before execution (ADD --checksum pattern).

# Immutable operator manifests with SHA256 checksums
# This engine's own directory: cluster.yaml, envs/, schema/ and observability/
# sit beside it wherever pronto is installed, monorepo or mirror.
const k8s_dir = path self .

export const OPERATORS = [
	{
		name: "gateway-api-crds"
		url: "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml"
		checksum: "sha256:97598bf6ab3b33b9b5c5432bdd24de091e4e9c3aa0575ebb0710a2a19cd64d64"
	},
	{
		name: "envoy-gateway"
		url: "https://github.com/envoyproxy/gateway/releases/download/v1.2.4/install.yaml"
		checksum: "sha256:5554f17067ccca2981465d31c158ae1cb6a7e4a9d045572334bbfdf9ec3a2040"
		namespace: "envoy-gateway-system"
		check_deployments: ["envoy-gateway"]
	},
	{
		name: "cnpg"
		url: "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.25.0/cnpg-1.25.0.yaml"
		checksum: "sha256:540325612313f775b624a444c217c4c1851269c043f72ca73dbcf6aff433dcb4"
		namespace: "cnpg-system"
		check_deployments: ["cnpg-controller-manager"]
	},
	{
		name: "external-secrets"
		url: "https://github.com/external-secrets/external-secrets/releases/download/helm-chart-0.10.5/external-secrets-0.10.5.tgz"
		checksum: "sha256:5cf78ad97d7f3dfe596bbc1b58afc5043d7ee34f80b1354941bc4f0741442811"
		kind: "helm"
		namespace: "external-secrets"
		check_deployments: ["external-secrets"]
	},
	{
		name: "dapr"
		url: "https://dapr.github.io/helm-charts/dapr-1.14.4.tgz"
		checksum: "sha256:97f64b80b3809356a5dae84b07684d4ed81ce57d371acbe7013bbc157c614795"
		kind: "helm"
		namespace: "dapr-system"
		# The injector admits pods without their sidecar while it is down (failurePolicy Ignore).
		check_deployments: ["dapr-operator" "dapr-sentry" "dapr-sidecar-injector"]
		# The chart grants secret reads in `default`; apps live in their own namespaces.
		set: ["dapr_rbac.secretReader.enabled=false"]
	}
]

# Cache directory for downloaded operator manifests
export def get-operator-cache-dir []: nothing -> string {
	let base = if ($nu.os-info.name == 'windows') {
		$env.LOCALAPPDATA | path join "sayt"
	} else {
		if ($env.XDG_CACHE_HOME? | is-not-empty) {
			$env.XDG_CACHE_HOME | path join "sayt"
		} else {
			$env.HOME | path join ".cache" "sayt"
		}
	}
	$base | path join "k8s" "operators"
}

# Fetch remote resource with mandatory SHA256 checksum verification
export def fetch-verified [entry: record]: nothing -> string {
	let cache_dir = (get-operator-cache-dir)
	mkdir $cache_dir

	let is_helm = ($entry.kind? | default "") == "helm"
	let ext = if $is_helm { "tgz" } else { "yaml" }
	let cache_file = $cache_dir | path join $"($entry.name).($ext)"
	let expected_hash = $entry.checksum | str replace --regex "^sha256:" ""

	if ($cache_file | path exists) {
		let cached_hash = (open --raw $cache_file | hash sha256)
		if $cached_hash == $expected_hash {
			return $cache_file
		}
		rm -f $cache_file
	}

	print $"Fetching ($entry.name) from ($entry.url)..."
	let data = (http get --raw $entry.url)
	let actual_hash = ($data | hash sha256)

	if $actual_hash != $expected_hash {
		error make {
			msg: $"Checksum mismatch for ($entry.name)!\nURL:      ($entry.url)\nExpected: sha256:($expected_hash)\nActual:   sha256:($actual_hash)"
		}
	}

	$data | save -f -r $cache_file
	print $"  Verified sha256:($actual_hash)"
	$cache_file
}

# Ensure Kind cluster and registry exist via ctlptl
export def ensure-cluster [] {
	ctlptl apply -f ($k8s_dir | path join "cluster.yaml")
}

# Ensure operators are installed with verified checksums
export def ensure-operators [
	--timeout: string = "90s"
] {
	for entry in $OPERATORS {
		if ($entry.namespace? | is-not-empty) {
			kubectl create namespace $entry.namespace --dry-run=client -o yaml | kubectl apply -f -
		}

		let file = (fetch-verified $entry)
		if ($entry.kind? | default "") == "helm" {
			# Split as text: a YAML round trip through nu rewrites values kubectl then rejects.
			let docs = (helm template $entry.name $file --include-crds --namespace $entry.namespace ...($entry.set? | default [] | each { [--set $in] } | flatten) | split row --regex '(?m)^---\s*$' | where ($it | str trim | is-not-empty))
			let is_crd = {|d| $d =~ '(?m)^kind:\s*CustomResourceDefinition\s*$' }
			# A chart's own custom resources map only once its CRDs are established.
			let crds = ($docs | where {|d| do $is_crd $d })
			if ($crds | is-not-empty) {
				$crds | str join "\n---\n" | kubectl apply --server-side --force-conflicts -f -
				kubectl wait --for=condition=Established $"--timeout=($timeout)" crd --all
			}
			# helm template leaves namespace off objects that do not set it; the chart's namespace is theirs.
			$docs | where {|d| not (do $is_crd $d) } | str join "\n---\n" | kubectl apply -n $entry.namespace --server-side --force-conflicts --validate=false -f -
		} else {
			kubectl apply --server-side --force-conflicts --validate=false -f $file
		}

		for d in ($entry.check_deployments? | default []) {
			print $"Waiting for deployment ($d) in ($entry.namespace)..."
			kubectl rollout status $"deployment/($d)" -n $entry.namespace $"--timeout=($timeout)"
		}
	}

	ensure-envoy-gateway-class
}

# Ensure Envoy Gateway GatewayClass and hostPort proxy configuration for Kind
export def ensure-envoy-gateway-class [] {
	let eg_config = "apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: hostport-proxy
  namespace: envoy-gateway-system
spec:
  mergeGateways: true
  telemetry:
    tracing:
      provider:
        type: OpenTelemetry
        host: jaeger.observability.svc.cluster.local
        port: 4317
  provider:
    type: Kubernetes
    kubernetes:
      envoyDaemonSet:
        patch:
          type: StrategicMerge
          value:
            spec:
              template:
                spec:
                  nodeSelector:
                    ingress-ready: \"true\"
                  containers:
                    - name: envoy
                      ports:
                        - containerPort: 10080
                          hostPort: 80
                          protocol: TCP
                        - containerPort: 10443
                          hostPort: 443
                          protocol: TCP
      envoyService:
        type: ClusterIP
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: hostport-proxy
    namespace: envoy-gateway-system
"
	$eg_config | kubectl apply -f -
}

# Ensure VictoriaMetrics, Jaeger, and Vector observability stack
export def ensure-observability [
	domain_suffix: string     # telemetry is served at telemetry.<domain_suffix>
	--timeout: string = "90s"
] {
	let resolved_path = ($k8s_dir | path join "observability" "observability.cue")
	print "Ensuring observability stack (VictoriaMetrics + Jaeger + Vector)..."
	let expr = $"\(#ObservabilityStack & {domainSuffix: \"($domain_suffix)\"}\).manifests"
	let res = (do { cue export --expression $expr --out text $resolved_path } | complete)
	if $res.exit_code != 0 {
		error make { msg: $"Failed to render observability manifests: ($res.stderr)" }
	}
	$res.stdout | kubectl apply -f -

	print "Waiting for observability deployments..."
	kubectl rollout status deployment/vmsingle -n observability $"--timeout=($timeout)"
	kubectl rollout status deployment/jaeger -n observability $"--timeout=($timeout)"
	kubectl rollout status deployment/vector -n observability $"--timeout=($timeout)"
}

# Decrypt and apply SOPS-encrypted secrets if present
export def apply-sops-secrets [app_dir: string, namespace: string] {
	let enc_file = ($app_dir | path join "secrets.enc.yaml")
	if not ($enc_file | path exists) { return }
	print $"Decrypting and applying SOPS secrets from ($enc_file) to ($namespace)..."
	^sops -d $enc_file | kubectl apply -n $namespace -f -
}

# Resolve application to release
export def resolve-app [app_arg?: string]: nothing -> record {
	let dir = if ($app_arg | is-empty) {
		$env.PWD
	} else if ($app_arg | path join "release.cue" | path exists) {
		$app_arg | path expand
	} else {
		# By name, inside the monorepo.
		git rev-parse --show-toplevel | str trim | path join "apps" $app_arg
	}
	let cue_path = ($dir | path join "release.cue")
	if not ($cue_path | path exists) {
		error make { msg: $"No release.cue for ($app_arg | default $env.PWD): run from an app directory or pass --app" }
	}
	{ name: ($dir | path basename), cue_path: $cue_path, dir: $dir }
}

# Ensure TLS secret for Ingress HTTPS support
# A mkcert certificate for the app's gateway hostname, from the CA its launch
# already trusts (`mise exec -- mkcert -install`).
export def ensure-tls-secret [name: string, app_dir: string, namespace: string, hostname: string] {
	let tmp_dir = (mktemp -d | str trim)
	let tmp_key = ($tmp_dir | path join "tls.key")
	let tmp_crt = ($tmp_dir | path join "tls.crt")
	do {
		cd $app_dir
		mise exec -- mkcert -cert-file $tmp_crt -key-file $tmp_key $hostname
	}
	kubectl create secret tls $"($name)-tls" $"--cert=($tmp_crt)" $"--key=($tmp_key)" -n $namespace --dry-run=client -o yaml | kubectl apply -n $namespace -f -
	rm -rf $tmp_dir
}

# Run a schema Job to completion, replacing the last release's (a Job's pod
# template is immutable); its logs are the error when it fails.
export def run-job [manifest: string, name: string, namespace: string, --timeout-s: int = 600] {
	kubectl delete job $name -n $namespace --ignore-not-found --wait=true
	$manifest | kubectl apply -n $namespace -f -
	print $"Running job/($name)..."
	let deadline = (date now) + ($timeout_s * 1sec)
	loop {
		let status = (kubectl get job $name -n $namespace -o json | from json | get status)
		if ($status.succeeded? | default 0) > 0 { break }
		if ($status.failed? | default 0) > 0 or (date now) > $deadline {
			kubectl logs -n $namespace $"job/($name)" --tail=40
			error make { msg: $"job/($name) in ($namespace) did not complete" }
		}
		sleep 2sec
	}
	kubectl logs -n $namespace $"job/($name)" --tail=5
}

export def render-manifests [
	cue_path: string
	env_name: string
	--data: string # JSON unified into the release package's root, e.g. the images it pushed
]: nothing -> any {
	let expr = $"($env_name)Manifests"
	# The roles the app's schema grants PostgREST's login, as generate wrote them.
	let facts_path = ($cue_path | path dirname | path join .pronto cluster.json)
	if not ($facts_path | path exists) { error make { msg: $"($facts_path) is missing: generate the app before releasing it" } }
	let roles_file = (mktemp -t roles.XXXXXX.json | str trim)
	let facts = (open $facts_path)
	if not $facts.server { error make { msg: $"($facts_path): this app has no server tier to release to Kubernetes" } }
	{App: {database: {tokenRoles: $facts.tokenRoles}}} | to json | save -f $roles_file
	let inputs = [$cue_path $roles_file] | append (if ($data | is-not-empty) { [$data] } else { [] })
	let res = (do { cue export --expression $expr --out text ...$inputs } | complete)
	rm $roles_file
	if $res.exit_code != 0 {
		error make { msg: $"Failed to render CUE manifests: ($res.stderr)" }
	}
	$res.stdout
}

# The target environment's #Environment, from plugins/pronto/k8s/envs
export def read-environment [cluster_env: string]: nothing -> record {
	let field = { kind: "Kind", eks: "EKS", aks: "AKS" } | get $cluster_env
	let res = (do { cd $k8s_dir; cue export --expression $field ./envs } | complete)
	if $res.exit_code != 0 {
		error make { msg: $"Failed to read ($cluster_env) environment: ($res.stderr)" }
	}
	$res.stdout | from json
}

# The project with the door's tree as a release ships it: every image the dev
# stack builds from an `<app>-served` stage (caddy, render) takes
# `<app>-served-release`'s, the same tree addressed with the target's ICE
# servers (emit.cue), so a released page gathers over STUN and the dev stack
# over host candidates alone.
export def release-tree []: string -> string {
	let project = ($in | from yaml)
	let names = ($project.services | columns)
	let served = ($project.services | values
		| each {|svc| $svc.build?.additional_contexts? | default {} | values }
		| flatten
		| where {|v| ($v | str starts-with "service:") and ($v | str ends-with "-served") }
		| uniq)
	let missing = ($served | where {|v| $"($v | str substring 8..)-release" not-in $names })
	if ($missing | is-not-empty) {
		error make {msg: $"the project builds from ($missing | str join ', '), and has no ($missing | each {|v| $"($v | str substring 8..)-release" } | str join ', ') to release it from"}
	}
	let release = {|v| if $v in $served { $"($v)-release" } else { $v } }
	$project | update services {|p|
		$p.services | transpose name svc | reduce -f {} {|row, acc|
			let contexts = ($row.svc.build?.additional_contexts? | default {})
			let built = if ($contexts | is-empty) { $row.svc } else {
				$row.svc | upsert build.additional_contexts ($contexts | transpose key value | reduce -f {} {|c, a| $a | insert $c.key (do $release $c.value) })
			}
			$acc | insert $row.name $built
		}
	} | to yaml
}

# The runtime images baked from the app's flattened compose project, which
# `compose` holds as text (bake resolves no `extends` context, and compose
# leaves the platform of the service-named targets unset). Reproducible, so an
# unchanged source pushes the digest it pushed before and rolls nothing:
# timestamps pinned as bayt pins them, and no provenance attestation, whose
# build time would change the index. Contexts span the monorepo (mecha,
# omnishell), outside the app directory bake runs in. Answers what bake named
# each target, by service.
export def bake-images [app_dir: string, compose: string, services: list<string>, --platform: string]: nothing -> record {
	let compose = ($compose | release-tree)
	let root = (do { cd $app_dir; ^git rev-parse --show-toplevel } | str trim)
	let platform_set = if ($platform | is-not-empty) { [--set $"*.platform=($platform)"] } else { [] }
	do {
		cd $app_dir
		with-env {SOURCE_DATE_EPOCH: "0"} {
			$compose | ^docker buildx bake -f - --load --provenance=false $"--allow=fs.read=($root)" ...$platform_set ...$services
		}
	}
	do { cd $app_dir; $compose | ^docker buildx bake -f - --print ...$services } | from json | get target
}

export def auth-provider-environment [environment: record]: nothing -> record {
	let entries = ($environment | transpose key value | where {|e| $e.key starts-with "OIDC_" })
	let secrets = ($entries | where {|e| $e.key ends-with "_CLIENT_SECRET" and $e.value != "" }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let settings = ($entries | where {|e| not ($e.key ends-with "_CLIENT_SECRET") }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	{
		oidc: $settings, oidcSecrets: ($secrets | columns), secretValues: $secrets
		oidcSecretDigest: (if ($secrets | is-empty) { "" } else { $secrets | sort | to json --raw | hash sha256 })
	}
}

export def auth-provider-secret [name: string, namespace: string, values: record]: nothing -> record {
	{
		apiVersion: "v1", kind: "Secret"
		metadata: {name: $"($name)-oidc", namespace: $namespace}
		type: "Opaque"
		# stringData is write-only: server-side apply must own the stored data.
		data: ($values | items {|key, value| [$key ($value | encode base64)] } | into record)
	}
}

# Main entrypoint for release@k8s
export def main [
	--snapshot               # Build and render only, do not deploy
	--dry-run                # Print rendered manifests to stdout and exit
	--app: string            # Application name or path
	--cluster-env (-e): string = "kind"  # Target cluster environment (kind, eks, aks)
	--skip-operators = false # Skip operator bootstrap
	--skip-observability = false # Skip VictoriaMetrics/Jaeger/Vector bootstrap
] {
	let app_info = (resolve-app $app)
	let manifests = (render-manifests $app_info.cue_path $cluster_env)

	if $dry_run {
		print $manifests
		return
	}

	if $snapshot {
		print $"Snapshot mode: manifests rendered for ($app_info.name) \(($cluster_env)\). No cluster mutations."
		return
	}

	# A cloud release needs its operators, observability and TLS on the target,
	# which only the Kind path provisions so far.
	if $cluster_env != "kind" {
		error make { msg: $"release to ($cluster_env) is not implemented: only --dry-run and --snapshot render its manifests" }
	}

	let root = (git rev-parse --show-toplevel | str trim)
	let app_source_dir = $app_info.dir

	let meta_res = (do { cue export --expression "{name: App.name, namespace: App.namespace, type: App.type, image: App.image, render: App.render}" $app_info.cue_path } | complete)
	if $meta_res.exit_code != 0 {
		error make { msg: $"Failed to read release metadata from ($app_info.cue_path): ($meta_res.stderr)" }
	}
	let app_meta = ($meta_res.stdout | from json)

	let target_ns = $app_meta.namespace
	let gateway_host = ($manifests | from yaml | where kind == "Gateway" | get 0.spec.listeners.0.hostname)
	let workload_name = $app_meta.name
	let is_pronto = ($app_meta.type == "pronto")
	let has_render = $app_meta.render.enabled

	# The caddy image proxies its SSR routes to `render` whenever the app builds one,
	# so a release that omits it serves 502 on every rendered page.
	let compose_services = (do { cd $app_source_dir; docker compose --profile "*" config --services } | lines)
	let compose_render = ("render" in $compose_services)
	if $compose_render != $has_render {
		error make { msg: $"($app_info.cue_path): render.enabled is ($has_render) but the app's compose project (if $compose_render { 'defines' } else { 'lacks' }) a render service" }
	}

	let target_env = (read-environment $cluster_env)
	let registry = $target_env.registry

	# Ensure cluster and operators for local Kind
	if $cluster_env == "kind" {
		ensure-cluster
		# Every kubectl call below targets this cluster, whatever context is current.
		let context = (open --raw ($k8s_dir | path join "cluster.yaml") | from yaml | where kind == "Cluster" | first | get name)
		let kubeconfig = (mktemp -t kubeconfig.XXXXXX | str trim)
		kubectl config view --minify --flatten --context $context | save -f $kubeconfig
		$env.KUBECONFIG = $kubeconfig
		if not $skip_operators {
			ensure-operators
		}
		if not $skip_observability {
			ensure-observability $target_env.domainSuffix
		}
	}


	# Ensure target namespace exists before creating namespaced prerequisites
	kubectl create namespace $target_ns --dry-run=client -o yaml | kubectl apply -f -

	if not $is_pronto {
		error make { msg: $"Only Pronto applications are supported for k8s release: ($app_info.name)" }
	}

	# migrate runs where the app has pgroll migrations to carry, as in compose.
	let has_migrate = ("migrate" in $compose_services)
	let build_svcs = ["database" "crud" "electric" "auth" "caddy"] | append (if $has_migrate { ["migrate"] } else { [] }) | append (if $has_render { ["render"] } else { [] })
	print $"Building native Pronto services \(($build_svcs | str join ', ')\) for ($app_info.name)..."
	let bake_targets = (bake-images $app_source_dir (do { cd $app_source_dir; docker compose --profile "*" config }) $build_svcs --platform ($target_env.platform? | default ""))
	let pushed = ($build_svcs | each {|svc|
		let local = ($bake_targets | get $svc | get tags | where {|t| $t ends-with ":latest" } | first)
		# The database's tag is its Postgres major, which CloudNativePG reads; the
		# official postgres base the image derives from states it as PG_MAJOR.
		let tag = if $svc == "database" {
			docker image inspect --format '{{json .Config.Env}}' $local | from json | where {|e| $e starts-with "PG_MAJOR=" } | first | split row "=" | last
		} else { $app_meta.image.tag }
		let repo = if ($registry | is-not-empty) { $"($registry)/($app_info.name)-($svc)" } else { $"($app_info.name)-($svc)" }
		docker tag $local $"($repo):($tag)"
		if ($registry | is-not-empty) {
			print $"Pushing ($repo):($tag)..."
			docker push $"($repo):($tag)"
		}
		let digest = (docker image inspect --format '{{json .RepoDigests}}' $"($repo):($tag)" | from json | where {|d| $d starts-with $"($repo)@" } | first | split row "@" | last)
		{svc: $svc, ref: {tag: $tag, digest: $digest}}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref })
	# What compose gives the migrate service beyond the database it names.
	let migrate = if $has_migrate {
		{migrate: {env: (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json | get services.migrate.environment | reject DATABASE_URL)}}
	} else { {} }
	# The providers compose gives the auth service, and each one's client:
	# compose refuses to render a provider whose client is unset.
	let oidc = (auth-provider-environment (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json | get services.auth.environment))
	let pushed_file = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: ({image: {pushed: $pushed}, auth: ($oidc | reject secretValues)} | merge $migrate)} | to json | save -f $pushed_file
	let released = (render-manifests $app_info.cue_path $cluster_env --data $pushed_file)
	rm $pushed_file

	# Ingress / Gateway TLS secret for Kind HTTPS parity
	if $cluster_env == "kind" {
		ensure-tls-secret $app_info.name $app_source_dir $target_ns $gateway_host
	}

	# Decrypt and apply SOPS secrets if present
	apply-sops-secrets $app_source_dir $target_ns
	if ($oidc.secretValues | is-not-empty) {
		auth-provider-secret $workload_name $target_ns $oidc.secretValues
			| to json | kubectl apply --server-side --field-manager=pronto-oidc -f -
	}

	# In the order a fresh cluster needs: the database and everything around it,
	# then its schema, then the services that read it, so none starts on a
	# schema that is not there yet. Split as text, as the operators are.
	let docs = ($released | split row --regex '(?m)^---\s*$' | where ($it | str trim | is-not-empty))
	let of_kind = {|kind| $docs | where {|d| $d =~ $"\(?m\)^kind:\\s*($kind)\\s*$" } }
	let deployments_yaml = (do $of_kind "Deployment")
	let jobs_yaml = (do $of_kind "Job")
	print $"Applying manifests for ($app_info.name)..."
	$docs | where {|d| not ($d in $deployments_yaml or $d in $jobs_yaml) } | str join "\n---\n" | kubectl apply -f -

	# The cluster's status names a new image as soon as it starts rolling onto it,
	# and Ready stays true through the restart: the database is there once its
	# primary runs that image and is ready itself.
	let db_image = ($released | from yaml | where kind == "Cluster" | first | get spec.imageName)
	print $"Waiting for CloudNativePG cluster ($app_info.name)-db in ($target_ns) on ($db_image)..."
	let deadline = (date now) + 300sec
	loop {
		let primary = (kubectl get pods -n $target_ns -l $"cnpg.io/cluster=($app_info.name)-db,cnpg.io/instanceRole=primary" -o json | from json | get items
			| where {|p| $p.metadata.deletionTimestamp? == null and ($p.spec.containers | where name == "postgres" | first | get image) == $db_image and ($p.status.conditions? | default [] | any {|c| $c.type == "Ready" and $c.status == "True" }) })
		if ($primary | is-not-empty) { break }
		if (date now) > $deadline { error make { msg: $"cluster/($app_info.name)-db has no ready primary on ($db_image)" } }
		sleep 3sec
	}

	for job in (["initdb"] | append (if $has_migrate { ["migrate"] } else { [] })) {
		run-job ($jobs_yaml | where {|d| $d =~ $"\(?m\)^  name: ($app_info.name)-($job)\\s*$" } | first) $"($app_info.name)-($job)" $target_ns
	}

	# authenticator's memberships name roles initdb creates, so the operator
	# reconciles it, password included, only after the Jobs; crud logs in as it.
	let cluster = $"cluster.postgresql.cnpg.io/($app_info.name)-db"
	print $"Waiting for ($cluster) to reconcile its managed roles..."
	let deadline = (date now) + 300sec
	loop {
		let roles = (kubectl get $cluster -n $target_ns -o json | from json | get status.managedRolesStatus? | default {})
		let pending = ($roles.cannotReconcile? | default {} | columns | append ($roles.byStatus?.pending-reconciliation? | default []))
		if ("authenticator" in ($roles.byStatus?.reconciled? | default [])) and ($pending | is-empty) { break }
		if (date now) > $deadline { error make { msg: $"($cluster) has not reconciled its managed roles: ($roles | to nuon)" } }
		sleep 3sec
	}

	# A changed image digest rolls its deployment; an unchanged one has nothing to roll.
	$deployments_yaml | str join "\n---\n" | kubectl apply -f -
	let components = ["crud" "electric" "auth" "caddy"] | append (if $has_render { ["render"] } else { [] })
	for d in ($components | each { $"deployment/($app_info.name)-($in)" }) {
		print $"Waiting for ($d) rollout..."
		kubectl rollout status $d -n $target_ns --timeout=180s
	}

	# The mesh is intrinsic to a k8s release: a pod the injector let through bare is a failed release.
	let bare = (kubectl get pods -n $target_ns -l $"app.kubernetes.io/name=($app_info.name),app.kubernetes.io/component in \(($components | str join ',')\)" --field-selector=status.phase=Running -o json
		| from json | get items
		| where {|p| $p.metadata.deletionTimestamp? == null and not ($p.spec.containers.name | any {|c| $c == "daprd" }) }
		| get metadata.name)
	if ($bare | is-not-empty) {
		error make { msg: $"Pods running without their Dapr sidecar: ($bare | str join ', ')" }
	}

	print $"\n[SUCCESS] Released ($app_info.name) natively to ($cluster_env): https://($gateway_host)/"
}

