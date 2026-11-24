# release.nu — Kubernetes release engine with immutable verified operators
#
# Cluster & operator lifecycle powered by kind + ctlptl and verified remote manifests.
# No vendored operator YAMLs in git; remote manifests are pinned to immutable URLs
# with SHA256 checksums verified before execution (ADD --checksum pattern).

# Immutable operator manifests with SHA256 checksums
# This engine's own directory: cluster.yaml, envs/, schema/ and observability/
# sit beside it wherever pronto is installed, monorepo or mirror.
const k8s_dir = path self .

use ../release-schema.nu [fresh-schema-runtime]

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

# The file is flat key/value pairs, so `sops exec-env` can feed the same file to local runs and publishes.
export def apply-sops-secrets [app_name: string, app_dir: string, namespace: string] {
	let enc_file = ($app_dir | path join "secrets.enc.yaml")
	if not ($enc_file | path exists) { return }
	print $"Decrypting ($enc_file) into Secret ($app_name)-secrets in ($namespace)..."
	^sops -d --output-type dotenv $enc_file
		| ^kubectl create secret generic $"($app_name)-secrets" -n $namespace --from-env-file=/dev/stdin --dry-run=client -o yaml
		| ^kubectl apply -f -
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

const runtime_supported = ["compute" "risingwave" "redis" "conduit" "mesh-events" "transform" "ticker" "clock" "rclone-s3" "imgproxy"]

# The AI gateway (tsbifrost) is not among them: only the airlock's daprd calls
# it, so an effect reaching it on k8s is refused (`airlock-services`) and an
# app whose effects reach it elsewhere alone runs without it.
export def runtime-services [compose: record]: nothing -> record {
	let supported = $runtime_supported
	let names = ($compose.services | columns | where {|s| $s in $supported })
	$names | reduce -f {} {|name, acc|
		let vars = ($compose.services | get $name | get -o environment | default {})
		if $name == "compute" and ($vars.DUCKSTREAM_ENGINE? | default "") != "risingwave" {
			error make {msg: "native release requires DUCKSTREAM_ENGINE=risingwave for compute"}
		}
		$acc | insert $name {
			env: ($vars | reject -o DATABASE_URL SERVICE_JWT PGRST_JWT_SECRET CONDUIT_DB_TYPE CONDUIT_DB_POSTGRES_CONNECTION_STRING)
			databaseEnvironment: ([DATABASE_URL] | where {|key| $key in $vars })
			serviceToken: ("SERVICE_JWT" in $vars)
			jwtSecret: ("PGRST_JWT_SECRET" in $vars)
		}
	}
}

# What compose hands the airlock that is its wiring rather than an effect's:
# every other variable is a secret an effect declares, which goes to a Secret
# and never into a manifest, so one added later stays out until named here.
const airlock_wiring = [AIRLOCK_DIR BLOB_URL MESH_URL PORT]
# What the release states itself: the database's credential, the door's
# origin and the target the airlock calls bridges on.
const airlock_stated = [DATABASE_URL PGPASSWORD ORIGIN AIRLOCK_TARGET AIRLOCK_RELEASE]
# The keys a secret field is sealed to, where an effect reads one: the
# release's own from its environment, never compose's development default,
# and AIRLOCK_SEAL_DEV, by which the local stack alone takes that default
# (mecha's services/airlock/seal.ts refuseDevKey), never at all.
const airlock_seal = [AIRLOCK_SEAL_KEY AIRLOCK_SEAL_KEY_PREVIOUS AIRLOCK_SEAL_DEV]

def pick [keys: list<string>]: record -> record {
	transpose key value | where key in $keys | reduce -f {} {|it, acc| $acc | insert $it.key $it.value }
}

# The airlock as compose runs it, and what of it the k8s release deploys:
# compose's own images, the effects' endpoints on k8s from the app's facts,
# and the bridges whose targets name k8s, by container.
export def airlock-services [compose: record, facts: record]: nothing -> record {
	if "airlock" not-in $compose.services { return {} }
	let endpoints = ($facts.endpoints?.k8s?)
	if $endpoints == null {
		error make {msg: ".pronto/cluster.json names no effect's endpoint on k8s: generate the app before releasing it"}
	}
	let vars = ($compose.services.airlock.environment? | default {})
	let gateway = ($endpoints | items {|n, url| {n: $n, url: $url} } | where {|e| ($e.url | default "") starts-with "http://tsbifrost:" } | get n)
	if ($gateway | is-not-empty) {
		error make {msg: $"effect ($gateway | str join ', ') reaches the AI gateway on k8s, which the k8s release does not run: give it sink.targets.k8s"}
	}
	let bridges = ($facts.bridges? | default [] | where {|b| "k8s" in $b.targets })
	# A bridge's Service takes its container's name, which none of the
	# release's own Services may hold: its services', their sidecars' `-dapr`
	# ones the injector makes, and the wall's `pronto-` ones; the database's
	# CloudNativePG makes, which name the app, airlock.cue refuses.
	let own = ($runtime_supported | append [database crud electric auth caddy render migrate initdb airlock airlock-mesh airlock-upgrade tsbifrost])
	let taken = ($bridges | where {|b| $b.container in $own or $b.container in ($own | each { $"($in)-dapr" }) or ($b.container | str starts-with "pronto-") } | get container | uniq)
	if ($taken | is-not-empty) {
		error make {msg: $"a bridge on k8s names container ($taken | str join ', '), which the release's own services name: rename the container"}
	}
	let unbuilt = ($bridges | where {|b| $b.build not-in $compose.services } | get build | uniq)
	if ($unbuilt | is-not-empty) {
		error make {msg: $"a bridge names k8s, and the compose project builds no ($unbuilt | str join ', ') to release it from"}
	}
	{
		env: ($vars | pick $airlock_wiring)
		secrets: ($vars | columns | where {|k| $k not-in ($airlock_wiring | append $airlock_stated | append $airlock_seal) } | sort)
		# compose's airlock holds the seal key where an effect reads a secret field.
		seal: ("AIRLOCK_SEAL_KEY" in $vars)
		endpoints: $endpoints
		# The blob plane's address, which the daprd's binding reads; the rest
		# of its environment describes compose's sinks to an operator.
		meshEnv: ($compose.services."airlock-mesh".environment? | default {} | pick [BLOBS_S3_URL])
		bridges: ($bridges | reduce -f {} {|b, acc| $acc | upsert $b.container {port: $b.port, build: $b.build} })
	}
}

# The values the airlock's and each bridge's Secrets hold, and their digests,
# which roll a pod when one changes: an effect's secret and the seal keys
# from the release's environment, a bridge's environment as compose resolves
# it.
export def airlock-secrets [compose: record, airlock: record]: nothing -> record {
	let digest = {|values| if ($values | is-empty) { "" } else { $values | sort | to json --raw | hash sha256 } }
	# Read from the release's own environment, never from compose's: compose
	# gives a simulated effect's secret the value `simulator`, which a real
	# sink would be handed as its credential.
	let missing = ($airlock.secrets | where {|k| ($env | get -o $k | default "") == "" })
	if ($missing | is-not-empty) {
		error make {msg: $"the airlock's effects declare ($missing | str join ', '), which this release's environment does not set"}
	}
	let secrets = ($airlock.secrets | reduce -f {} {|k, acc| $acc | insert $k ($env | get $k) }
		| merge (if ($airlock.seal? | default false) { seal-keys $compose } else { {} }))
	let bridges = ($airlock.bridges | items {|container, b|
		let values = ($compose.services | get $b.build | get -o environment | default {})
		[$container {values: $values, digest: (do $digest $values)}]
	} | into record)
	{values: $secrets, digest: (do $digest $secrets), bridges: $bridges}
}

# The seal key, as an effect's other secrets: made out of band, never here,
# and never the repository's development key, which compose's airlock holds
# where the release's environment sets none (compose is read with neither
# key in its environment, so its value is that default). Compared as the
# bytes it decodes to, in either base64 alphabet, padded or not, wrapped or
# not, before anything is deployed; the airlock refuses it by its id at
# start, however its PKCS#8 is spelled. A rotation sets the replaced one as
# AIRLOCK_SEAL_KEY_PREVIOUS for five minutes (mecha's
# services/airlock/README.md#rotating-the-seal-key).
export def seal-keys [compose: record]: nothing -> record {
	let key = ($env.AIRLOCK_SEAL_KEY? | default "" | str trim)
	let previous = ($env.AIRLOCK_SEAL_KEY_PREVIOUS? | default "" | str trim)
	if ($key | is-empty) {
		error make {msg: "AIRLOCK_SEAL_KEY is required: an effect reads a secret field, which is sealed to it. Set it in this release's environment; mecha's services/airlock/seal-key.ts prints one"}
	}
	let bare = {|k|
		let s = ($k | str replace -a -r '[\s=]' '' | str replace -a '-' '+' | str replace -a '_' '/')
		if ($s | is-empty) { "" } else { $s + ('' | fill -c '=' -w ((4 - ($s | str length) mod 4) mod 4)) | decode base64 | encode hex }
	}
	let dev = (do $bare ($compose.services.airlock.environment.AIRLOCK_SEAL_KEY? | default ""))
	if ($dev | is-not-empty) and ((do $bare $key) == $dev or (do $bare $previous) == $dev) {
		error make {msg: "AIRLOCK_SEAL_KEY is the repository's development key, which only the local stack seals to: give this deployment a key of its own"}
	}
	{AIRLOCK_SEAL_KEY: $key} | merge (if ($previous | is-empty) { {} } else { {AIRLOCK_SEAL_KEY_PREVIOUS: $previous} })
}

# Whether CloudNativePG's last look at the database found authenticator as
# the spec states it, and no managed role waiting: its byStatus, which each
# reconcile of the Cluster restates from the database. cannotReconcile is
# the last attempt's, which stands after the schema made good what it lacked
# until another attempt is needed.
export def roles-reconciled [roles: record]: nothing -> bool {
	("authenticator" in ($roles.byStatus?.reconciled? | default [])) and ($roles.byStatus?.pending-reconciliation? | default [] | is-empty)
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
	let app_dir = ($cue_path | path dirname)
	let compose = if ($app_dir | path join compose.yaml | path exists) {
		do { hide-env -i AIRLOCK_SEAL_KEY AIRLOCK_SEAL_KEY_PREVIOUS; cd $app_dir; docker compose --profile "*" config --format json } | from json
	} else { {services: {}} }
	let runtime = (runtime-services $compose)
	let airlock = (airlock-services $compose $facts)
	{App: ({database: {tokenRoles: $facts.tokenRoles, declaredRoles: ($facts.declaredRoles? | default [])}, runtime: $runtime, replays: ($facts.replays? | default []), doors: ($facts.doors? | default [])} | merge (if ($airlock | is-empty) { {} } else { {airlock: $airlock} }))} | to json | save -f $roles_file
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

# The providers a program offers, which its release turns on.
export const PROGRAM_PROVIDERS = '[if code.capabilities.auth != _|_ if code.capabilities.auth.providers != _|_ for p in code.capabilities.auth.providers {p}]'

# A release turns on the providers the program offers, which a local stack
# leaves off, unless the deployment's environment names its own.
export def auth-provider-environment [environment: record, providers: list<string> = []]: nothing -> record {
	let merged = if ($environment.OIDC_PROVIDERS? | default "" | is-not-empty) or ($providers | is-empty) { $environment } else {
		$environment | upsert OIDC_PROVIDERS ($providers | str join ",")
	}
	let entries = ($merged | transpose key value | where {|e| $e.key starts-with "OIDC_" })
	let secrets = ($entries | where {|e| $e.key ends-with "_CLIENT_SECRET" and $e.value != "" }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	let settings = ($entries | where {|e| not ($e.key ends-with "_CLIENT_SECRET") }
		| reduce -f {} {|it, acc| $acc | insert $it.key $it.value })
	{
		oidc: $settings, oidcSecrets: ($secrets | columns), secretValues: $secrets
		oidcSecretDigest: (if ($secrets | is-empty) { "" } else { $secrets | sort | to json --raw | hash sha256 })
	}
}

export def opaque-secret [name: string, namespace: string, values: record, --labels: record = {}]: nothing -> record {
	{
		apiVersion: "v1", kind: "Secret"
		metadata: ({name: $name, namespace: $namespace} | merge (if ($labels | is-empty) { {} } else { {labels: $labels} }))
		type: "Opaque"
		# stringData is write-only: server-side apply must own the stored data.
		data: ($values | items {|key, value| [$key ($value | into string | encode base64)] } | into record)
	}
}

export def auth-provider-secret [name: string, namespace: string, values: record]: nothing -> record {
	opaque-secret $"($name)-oidc" $namespace $values
}

# The cluster's own addresses, which the daprd's and the bridges' way out to
# the world excludes beside the private ranges, since a node, its pods or the
# API server may sit on a public address: each node's addresses and pod
# ranges, and the API server's endpoints, from `kubectl get nodes` and the
# `kubernetes` Service's EndpointSlices. Each as a CIDR, the family's
# whole-host prefix for an address.
export def cluster-address-blocks [nodes: list, slices: list]: nothing -> list<string> {
	let host = {|a| if ($a | str contains ":") { $"($a)/128" } else { $"($a)/32" } }
	let addresses = ($nodes | each {|n| $n.status?.addresses? | default [] | where type in [InternalIP ExternalIP] | get address } | flatten)
	let pods = ($nodes | each {|n| $n.spec?.podCIDRs? | default ([$n.spec?.podCIDR?] | compact) } | flatten)
	let api = ($slices | each {|s| $s.endpoints? | default [] | get addresses | flatten } | flatten)
	$addresses | append $api | each {|a| do $host $a } | append $pods | uniq | sort
}

# The resolvers the kubelets hand their pods (`clusterDNS`), each whole-host:
# the DNS Service's address, or a node-local cache's (NodeLocal DNSCache
# listens on a link-local address of each node, which no pod selector
# names). Read from each node's kubelet configuration through the API
# server, unless the environment states them; a release that can do neither
# is refused, since a node-local cache's would be out of reach.
export def cluster-resolvers [stated?: list<string>]: nothing -> list<string> {
	let addresses = if $stated != null { $stated } else {
		kubectl get nodes -o json | from json | get items.metadata.name | each {|n|
			let res = (do { kubectl get --raw $"/api/v1/nodes/($n)/proxy/configz" } | complete)
			if $res.exit_code != 0 {
				error make {msg: $"could not read node ($n)'s kubelet configuration for the resolver its pods use: ($res.stderr | str trim). Grant nodes/proxy, or state the environment's `resolvers`"}
			}
			$res.stdout | from json | get -o kubeletconfig.clusterDNS | default []
		} | flatten | uniq
	}
	$addresses | each {|a| if ($a | str contains ":") { $"($a)/128" } else { $"($a)/32" } }
}

# An address as its bits, IPv4's 32 or IPv6's 128.
def ip-bits [ip: string]: nothing -> string {
	let bits = {|n, w| 0..<$w | each {|i| ($n bit-shr ($w - 1 - $i)) bit-and 1 } | str join }
	if ($ip | str contains ":") {
		let halves = ($ip | split row "::")
		let groups = {|h| if ($h | is-empty) { [] } else { $h | split row ":" } }
		let head = (do $groups $halves.0)
		let tail = (if ($halves | length) > 1 { do $groups $halves.1 } else { [] })
		let middle = (if ($halves | length) > 1 { 0..<(8 - ($head | length) - ($tail | length)) | each { "0" } } else { [] })
		$head | append $middle | append $tail | each {|g| do $bits ($"0x($g)" | into int) 16 } | str join
	} else {
		$ip | split row "." | each {|o| do $bits ($o | into int) 8 } | str join
	}
}

export def in-cidr [ip: string, cidr: string]: nothing -> bool {
	let parts = ($cidr | split row "/")
	if ($ip | str contains ":") != ($parts.0 | str contains ":") { return false }
	let width = ($parts.1 | into int)
	(ip-bits $ip | str substring 0..<$width) == (ip-bits $parts.0 | str substring 0..<$width)
}

# The ranges the world excludes whatever the cluster: airlock.cue's.
const private_ranges = ["0.0.0.0/8" "10.0.0.0/8" "100.64.0.0/10" "127.0.0.0/8" "169.254.0.0/16" "172.16.0.0/12" "192.168.0.0/16" "::1/128" "fc00::/7" "fe80::/10"]

# Pods' addresses that neither a private range nor a node's stated pod range
# holds: a network plugin may allot pods from pools of its own, which the
# nodes do not state (Calico's IPAM does), and a public one the release
# cannot exclude from the world.
export def unranged-pod-addresses [pods: list, nodes: list]: nothing -> list<string> {
	let ranges = ($private_ranges | append ($nodes | each {|n| $n.spec?.podCIDRs? | default ([$n.spec?.podCIDR?] | compact) } | flatten))
	$pods | where {|p| not ($p.spec?.hostNetwork? | default false) } | each {|p| $p.status?.podIPs? | default [] | get ip } | flatten | uniq
		| where {|ip| not ($ranges | any {|r| in-cidr $ip $r }) }
}

export def cluster-addresses []: nothing -> list<string> {
	let nodes = (kubectl get nodes -o json | from json | get items)
	let pods = (kubectl get pods -A -o json | from json | get items)
	let unranged = (unranged-pod-addresses $pods $nodes)
	if ($unranged | is-not-empty) {
		error make {msg: $"pods hold public addresses no node's pod range states \(($unranged | first 5 | str join ', ')\): the release cannot keep the airlock's daprd and bridges from the cluster's pods"}
	}
	let slices = (kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o json | from json | get items)
	cluster-address-blocks $nodes $slices
}

# Connects to each `host:port` in rounds, all of a round at once, and prints
# what became of each in the first round and the last, the forbidden ones any
# round reached, and how many rounds running found each target as `want`
# says, as JSON: a probe's whole program, run by the airlock image's Deno.
# Rounds go on until three running agree with `want`, or two minutes pass.
export const wall_probe_program = "const targets = JSON.parse(Deno.env.get('PROBE_TARGETS')); const key = (t) => `${t.host}${t.address ? '@' + t.address : ''}:${t.port}`; const reach = async (t) => { try { const c = await Promise.race([Deno.connect({hostname: t.address ?? t.host, port: t.port}), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 5000))]); c.close(); return 'reached' } catch (e) { return String(e) } }; const end = Date.now() + 120000; let first; let last = {}; let held = 0; const crossed = new Set(); while (held < 3 && Date.now() < end) { last = Object.fromEntries(await Promise.all(targets.map(async (t) => [key(t), await reach(t)]))); first ??= last; for (const t of targets) if (!t.want && last[key(t)] === 'reached') crossed.add(key(t)); held = targets.every((t) => (last[key(t)] === 'reached') === t.want) ? held + 1 : 0; if (held < 3) await new Promise((r) => setTimeout(r, 2000)) } console.log(JSON.stringify({first, last, held, crossed: [...crossed]})); Deno.exit(0)"

# A target's key in a probe's findings: its name, and the address it was
# reached at where the release resolved one.
export def wall-key [t: record]: nothing -> string {
	$"($t.host)(if ($t.address? | default '' | is-empty) { '' } else { $'@($t.address)' }):($t.port)"
}

# The address families the airlock's pods run, from their own addresses: a
# node's family its pods may not have.
export def pod-families [pods: list]: nothing -> list<string> {
	$pods | each {|p| $p.status?.podIPs? | default [] | get ip } | flatten
		| each {|a| if ($a | str contains ":") { "IPv6" } else { "IPv4" } } | uniq | sort
}

# A probe Job's name, within the 63 characters a Job's name takes: past them,
# its head and a hash of the whole.
export def wall-job-name [app: string, job: string]: nothing -> string {
	let name = $"($app)-wall-($job)"
	if ($name | str length) <= 63 { $name } else { $"($name | str substring 0..<50)-($name | hash sha256 | str substring 0..<12)" }
}

# A pod that stands as one of the airlock's, by its labels, so its
# NetworkPolicies hold it, on the node the pod it stands for runs on, and
# connects to `targets`, each `{host, port, want}`, `want` whether the
# policies let it through. A Job, so the Deployment's ReplicaSet, whose
# selector its labels match, never adopts it; never ready, so the Service of
# the pod it stands for sends it nothing.
export def wall-probe [app: string, namespace: string, job: string, as: string, labels: record, node: any, image: string, pull: string, targets: list, --program: string = $wall_probe_program]: nothing -> record {
	{
		apiVersion: "batch/v1", kind: "Job"
		metadata: {name: (wall-job-name $app $job), namespace: $namespace, labels: {"app.kubernetes.io/name": $app, "pronto.dev/probe": "wall"}}
		spec: {
			backoffLimit: 0
			ttlSecondsAfterFinished: 600
			template: {
				metadata: {labels: ({"app.kubernetes.io/name": $app, "app.kubernetes.io/component": $as, "pronto.dev/probe": "wall"} | merge $labels)}
				spec: ({
					restartPolicy: "Never"
					automountServiceAccountToken: false
					containers: [{
						name: "probe"
						image: $image
						imagePullPolicy: $pull
						command: [deno eval $program]
						env: [{name: "PROBE_TARGETS", value: ($targets | to json --raw)}]
						readinessProbe: {tcpSocket: {port: 1}, periodSeconds: 60}
					}]
				} | merge (if $node == null { {} } else { {nodeName: $node} }))
			}
		}
	}
}

# What the probes found, judged, each `{as, targets, result}`. In their last
# round every target must be as `want` says, and for three rounds running: a
# probe that reached nothing it should is no evidence (a network that lets
# nothing out, or a probe that never ran), and one that reached what it
# should not shows a plugin that enforces no NetworkPolicy. An earlier round
# that reached what it should not shows a plugin that started the pod before
# holding it to the policies it had handled, where Kubernetes asks it to hold
# the pod from its first instant: refused unless `late` says the cluster's
# plugin is known to. Answers the
# refusal, or null, and what the first rounds reached.
export def wall-verdict [probes: list, --late]: nothing -> record {
	let key = {|t| wall-key $t }
	let reached = {|r, t| ($r | get -o (do $key $t)) == "reached" }
	let early = ($probes | each {|p| $p.targets | where {|t| not $t.want and (do $key $t) in ($p.result.crossed? | default []) } | each {|t| $"($p.as) to (do $key $t)" } } | flatten)
	let refusal = do {
		let blind = ($probes | each {|p| $p.targets | where {|t| $t.want and not (do $reached $p.result.last $t) } | each {|t| $"($p.as) to (do $key $t) \(($p.result.last | get -o (do $key $t) | default 'no answer')\)" } } | flatten)
		if ($blind | is-not-empty) {
			return $"probes standing as the airlock's pods could not reach what their NetworkPolicies let them: ($blind | str join ', '). The release cannot tell the wall from a network that lets nothing out"
		}
		let through = ($probes | each {|p| $p.targets | where {|t| not $t.want and (do $reached $p.result.last $t) } | each {|t| $"($p.as) to (do $key $t)" } } | flatten)
		if ($through | is-not-empty) {
			return $"probes standing as the airlock's pods reached what their NetworkPolicies forbid: ($through | str join ', '). The cluster's network plugin enforces no NetworkPolicy, so the airlock stands outside its wall"
		}
		if ($probes | any {|p| $p.result.held < 3 }) {
			return "the probes' findings did not hold three rounds running: the release cannot tell the wall from a network that comes and goes"
		}
		if ($early | is-not-empty) and not $late {
			return $"probes reached what their NetworkPolicies forbid before the policies held them: ($early | str join ', '). The network plugin starts a pod unprotected, so a bridge's first moments are outside its wall"
		}
		null
	}
	{refusal: $refusal, early: $early}
}

# The airlock's wall is its NetworkPolicies, which only a network plugin that
# enforces them applies, and nothing in the API says whether one does.
# Probes on the airlock's image stand as the airlock, its daprd and each
# bridge, each on the node that pod runs on: the airlock's reaches its
# database and its daprd and neither the world nor a bridge; the daprd's the world and the
# bridges but not the database; a bridge's the world but neither the
# database, the daprd nor another bridge. None reaches `target`, a listener of the release's
# that admits anyone, which only its own egress keeps each from: one whose
# policy is missing reaches it. A control no policy holds reaches `target`,
# and no bridge, the daprd nor the airlock, which only their ingress keeps it
# from. A release whose probes find otherwise is refused.
export const wall_target_port = 8080
export def wall-probes [bridges: list<string>, target: string, --families: list<string> = [IPv4]]: nothing -> list {
	# The world in each address family the cluster runs, so a plugin that
	# holds one family alone is found.
	let world = ($families | each {|f| {host: ({IPv4: "1.1.1.1", IPv6: "2606:4700:4700::1111"} | get $f), port: 443} })
	let database = {host: "database", port: 5432}
	let mesh = {host: "airlock-mesh", port: 3500}
	let airlock = {host: "airlock", port: 9997}
	let listener = {host: $target, port: $wall_target_port}
	let peers = ($bridges | each {|b| let p = ($b | split row ":"); {host: $p.0, port: ($p.1 | into int)} })
	let want = {|ts, w| $ts | each {|t| $t | insert want $w } }
	[
		{job: "airlock", as: "airlock", labels: {}, targets: ((do $want [$database $mesh] true) | append (do $want ($world | append $listener | append $peers) false))}
		{job: "airlock-mesh", as: "airlock-mesh", labels: {}, targets: ((do $want ($world | append $peers) true) | append (do $want [$database $listener] false))}
	] | append ($peers | each {|b| {job: $"bridge-($b.host)", as: $b.host, labels: {"pronto.dev/bridge": "true"}, targets: ((do $want $world true) | append (do $want ([$database $mesh $listener] | append ($peers | where host != $b.host)) false))} }) | append [
		{job: "control", as: "wall-control", labels: {"app.kubernetes.io/name": $"($target)-control"}, targets: ((do $want [$listener] true) | append (do $want ([$mesh $airlock] | append $peers) false))}
	]
}

# The listener `wall-probes` names: a pod on the airlock's image that accepts
# and closes every connection, in both families on one socket where the pod
# has IPv6 and IPv4 alone where it has not, outside the app's name so no policy of its
# selects it, and its Service.
const wall_target_program = "const port = Number(Deno.env.get('PROBE_TARGETS')); let l; try { l = Deno.listen({hostname: '::', port}) } catch { l = Deno.listen({hostname: '0.0.0.0', port}) } for await (const c of l) c.close()"
export def wall-target [app: string, namespace: string, image: string, pull: string]: nothing -> list {
	let name = "pronto-wall-target"
	let labels = {"app.kubernetes.io/name": $"($app)-wall-target", "app.kubernetes.io/component": "wall-target"}
	let job = (wall-probe $app $namespace "target" "wall-target" $labels null $image $pull [] --program $wall_target_program
		| update spec.template.spec.containers.0.env.0.value ($wall_target_port | into string)
		| update spec.template.spec.containers.0.readinessProbe {tcpSocket: {port: $wall_target_port}, periodSeconds: 2})
	[$job {
		apiVersion: "v1", kind: "Service"
		metadata: {name: $name, namespace: $namespace, labels: {"pronto.dev/probe": "wall"}}
		spec: {selector: $labels, ports: [{port: $wall_target_port, targetPort: $wall_target_port, protocol: "TCP"}]}
	}]
}

# The nodes the ready pods run on, the terminating ones aside.
export def ready-nodes []: list -> list<string> {
	where {|pod| $pod.metadata.deletionTimestamp? == null and ($pod.status.conditions? | default [] | any {|c| $c.type == "Ready" and $c.status == "True" }) }
		| get -o spec.nodeName | default [] | uniq
}

# kubectl, its input piped in, failing the release when it fails: what the
# wall's checks and cleanup do must have been done.
export def --wrapped kubectl-ok [...args: string]: any -> nothing {
	let res = ($in | ^kubectl ...$args | complete)
	if $res.exit_code != 0 { error make {msg: $"kubectl ($args | str join ' ') failed: ($res.stderr | str trim)"} }
}

# Whether a pod selector selects a pod's labels.
# `unknown` names labels a pod holds with a value the release cannot know,
# a Deployment's `pod-template-hash`: any requirement on one may hold.
# `--open` takes every label the pod does not hold as one an admission
# webhook may add, with any value: a requirement on one may hold either way.
export def selects [selector: record, labels: record, --unknown: list<string> = [], --open]: nothing -> bool {
	let maybe = {|k| $open and $k not-in $labels }
	let matched = ($selector.matchLabels? | default {} | items {|k, v| $k in $unknown or (do $maybe $k) or ($labels | get -o $k) == $v } | all {|x| $x })
	let expressed = ($selector.matchExpressions? | default [] | all {|e|
		let v = ($labels | get -o $e.key)
		if (do $maybe $e.key) { return true }
		if $e.key in $unknown { return ($e.operator != "DoesNotExist") }
		match $e.operator {
			"In" => ($v != null and $v in $e.values)
			"NotIn" => ($v == null or $v not-in $e.values)
			"Exists" => ($v != null)
			"DoesNotExist" => ($v == null)
			_ => true
		}
	})
	$matched and $expressed
}

# The namespace's NetworkPolicies that select one of the airlock's pods and
# are not the release's own for it. Policies add up, so another's allowance
# would open the wall wherever the probes do not look.
export def foreign-policies [policies: list, pods: list, own: list<string>, --open]: nothing -> list<string> {
	$policies | where {|p| $p.metadata.name not-in $own and ($pods | any {|labels| selects $p.spec.podSelector $labels --unknown [pod-template-hash] --open=$open }) } | get metadata.name
}

# Refuses a namespace where another NetworkPolicy than the release's own
# (`own`) could select one of the airlock's pods, by the labels the release
# gives them and any an admission webhook might add, so it runs before any of
# them starts.
export def refuse-foreign-policies [app: string, namespace: string, bridges: list<string>, own: list<string>] {
	let containers = ($bridges | each {|b| $b | split row ":" | first })
	let labelled = ([airlock airlock-mesh] | each {|c| {"app.kubernetes.io/name": $app, "app.kubernetes.io/component": $c} })
		| append ($containers | each {|c| {"app.kubernetes.io/name": $app, "app.kubernetes.io/component": $c, "pronto.dev/bridge": "true"} })
	let own = ([airlock airlock-mesh] | append ($containers | each { $"bridge-($in)" }) | each { $"($app)-($in)" } | append $own)
	let foreign = (foreign-policies (kubectl get networkpolicies -n $namespace -o json | from json | get items) $labelled $own --open)
	if ($foreign | is-not-empty) {
		error make {msg: $"the airlock's wall in ($namespace) is not certified: NetworkPolicies ($foreign | str join ', ') select its pods too, and policies add up, so theirs would open what its own close: release the app into a namespace of its own"}
	}
}

# The probes `verify-wall --before` runs: each role's, wherever the scheduler
# places it, tries the world and the listener alone, which need none of the
# airlock's own pods up.
export def before-probes [bridges: list<string>, families: list<string>]: nothing -> list {
	wall-probes $bridges "pronto-wall-target" --families $families
		| each {|p| $p | update targets ($p.targets | where {|t| ($t.host =~ '^[0-9.]+$') or ($t.host | str contains ":") or $t.host == "pronto-wall-target" }) | insert node null }
}

# Runs `wall-probes` beside the pods they stand for and judges them, deleting
# the probes whatever they find.
#
# `--before`, the airlock's own pods not started yet, certifies what it can
# without them: each role's probe, wherever the scheduler places it, reaches
# the world as its policy says and not the listener, and the control the
# listener, so a plugin that enforces nothing is refused before any of the
# airlock's code runs.
export def verify-wall [app: string, namespace: string, bridges: list<string>, --late, --before, --image: record, --own: list<string> = []] {
	let image = if $image != null { $image } else { kubectl get deployment $"($app)-airlock" -n $namespace -o json | from json | get spec.template.spec.containers.0 }
	refuse-foreign-policies $app $namespace $bridges $own
	if $before {
		let families = (pod-families (kubectl get pods -n $namespace -o json | from json | get items))
		return (run-wall-probes $app $namespace $image (before-probes $bridges (if ($families | is-empty) { [IPv4] } else { $families })) --late=$late)
	}
	# And by the labels the pods were admitted with, which an admission
	# webhook may have added to.
	let roles = (["airlock" "airlock-mesh"] | append ($bridges | each {|b| $b | split row ":" | first }))
	let admitted = (kubectl get pods -n $namespace -l $"app.kubernetes.io/name=($app),pronto.dev/probe!=wall" -o json | from json | get items
		| where {|pod| ($pod.metadata.labels."app.kubernetes.io/component"? | default "") in $roles } | get metadata.labels)
	let own = (["airlock" "airlock-mesh"] | append ($bridges | each {|b| $"bridge-($b | split row ':' | first)" }) | each { $"($app)-($in)" })
	let foreign = (foreign-policies (kubectl get networkpolicies -n $namespace -o json | from json | get items) $admitted $own)
	if ($foreign | is-not-empty) {
		error make {msg: $"the airlock's wall in ($namespace) is not certified: NetworkPolicies ($foreign | str join ', ') select its pods as admitted, and policies add up, so theirs would open what its own close: release the app into a namespace of its own"}
	}
	# One probe beside each ready pod's node, the terminating ones a rollout
	# leaves draining aside, labelled as that pod is, whatever a controller
	# or an admission webhook gave it.
	let families = (pod-families (kubectl get pods -n $namespace -l $"app.kubernetes.io/name=($app),app.kubernetes.io/component in \(airlock,airlock-mesh\)" -o json | from json | get items))
	let probes = (wall-probes $bridges "pronto-wall-target" --families $families | each {|p|
		if $p.job == "control" { return [($p | insert node null)] }
		let pods = (kubectl get pods -n $namespace -l $"app.kubernetes.io/name=($app),app.kubernetes.io/component=($p.as),pronto.dev/probe!=wall" -o json | from json | get items)
		let nodes = ($pods | ready-nodes)
		if ($nodes | is-empty) { error make {msg: $"no ($p.as) pod is ready in ($namespace) to probe the wall beside"} }
		$nodes | enumerate | each {|n|
			let beside = ($pods | where spec.nodeName == $n.item | first | get metadata.labels)
			$p | update job (if ($nodes | length) == 1 { $p.job } else { $"($p.job)-($n.index)" }) | insert node $n.item | update labels ($beside | merge $p.labels)
		}
	} | flatten)
	run-wall-probes $app $namespace $image $probes --late=$late
}

# Starts the listener and `probes` beside it, judges what they find, and
# deletes them whatever they find.
def run-wall-probes [app: string, namespace: string, image: record, probes: list, --late] {
	let pull = ($image.imagePullPolicy? | default IfNotPresent)
	let clean = {||
		for j in ($probes | get job | append target) { kubectl-ok delete job (wall-job-name $app $j) -n $namespace --ignore-not-found --wait=true }
		kubectl-ok delete service pronto-wall-target -n $namespace --ignore-not-found
	}
	do $clean
	let found = (try {
		# Created, never applied: a probe's findings are this release's own.
		for o in (wall-target $app $namespace $image.image $pull) { $o | to json | kubectl-ok create -f - }
		# The listener serves before any probe tries it, so a probe that cannot
		# reach it is held by its policy, not early.
		let deadline = (date now) + 180sec
		loop {
			let ready = (kubectl get endpointslices -n $namespace -l kubernetes.io/service-name=pronto-wall-target -o json | from json | get items
				| each {|s| $s.endpoints? | default [] } | flatten | any {|e| $e.conditions?.ready? == true })
			if $ready { break }
			if (date now) > $deadline { error make {msg: $"the wall's listener in ($namespace) never became ready"} }
			sleep 2sec
		}
		# Each target at each address of each ready pod behind its Service,
		# every family's: a probe whose resolver fails cannot pass off a name
		# it never looked up as one its policy forbids, and a plugin that holds
		# one family alone is found, whatever family the Service has.
		let addresses = {|t|
			if ($t.host =~ '^[0-9.]+$' or ($t.host | str contains ":")) { return [$t] }
			let selector = (kubectl get service $t.host -n $namespace -o json | from json | get spec.selector | items {|k, v| $"($k)=($v)" } | str join ",")
			let ips = (kubectl get pods -n $namespace -l $selector -o json | from json | get items
				| where {|pod| $pod.metadata.deletionTimestamp? == null and ($pod.status.conditions? | default [] | any {|c| $c.type == "Ready" and $c.status == "True" }) }
				| each {|pod| $pod.status.podIPs? | default [] | get ip } | flatten | uniq)
			if ($ips | is-empty) { error make {msg: $"no ready pod stands behind ($t.host) in ($namespace) to probe the wall against"} }
			$ips | each {|ip| $t | insert address $ip }
		}
		let probes = ($probes | each {|p| $p | update targets ($p.targets | each {|t| do $addresses $t } | flatten) })
		for p in $probes {
			wall-probe $app $namespace $p.job $p.as $p.labels $p.node $image.image $pull $p.targets | to json | kubectl-ok create -f -
		}
		$probes | each {|p|
			let job = $"job/(wall-job-name $app $p.job)"
			let deadline = (date now) + 300sec
			loop {
				let status = (kubectl get $job -n $namespace -o json | from json | get status)
				if ($status.succeeded? | default 0) > 0 or ($status.failed? | default 0) > 0 or (date now) > $deadline { break }
				sleep 2sec
			}
			let out = (do { kubectl logs $job -n $namespace } | complete)
			let result = (try { $out.stdout | lines | last | from json } catch { null })
			if $result == null {
				error make {msg: $"the wall's probe as ($p.as) gave no answer: ($out.stderr)($out.stdout | str trim)"}
			}
			$p | insert result $result
		}
	} catch {|e| try { do $clean }; error make {msg: $e.msg} })
	do $clean
	let verdict = (wall-verdict $found --late=$late)
	if $verdict.refusal != null { error make {msg: $"the airlock's wall in ($namespace) is not certified: ($verdict.refusal)"} }
	if ($verdict.early | is-not-empty) {
		print $"The network plugin let new pods reach what their policies forbid before the policies held them \(($verdict.early | str join ', ')\), which this environment's plugin is known to do: a bridge's first moments are outside its wall."
	}
	print $"The airlock's wall holds: ($found | each {|p| {($p.as): $p.result.last} } | reduce -f {} {|r, acc| $acc | merge $r } | to json --raw)"
}

# Main entrypoint for release@k8s
export def main [
	--snapshot               # Build and render only, do not deploy
	--dry-run                # Print rendered manifests to stdout and exit
	--app: string            # Application name or path
	--cluster-env (-e): string = "kind"  # Target cluster environment (kind, eks, aks, gke)
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
	if $cluster_env not-in ["kind" "gke"] {
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

	let target_env = if $cluster_env == "gke" {
		let config = (^cue export --expression GKE --out json $app_info.cue_path | from json)
		let kubeconfig = (mktemp -t kubeconfig.XXXXXX | str trim)
		kubectl config view --minify --flatten --context $config.context | save -f $kubeconfig
		$env.KUBECONFIG = $kubeconfig
		$config.environment
	} else { read-environment $cluster_env }
	let registry = $target_env.registry
	if $cluster_env == "gke" {
		kubectl get crd clusters.postgresql.cnpg.io externalsecrets.external-secrets.io configurations.dapr.io gateways.gateway.networking.k8s.io backendtrafficpolicies.gateway.envoyproxy.io | ignore
		kubectl get gatewayclass $target_env.gatewayClassName | ignore
		let tls = ($manifests | from yaml | where kind == "Gateway" | first | get spec.listeners | where protocol == "HTTPS" | get -o 0.tls.certificateRefs.0.name)
		if ($tls | is-not-empty) { kubectl get secret $tls -n $target_ns | ignore }
	}

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

	# migrate runs where the app has ledger migrations or permissions to reconcile, as in compose.
	let has_migrate = ("migrate" in $compose_services)
	# Read with no seal key in the environment, so the airlock's shows the
	# local stack's default, the development key the release refuses.
	let compose = (do { hide-env -i AIRLOCK_SEAL_KEY AIRLOCK_SEAL_KEY_PREVIOUS; cd $app_source_dir; docker compose --profile "*" config --format json } | from json)
	let runtime = (runtime-services $compose)
	let airlock = (airlock-services $compose (open ($app_source_dir | path join .pronto cluster.json)))
	let has_airlock = ($airlock | is-not-empty)
	let airlock_svcs = if $has_airlock { ["airlock" "airlock-mesh" "airlock-upgrade"] | append ($airlock.bridges | values | get build | uniq) } else { [] }
	let build_svcs = ($runtime | columns) | append ["database" "crud" "electric" "auth" "caddy"] | append (if $has_migrate { ["migrate"] } else { [] }) | append (if $has_render { ["render"] } else { [] }) | append $airlock_svcs
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
	let providers = (do { cd $app_source_dir; ^cue export . -e $PROGRAM_PROVIDERS --out json } | from json)
	let oidc = (auth-provider-environment (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json | get services.auth.environment) $providers)
	# An issuer the release trusts, TRUSTED_JWKS, for the roles the program
	# declares: its public keys are checked here, before anything is applied,
	# and digested so a change of keys rolls crud. Unset, crud verifies the
	# stack's own tokens alone.
	let declared = (open ($app_info.cue_path | path dirname | path join .pronto cluster.json) | get -o declaredRoles | default [])
	let jwks = ($env.TRUSTED_JWKS? | default "")
	if ($declared | is-empty) and ($jwks | is-not-empty) {
		error make { msg: $"TRUSTED_JWKS is set, but ($app_info.name) declares no token role an issuer's token could name" }
	}
	let trusted = if ($jwks | is-empty) { null } else {
		let checked = (with-env {PGRST_JWT_SECRET: ("x" | fill -c "x" -w 32), TRUSTED_JWKS: $jwks} { deno run --no-config --allow-env ($k8s_dir | path join .. trusted-keys.ts) | complete })
		if $checked.exit_code != 0 { error make { msg: $"TRUSTED_JWKS is refused: ($checked.stderr | str trim)" } }
		{jwks: $jwks, digest: ($jwks | hash sha256), audience: ($env.TRUSTED_AUDIENCE? | default "")}
	}
	let airlock_secrets = if $has_airlock { airlock-secrets $compose $airlock } else { {} }
	let airlock_digests = if $has_airlock {
		{airlock: {
			secretDigest: $airlock_secrets.digest
			bridges: ($airlock_secrets.bridges | items {|c, b| [$c {envDigest: $b.digest}] } | into record)
			clusterAddresses: (cluster-addresses)
			resolvers: (cluster-resolvers $target_env.resolvers?)
		}}
	} else { {} }
	let pushed_file = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: ({image: {pushed: $pushed}, auth: ($oidc | reject secretValues)} | merge $migrate | merge (if $trusted == null { {} } else { {trustedKeysDigest: $trusted.digest, trustedAudience: $trusted.audience} }) | merge $airlock_digests)} | to json | save -f $pushed_file
	let released = (render-manifests $app_info.cue_path $cluster_env --data $pushed_file)
	rm $pushed_file

	# Ingress / Gateway TLS secret for Kind HTTPS parity
	if $cluster_env == "kind" {
		ensure-tls-secret $app_info.name $app_source_dir $target_ns $gateway_host
	}

	# secrets.enc.yaml holds sandbox keys, which a production cluster must never get.
	if $cluster_env == "kind" {
		apply-sops-secrets $app_info.name $app_source_dir $target_ns
	}
	if ($oidc.secretValues | is-not-empty) {
		auth-provider-secret $workload_name $target_ns $oidc.secretValues
			| to json | kubectl apply --server-side --field-manager=pronto-oidc -f -
	}
	# The effects' secrets and each bridge's environment, through stdin.
	if $has_airlock {
		opaque-secret $"($workload_name)-airlock" $target_ns $airlock_secrets.values --labels {"app.kubernetes.io/name": $workload_name, "app.kubernetes.io/component": "airlock"}
			| to json | kubectl apply --server-side --field-manager=pronto-airlock -f -
		for b in ($airlock_secrets.bridges | transpose container b) {
			opaque-secret $"($workload_name)-bridge-($b.container)" $target_ns $b.b.values --labels {"app.kubernetes.io/name": $workload_name, "app.kubernetes.io/component": $b.container, "pronto.dev/bridge": "true"}
				| to json | kubectl apply --server-side --field-manager=pronto-airlock -f -
		}
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

	for job in (["initdb"] | append (if $has_airlock { ["airlock-upgrade"] } else { [] }) | append (if $has_migrate { ["migrate"] } else { [] })) {
		run-job ($jobs_yaml | where {|d| $d =~ $"\(?m\)^  name: ($app_info.name)-($job)\\s*$" } | first) $"($app_info.name)-($job)" $target_ns
	}

	# crud logs in as authenticator, so the operator has reconciled it,
	# password and memberships, before crud starts. Its memberships name the
	# schema's token roles, which the Jobs above create, 001_roles.sql on a
	# fresh database and the `roles` reconcile on every release, a newly
	# declared one among them: an attempt the operator made before they stood
	# gave up, and it tries again only when the Cluster changes, so the release
	# changes it.
	let cluster = $"cluster.postgresql.cnpg.io/($app_info.name)-db"
	kubectl annotate $cluster -n $target_ns --overwrite $"pronto.dev/roles-restated=(date now | into int)"
	print $"Waiting for ($cluster) to reconcile its managed roles..."
	let deadline = (date now) + 300sec
	loop {
		let roles = (kubectl get $cluster -n $target_ns -o json | from json | get status.managedRolesStatus? | default {})
		if (roles-reconciled $roles) { break }
		if (date now) > $deadline { error make { msg: $"($cluster) has not reconciled its managed roles: ($roles | to nuon)" } }
		sleep 3sec
	}

	if ($runtime | values | any {|r| $r.serviceToken }) {
		kubectl wait --for=condition=Ready $"externalSecret/($workload_name)-auth-secrets" -n $target_ns --timeout=120s
		let secret = (kubectl get secret $"($workload_name)-auth-secrets" -n $target_ns -o json | from json | get data.PGRST_JWT_SECRET | decode base64)
		let token = ($secret | deno run --no-config ($k8s_dir | path join service-token.ts) | str trim)
		{apiVersion: "v1", kind: "Secret", metadata: {name: $"($workload_name)-service-token", namespace: $target_ns}, data: {SERVICE_JWT: ($token | encode base64)}} | to json | kubectl apply --server-side --field-manager=pronto-runtime -f -
	}

	# crud's key set: the stack's own secret beside the issuer's public keys,
	# composed here because PostgREST fetches no JWKS and its image has no shell.
	# The schema rollout below also picks up a rotated stack secret.
	if $trusted != null {
		kubectl wait --for=condition=Ready $"externalSecret/($workload_name)-auth-secrets" -n $target_ns --timeout=120s
		let secret = (kubectl get secret $"($workload_name)-auth-secrets" -n $target_ns -o json | from json | get data.PGRST_JWT_SECRET | decode base64)
		let composed = (with-env {PGRST_JWT_SECRET: $secret, TRUSTED_JWKS: $trusted.jwks} { deno run --no-config --allow-env ($k8s_dir | path join .. trusted-keys.ts) | complete })
		if $composed.exit_code != 0 { error make { msg: "crud's key set could not be composed from the cluster's secret and TRUSTED_JWKS" } }
		let keys = ($composed.stdout | str trim)
		{apiVersion: "v1", kind: "Secret", metadata: {name: $"($workload_name)-trusted-keys", namespace: $target_ns}, data: {PGRST_JWKS: ($keys | encode base64)}} | to json | kubectl apply --server-side --field-manager=pronto-runtime -f -
	}

	# CRUD rolls after the schema jobs even with an unchanged image; the other
	# deployments roll when their templates change. The airlock's own go in
	# the order it goes out through them: the bridges, then the daprd, whose
	# endpoints name them, then the airlock, so
	# neither the airlock that runs nor its successor spends an effect's
	# attempts on a call nothing answers yet.
	let named = {|name| $deployments_yaml | where {|d| $d =~ $"\(?m\)^  name: ($app_info.name)-($name)\\s*$" } }
	let own_policies = ($released | from yaml | where kind == NetworkPolicy | get metadata.name)
	let bridge_ports = if $has_airlock { $airlock.bridges | items {|c, b| $"($c):($b.port)" } } else { [] }
	let mesh_yaml = if $has_airlock { do $named airlock-mesh } else { [] }
	let airlock_yaml = if $has_airlock { do $named airlock } else { [] }
	let runtime_names = ($runtime | columns)
	# From the moment the airlock's pods may start, a wall not certified, a
	# failed rollout among the ways, runs nothing behind it.
	let roll = {||
		if $has_airlock {
			# The wall, as far as it can be told before any of the airlock's
			# code runs: its policies are applied, and none of its pods is
			# started until a plugin is seen enforcing them.
			let image = ($airlock_yaml | first | from yaml | get spec.template.spec.containers.0)
			verify-wall $app_info.name $target_ns $bridge_ports --before --image $image --own $own_policies --late=($target_env.policiesLate? | default false)
		}
		$deployments_yaml | where {|d| $d not-in $mesh_yaml and $d not-in $airlock_yaml }
			| each {|d| if ($d | from yaml | get metadata.name) == $"($app_info.name)-crud" { fresh-schema-runtime $d } else { $d } }
			| str join "\n---\n" | kubectl-ok apply -f -
		for name in $runtime_names {
			kubectl-ok rollout status $"deployment/($app_info.name)-($name)" -n $target_ns --timeout=900s
		}
		if $has_airlock {
			for name in ($airlock.bridges | columns | each { $"bridge-($in)" }) {
				kubectl-ok rollout status $"deployment/($app_info.name)-($name)" -n $target_ns --timeout=300s
			}
			$mesh_yaml | str join "\n---\n" | kubectl-ok apply -f -
			kubectl-ok rollout status $"deployment/($app_info.name)-airlock-mesh" -n $target_ns --timeout=300s
			$airlock_yaml | str join "\n---\n" | kubectl-ok apply -f -
			kubectl-ok rollout status $"deployment/($app_info.name)-airlock" -n $target_ns --timeout=300s
			verify-wall $app_info.name $target_ns $bridge_ports --own $own_policies --late=($target_env.policiesLate? | default false)
		}
	}
	if not $has_airlock { do $roll } else {
		try { do $roll } catch {|e|
			for selector in [$"app.kubernetes.io/name=($workload_name),app.kubernetes.io/component in \(airlock,airlock-mesh\)" $"app.kubernetes.io/name=($workload_name),pronto.dev/bridge=true"] {
				if (kubectl get deployment -n $target_ns -l $selector -o name | lines | is-not-empty) {
					kubectl-ok scale deployment -n $target_ns -l $selector --replicas=0
				}
			}
			error make {msg: $"($e.msg); the airlock, its daprd and its bridges are scaled to zero"}
		}
	}
	# What an earlier release deployed of the airlock and its bridges that this
	# one does not: a bridge no longer on k8s, or all of it where the program
	# declares no effect, which would otherwise run on with its environment
	# and the world in reach.
	# Their pods go first, waited for, and their policies after, so none
	# outlives its wall.
	let current = if $has_airlock { $airlock.bridges | columns } else { [] }
	let gone = if ($current | is-empty) { "" } else { $",app.kubernetes.io/component notin \(($current | str join ',')\)" }
	let selectors = [$"app.kubernetes.io/name=($workload_name),pronto.dev/bridge=true($gone)"] | append (if $has_airlock { [] } else { [$"app.kubernetes.io/name=($workload_name),app.kubernetes.io/component in \(airlock,airlock-mesh\)"] })
	for selector in $selectors {
		kubectl-ok delete deployment -n $target_ns -l $selector --cascade=foreground --wait=true --ignore-not-found
		let deadline = (date now) + 300sec
		loop {
			let left = (kubectl get pods -n $target_ns -l $"($selector),pronto.dev/probe!=wall" -o json | from json | get items)
			if ($left | is-empty) { break }
			if (date now) > $deadline { error make {msg: $"($left | get metadata.name | str join ', ') still run: their policies stay"} }
			sleep 2sec
		}
		kubectl-ok delete service,networkpolicy,secret,configmap -n $target_ns -l $selector --ignore-not-found
	}
	if not $has_airlock {
		kubectl-ok delete job $"($workload_name)-airlock-upgrade" -n $target_ns --ignore-not-found
	}
	let components = ["crud" "electric" "auth" "caddy"] | append ($runtime_names | where {|s| $s in ["ticker" "rclone-s3" "imgproxy"] }) | append (if $has_render { ["render"] } else { [] })
	for d in ($components | each { $"deployment/($app_info.name)-($in)" }) {
		print $"Waiting for ($d) rollout..."
		kubectl-ok rollout status $d -n $target_ns --timeout=180s
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

