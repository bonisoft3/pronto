# release.nu — Kubernetes release engine with immutable verified operators
#
# Cluster & operator lifecycle powered by kind + ctlptl and verified remote manifests,
# or against a cluster the operator runs (envs/metal.cue), behind a Cloudflare Tunnel.
# No vendored operator YAMLs in git; remote manifests are pinned to immutable URLs
# with SHA256 checksums verified before execution (ADD --checksum pattern).

# Immutable operator manifests with SHA256 checksums
# This engine's own directory: cluster.yaml, envs/, schema/ and observability/
# sit beside it wherever pronto is installed, monorepo or mirror.
const k8s_dir = path self .

use ../gcp/build.nu [push-images service-jwt]

# What carries a metal cluster's requests out through its tunnel to Cloudflare.
const cloudflared = "cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c"
# The gateway's Service behind a tunnel, named so the tunnel can dial it.
const tunnel_gateway = "pronto-gateway"
# The registry on a node whose releases build by "node" (node-registry-manifests),
# and the loopback port it listens on, which #Environment.registry names.
const node_registry = "registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
const node_registry_port = 5000

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
		url: "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.1/cnpg-1.30.1.yaml"
		checksum: "sha256:37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb"
		namespace: "cnpg-system"
		check_deployments: ["cnpg-controller-manager"]
	},
	# The certificates CloudNativePG's barman-cloud plugin and the operator talk through.
	{
		name: "cert-manager"
		url: "https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml"
		checksum: "sha256:c04a51295adda2b1a775146751f973e787190778c7f35180861d9678876e5c74"
		namespace: "cert-manager"
		check_deployments: ["cert-manager" "cert-manager-cainjector" "cert-manager-webhook"]
	},
	# Backups and WAL to an object store (#ReleaseSpec.database.backup): a sidecar beside
	# postgres, so the database's own image needs no barman-cloud of its own.
	{
		name: "barman-cloud"
		url: "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml"
		checksum: "sha256:8f377ff4a7d0d3f74fc64b0f7ac4f449fc38ca9e83a40107cca2f9315a9bd920"
		namespace: "cnpg-system"
		check_deployments: ["barman-cloud"]
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
		url: "https://dapr.github.io/helm-charts/dapr-1.16.21.tgz"
		checksum: "sha256:71233ad45bf72cc095abd718b592c0442a215940c32c7130fff5f775b18bc62c"
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
	--ingress: record = {by: "hostPort"} # the environment's
	--reopen: closure # opens the release's tunnel to the API again (#Environment.access)
] {
	for entry in $OPERATORS {
		try { install-operator $entry $timeout } catch {|e|
			if $reopen == null { error make {msg: $e.msg} }
			print $"($entry.name) failed through the tunnel to the API \(($e.msg)\): opening it again"
			do $reopen
			install-operator $entry $timeout
		}
	}

	ensure-envoy-gateway-class $ingress
}

# One operator: its manifests applied, its deployments waited for.
def install-operator [entry: record, timeout: string] {
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
			$crds | str join "\n---\n" | kubectl apply --server-side --force-conflicts --request-timeout=120s -f -
			kubectl wait --for=condition=Established $"--timeout=($timeout)" crd --all
		}
		# helm template leaves namespace off objects that do not set it; the chart's namespace is theirs.
		$docs | where {|d| not (do $is_crd $d) } | str join "\n---\n" | kubectl apply -n $entry.namespace --server-side --force-conflicts --validate=false --request-timeout=120s -f -
	} else {
		# A manifest whose objects another operator's webhook admits (the barman-cloud plugin's
		# Certificate, cert-manager's) is refused for the few seconds that webhook takes to serve
		# once its deployment is ready: applied again, for at most a minute.
		mut attempt = 1
		loop {
			let applied = (do { kubectl apply --server-side --force-conflicts --validate=false --request-timeout=120s -f $file } | complete)
			print -n $applied.stdout
			if $applied.exit_code == 0 { break }
			if $attempt >= 12 { error make { msg: $"($entry.name): kubectl apply failed: ($applied.stderr)" } }
			print $"($entry.name) not admitted yet \(($applied.stderr | str trim | lines | last)\): again in 5s"
			$attempt += 1
			sleep 5sec
		}
	}

	for d in ($entry.check_deployments? | default []) {
		print $"Waiting for deployment ($d) in ($entry.namespace)..."
		kubectl rollout status $"deployment/($d)" -n $entry.namespace $"--timeout=($timeout)"
	}
}

# Ensure Envoy Gateway's GatewayClass, `eg`, and the proxy behind it: on Kind
# a DaemonSet on the node's host ports, behind a tunnel a Service the tunnel
# dials by name. Every app's Gateway merges into the one proxy.
export def ensure-envoy-gateway-class [ingress: record = {by: "hostPort"}] {
	if $ingress.by == "tunnel" {
		envoy-proxy "tunnel-proxy" {envoyService: {type: "ClusterIP", name: $tunnel_gateway}} | kubectl apply -f -
		return
	}
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


# The EnvoyProxy `name` and the GatewayClass `eg` naming it, with tracing to
# Jaeger and `kubernetes` as its provider's settings.
export def envoy-proxy [name: string, kubernetes: record]: nothing -> string {
	[
		{
			apiVersion: "gateway.envoyproxy.io/v1alpha1", kind: "EnvoyProxy"
			metadata: {name: $name, namespace: "envoy-gateway-system"}
			spec: {
				mergeGateways: true
				telemetry: {tracing: {provider: {type: "OpenTelemetry", host: "jaeger.observability.svc.cluster.local", port: 4317}}}
				provider: {type: "Kubernetes", kubernetes: $kubernetes}
			}
		}
		{
			apiVersion: "gateway.networking.k8s.io/v1", kind: "GatewayClass"
			metadata: {name: "eg"}
			spec: {
				controllerName: "gateway.envoyproxy.io/gatewayclass-controller"
				parametersRef: {group: "gateway.envoyproxy.io", kind: "EnvoyProxy", name: $name, namespace: "envoy-gateway-system"}
			}
		}
	] | each { to yaml } | str join "---\n"
}

# cloudflared in the cluster, carrying every request for the tunnel's hosts to
# the gateway, which routes each by its host. The tunnel is the operator's,
# made once with `cloudflared tunnel create`; its credentials are the Secret
# `tunnel-credentials` in `cloudflared` (k8s/README.md#metal).
export def tunnel-manifests [id: string]: nothing -> string {
	let config = {
		tunnel: $id
		credentials-file: "/etc/cloudflared/credentials/credentials.json"
		metrics: "0.0.0.0:2000"
		no-autoupdate: true
		ingress: [{service: $"http://($tunnel_gateway).envoy-gateway-system.svc.cluster.local:80"}]
	}
	let labels = {"app.kubernetes.io/name": "cloudflared"}
	[
		{apiVersion: "v1", kind: "ConfigMap", metadata: {name: "cloudflared", namespace: "cloudflared"}, data: {"config.yaml": ($config | to yaml)}}
		{
			apiVersion: "apps/v1", kind: "Deployment"
			metadata: {name: "cloudflared", namespace: "cloudflared", labels: $labels}
			spec: {
				# Two connectors, so a restart of one drops no request.
				replicas: 2
				selector: {matchLabels: $labels}
				template: {
					metadata: {labels: $labels, annotations: {"pronto.dev/config": ($config | to json | hash sha256)}}
					spec: {
						containers: [{
							name: "cloudflared"
							image: $cloudflared
							args: ["tunnel" "--config" "/etc/cloudflared/config/config.yaml" "run"]
							livenessProbe: {httpGet: {path: "/ready", port: 2000}, failureThreshold: 1, initialDelaySeconds: 10, periodSeconds: 10}
							resources: {requests: {cpu: "10m", memory: "32Mi"}, limits: {memory: "128Mi"}}
							securityContext: {runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}
							volumeMounts: [
								{name: "config", mountPath: "/etc/cloudflared/config", readOnly: true}
								{name: "credentials", mountPath: "/etc/cloudflared/credentials", readOnly: true}
							]
						}]
						volumes: [
							{name: "config", configMap: {name: "cloudflared"}}
							{name: "credentials", secret: {secretName: "tunnel-credentials"}}
						]
					}
				}
			}
		}
	] | each { to yaml } | str join "---\n"
}

# The API through an SSH tunnel of this release's own (#Environment.access): a
# free local port forwarded to the node's 6443, which the release's kubeconfig
# names. Its remote end is a bounded sleep, so a release that dies leaves no
# tunnel past the hour; close-api-tunnel ends it when the release does.
export def open-api-tunnel [target: string, port: int, socket: string] {
	^ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -M -S $socket -f -L $"($port):127.0.0.1:6443" $target sleep 3600
	for _ in 1..30 {
		if (do { ^kubectl get --raw /readyz --request-timeout=5s } | complete).exit_code == 0 { return }
		sleep 1sec
	}
	error make {msg: $"the cluster's API does not answer through the tunnel to ($target)"}
}

export def close-api-tunnel [target: string, socket: string] {
	do { ^ssh -S $socket -O exit $target } | complete | ignore
}

# The registry a node's releases push to (#Environment.build.by "node"): on the
# node's own network, listening on its loopback alone, its blobs a directory on
# the node. Nothing outside the node reaches it but a release's SSH tunnel.
export def node-registry-manifests []: nothing -> string {
	[
		{apiVersion: "v1", kind: "Namespace", metadata: {name: "pronto-registry"}}
		{
			apiVersion: "apps/v1"
			kind: "Deployment"
			metadata: {name: "registry", namespace: "pronto-registry"}
			spec: {
				replicas: 1
				strategy: {type: "Recreate"}
				selector: {matchLabels: {app: "registry"}}
				template: {
					metadata: {labels: {app: "registry"}}
					spec: {
						hostNetwork: true
						containers: [{
							name: "registry"
							image: $node_registry
							env: [
								{name: "REGISTRY_HTTP_ADDR", value: $"127.0.0.1:($node_registry_port)"}
								{name: "REGISTRY_STORAGE_DELETE_ENABLED", value: "true"}
							]
							volumeMounts: [{name: "data", mountPath: "/var/lib/registry"}]
						}]
						volumes: [{name: "data", hostPath: {path: "/var/lib/pronto-registry", type: "DirectoryOrCreate"}}]
					}
				}
			}
		}
	] | each { to yaml } | str join "---\n"
}

# The node registry's images the cluster still names, by digest: every image of a
# pod, a ReplicaSet a rollback returns to, a workload's template or a database's
# imageName, read out of their JSON. An image named by tag alone keeps its tag.
export def node-registry-in-use [objects: string]: nothing -> list<record<repo: string, digest: string>> {
	$objects
	| parse --regex ('127\.0\.0\.1:' + ($node_registry_port | into string) + '/(?<repo>[a-z0-9._/-]+)(?::[A-Za-z0-9._-]+)?@(?<digest>sha256:[0-9a-f]{64})')
	| select repo digest
	| uniq
}

# The tag that holds a digest the cluster names (node-registry-in-use) through a prune.
export def node-registry-keep-tag [digest: string]: nothing -> string {
	$"keep-($digest | str replace 'sha256:' '' | str substring 0..15)"
}

# The node registry, cut to what is tagged: every digest the cluster names is
# tagged keep-<digest> first, a keep- tag whose digest nothing names any more is
# deleted, and the registry's garbage collector then deletes every untagged
# manifest and every blob none of the rest reference. `registry` is the registry
# as this release reaches it (forward-node-registry). Each release's push leaves
# the one before it untagged, so without this the node's disk only grows (PRONTO-154).
# Garbage collection deletes the blobs of a push still in flight, so a release
# skips it while another release's upload is open; the next release collects.
export def prune-node-registry [registry: string] {
	let kinds = ["pods" "replicasets" "deployments" "statefulsets" "daemonsets" "jobs" "cronjobs" "clusters.postgresql.cnpg.io"]
	let objects = ($kinds | each {|k| let r = (do { ^kubectl get $k -A -o json } | complete); if $r.exit_code == 0 { $r.stdout } else { "" } } | str join "\n")
	let in_use = (node-registry-in-use $objects)
	let accept = "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json"
	for it in $in_use {
		let url = $"http://($registry)/v2/($it.repo)/manifests"
		let got = (http get --raw --full --allow-errors --headers {Accept: $accept} $"($url)/($it.digest)")
		if $got.status != 200 { continue }
		let type = ($got.headers.response | where name == "content-type" | get value.0)
		http put --content-type $type $"($url)/(node-registry-keep-tag $it.digest)" $got.body | ignore
	}
	let catalog = (http get $"http://($registry)/v2/_catalog?n=1000" | get repositories)
	for repo in $catalog {
		let tags = (http get $"http://($registry)/v2/($repo)/tags/list" | get tags? | default [])
		let kept = ($in_use | where repo == $repo | each {|it| node-registry-keep-tag $it.digest })
		for t in ($tags | where {|t| ($t starts-with "keep-") and not ($t in $kept) }) {
			http delete $"http://($registry)/v2/($repo)/manifests/($t)" | ignore
		}
	}
	let uploads = (kubectl exec -n pronto-registry deploy/registry -- sh -c "find /var/lib/registry/docker/registry/v2/repositories -path '*/_uploads/*' -mindepth 1 -maxdepth 4 | head -1" | str trim)
	if ($uploads | is-not-empty) {
		print "The node's registry has an upload open (another release is pushing): its garbage collection waits for the next release."
		return
	}
	let before = (kubectl exec -n pronto-registry deploy/registry -- du -sh /var/lib/registry | split row "\t" | first)
	let gc = (do { ^kubectl exec -n pronto-registry deploy/registry -- registry garbage-collect --delete-untagged /etc/distribution/config.yml } | complete)
	if $gc.exit_code != 0 { error make {msg: $"the node's registry garbage collection failed: ($gc.stderr | lines | last 5 | str join (char nl))"} }
	$gc.stdout | lines | where {|l| $l =~ "eligible for deletion" } | each { print $in } | ignore
	let after = (kubectl exec -n pronto-registry deploy/registry -- du -sh /var/lib/registry | split row "\t" | first)
	print $"The node's registry: ($before) before its garbage collection, ($after) after."
}

export def ensure-node-registry [--timeout: string = "120s"] {
	node-registry-manifests | kubectl apply -f -
	kubectl rollout status deployment/registry -n pronto-registry $"--timeout=($timeout)"
}

# The node's registry through the release's SSH connection, on a free local
# port: Docker pushes to localhost without TLS, as Kind's own registry has it.
export def forward-node-registry [target: string, socket: string] {
	let local = (port)
	^ssh -S $socket -O forward -L $"($local):127.0.0.1:($node_registry_port)" $target
	for _ in 1..30 {
		if (do { ^curl -fsS $"http://localhost:($local)/v2/" } | complete).exit_code == 0 { return $local }
		sleep 1sec
	}
	error make {msg: $"the node's registry does not answer through the tunnel to ($target)"}
}

export def ensure-tunnel [id: string, --timeout: string = "90s"] {
	kubectl create namespace cloudflared --dry-run=client -o yaml | kubectl apply -f -
	if (kubectl get secret tunnel-credentials -n cloudflared --ignore-not-found -o name | str trim | is-empty) {
		error make {msg: $"the cluster has no credentials for tunnel ($id): kubectl create secret generic tunnel-credentials -n cloudflared --from-file=credentials.json=$HOME/.cloudflared/($id).json \(k8s/README.md#metal\)"}
	}
	tunnel-manifests $id | kubectl apply -f -
	kubectl rollout status deployment/cloudflared -n cloudflared $"--timeout=($timeout)"
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
# Each of the app's own services' compose environment, as release.cue does not set
# it (own: the keys it sets, which are the release's): a peer compose names at
# http://<service>:<port> is that service through the mesh, and SERVICE_JWT,
# PORT and ORIGIN are the manifest's own.
export def app-services-environment [compose: record, services: list<string>, own: record]: nothing -> record {
	let peers = ($compose.services | columns)
	$services | reduce -f {} {|n, acc|
		let set = ($own | get -o $n | default [])
		let given = ($compose.services | get $n | get environment? | default {} | transpose key value
			| where {|e| $e.key not-in $set and $e.key not-in ["SERVICE_JWT" "PORT" "ORIGIN"] }
			| reduce -f {} {|e, all| $all | insert $e.key ($peers | reduce -f ($e.value | default "" | into string) {|p, v| $v | str replace -r $"http://($p):[0-9]+" $"http://localhost:3500/v1.0/invoke/($p)/method" }) })
		$acc | insert $n {env: $given}
	}
}

# The ConfigMaps the app's services mount (App.services.<n>.files), made from the app's files that
# seed them (App.services.<n>.seed), each keyed by its file's name, when they are not there yet. One
# that exists is the operator's (pronto-flags push's): nothing in it changes, but a JSON seed fills in
# what it lacks (seed-fill), so a flag added since the ConfigMap was seeded reaches it with its
# default, not as an unknown flag.
export def seed-configmaps [services: record, app_dir: string, namespace: string] {
	for s in ($services | values) {
		for c in ($s.seed? | default {} | transpose name file) {
			let file = ($app_dir | path join $c.file)
			if not ($file | path exists) { error make { msg: $"ConfigMap ($c.name)'s seed ($file) does not exist" } }
			let key = ($file | path basename)
			let got = (kubectl get configmap $c.name -n $namespace -o json | complete)
			if $got.exit_code != 0 {
				kubectl create configmap $c.name -n $namespace $"--from-file=($key)=($file)" | ignore
				print $"Seeded ConfigMap ($namespace)/($c.name) from ($c.file)"
				continue
			}
			if not ($key | str ends-with ".json") { continue }
			let have = ($got.stdout | from json | get -o data | default {} | get -o $key)
			let seed = (open --raw $file | from json)
			let next = (if $have == null { $seed } else { seed-fill ($have | from json) $seed })
			if $have != null and $next == ($have | from json) { continue }
			kubectl patch configmap $c.name -n $namespace --type merge -p ({data: {$key: ($next | to json --indent 2)}} | to json -r) | ignore
			print $"Filled ConfigMap ($namespace)/($c.name) from ($c.file)"
		}
	}
}

# `have` with what `seed` has and it lacks: a missing top-level key, or a missing member of a top-level
# object (one flag of flagd's `flags`). Nothing `have` holds is changed, and nothing deeper is added,
# so a flag the operator changed keeps its variants and targeting as they are.
export def seed-fill [have: record, seed: record]: nothing -> record {
	$seed | transpose k v | reduce -f $have {|e, acc|
		let mine = ($acc | get -o $e.k)
		if $mine == null {
			$acc | upsert $e.k $e.v
		} else if (($mine | describe) =~ "^record" and ($e.v | describe) =~ "^record") {
			$acc | upsert $e.k ($e.v | transpose k v | reduce -f $mine {|m, inner| if ($inner | get -o $m.k) == null { $inner | upsert $m.k $m.v } else { $inner } })
		} else {
			$acc
		}
	}
}

# <name>-alert-rules: the app's alerting rules (App.alerting.rules), each file under its name, written
# every release so it follows the repository; vmalert reads a change within a minute.
export def apply-alert-rules [name: string, rules: list<string>, app_dir: string, namespace: string] {
	if ($rules | is-empty) { return }
	let names = ($rules | each {|r| $r | path basename })
	let twice = ($names | uniq -d)
	if ($twice | is-not-empty) { error make { msg: $"two alerting rule files share a name: ($twice | str join ', ')" } }
	let from = ($rules | each {|r|
		let file = ($app_dir | path join $r)
		if not ($file | path exists) { error make { msg: $"alerting rule file ($file) does not exist" } }
		$"--from-file=($r | path basename)=($file)"
	})
	kubectl create configmap $"($name)-alert-rules" -n $namespace ...$from --dry-run=client -o yaml | kubectl apply -f - | ignore
}

# The database's backups to an S3 store read their keys from a Secret the operator keeps: without it the
# Cluster could archive no WAL, which piles up on the node until its disk fills.
export def check-backup-secrets [objects: list, namespace: string] {
	for store in ($objects | where kind == "ObjectStore" | where {|s| $s.spec.configuration.s3Credentials? != null }) {
		let secret = $store.spec.configuration.s3Credentials.accessKeyId.name
		let keys = (do { kubectl get secret $secret -n $namespace -o json } | complete)
		let data = if $keys.exit_code == 0 { $keys.stdout | from json | get data? | default {} } else { {} }
		if not ("ACCESS_KEY_ID" in ($data | columns) and "ACCESS_SECRET_KEY" in ($data | columns)) {
			error make { msg: $"database.backup: Secret ($secret) in ($namespace) needs ACCESS_KEY_ID and ACCESS_SECRET_KEY, the object store's keys \(kubectl create secret generic ($secret) -n ($namespace) --from-literal=ACCESS_KEY_ID=... --from-literal=ACCESS_SECRET_KEY=...\)" }
		}
	}
}

# <name>-service-jwt: the service role's token, signed with <name>-auth-secrets'
# PGRST_JWT_SECRET, restated each release so it follows the secret. The value
# goes through stdin, never a command line.
def ensure-service-jwt [name: string, namespace: string] {
	let key = (kubectl get secret $"($name)-auth-secrets" -n $namespace -o jsonpath='{.data.PGRST_JWT_SECRET}' | decode base64 | decode utf-8)
	if ($key | is-empty) { error make { msg: $"secret ($name)-auth-secrets has no PGRST_JWT_SECRET yet" } }
	service-jwt $key | kubectl create secret generic $"($name)-service-jwt" -n $namespace --from-file=SERVICE_JWT=/dev/stdin --dry-run=client -o yaml | kubectl apply -f - | ignore
}

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

export def runtime-services [compose: record]: nothing -> record {
	let supported = ["compute" "feldera" "redis" "conduit" "mesh-events" "transform" "ticker" "clock" "rclone-s3" "imgproxy"]
	if "airlock" in $compose.services {
		error make {msg: "native release does not yet deploy airlock; refusing to omit a runtime service"}
	}
	let names = ($compose.services | columns | where {|s| $s in $supported })
	$names | reduce -f {} {|name, acc|
		let vars = ($compose.services | get $name | get -o environment | default {})
		if $name == "compute" and ($vars.DUCKSTREAM_ENGINE? | default "") != "feldera" {
			error make {msg: "native release requires DUCKSTREAM_ENGINE=feldera for compute"}
		}
		$acc | insert $name {
			env: ($vars | reject -o DATABASE_URL FELDERA_DATABASE_URL SERVICE_JWT PGRST_JWT_SECRET CONDUIT_DB_TYPE CONDUIT_DB_POSTGRES_CONNECTION_STRING)
			databaseEnvironment: ([DATABASE_URL FELDERA_DATABASE_URL] | where {|key| $key in $vars })
			serviceToken: ("SERVICE_JWT" in $vars)
			jwtSecret: ("PGRST_JWT_SECRET" in $vars)
		}
	}
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
	# What the compose project runs beside the cluster (runtime.cue), on every cluster but metal,
	# whose release names its services itself (App.services, App.blobs) and runs no other.
	let app_dir = ($cue_path | path dirname)
	let runtime = if $env_name != "metal" and ($app_dir | path join compose.yaml | path exists) {
		runtime-services (do { cd $app_dir; docker compose --profile "*" config --format json } | from json)
	} else { {} }
	{App: {database: {tokenRoles: $facts.tokenRoles, replays: ($facts.replays? | default [])}, runtime: $runtime, doors: ($facts.doors? | default [])}} | to json | save -f $roles_file
	let inputs = [$cue_path $roles_file] | append (if ($data | is-not-empty) { [$data] } else { [] })
	let res = (do { cue export --expression $expr --out text ...$inputs } | complete)
	rm $roles_file
	if $res.exit_code != 0 {
		error make { msg: $"Failed to render CUE manifests: ($res.stderr)" }
	}
	$res.stdout
}

# The target environment's #Environment: the app's own where its release.cue
# gives one (a metal cluster's context, registry and tunnel are the
# operator's), else pronto's, from k8s/envs.
export def read-environment [cluster_env: string, cue_path?: string]: nothing -> record {
	let field = { kind: "Kind", eks: "EKS", aks: "AKS", metal: "Metal" } | get $cluster_env
	if ($cue_path | is-not-empty) and (defines $cue_path $field) {
		let own = (do { cue export --expression $field $cue_path } | complete)
		if $own.exit_code != 0 { error make { msg: $"Failed to read ($cluster_env) environment from ($cue_path): ($own.stderr)" } }
		return ($own.stdout | from json)
	}
	let res = (do { cd $k8s_dir; cue export --expression $field ./envs } | complete)
	if $res.exit_code != 0 {
		error make { msg: $"Failed to read ($cluster_env) environment: ($res.stderr)" }
	}
	$res.stdout | from json
}

# Whether the release package at `cue_path` defines `field`.
export def defines [cue_path: string, field: string]: nothing -> bool {
	let r = (do { cue eval --expression $field $cue_path } | complete)
	not ($r.exit_code != 0 and ($r.stderr =~ $"reference \"($field)\" not found"))
}

# Where a release goes when it is not told: the app's metal cluster, where its
# release.cue gives one, else Kind.
export def default-environment [cue_path: string]: nothing -> string {
	if (defines $cue_path "Metal") { "metal" } else { "kind" }
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
# What release-tree changes, as a compose file read over the app's own: each
# service that builds from an `<app>-served` stage builds from its release.
export def release-override []: string -> string {
	let project = ($in | from yaml)
	let released = ($in | release-tree | from yaml)
	let changed = ($project.services | columns | where {|n|
		($project.services | get $n | get -o build.additional_contexts) != ($released.services | get $n | get -o build.additional_contexts)
	})
	{services: ($changed | reduce -f {} {|n, acc| $acc | insert $n {build: {additional_contexts: ($released.services | get $n | get build.additional_contexts | transpose key value | where {|c| $c.value ends-with "-served-release" } | reduce -f {} {|c, a| $a | insert $c.key $c.value })}} })} | to yaml
}

# The Postgres major an image at `repo@digest` in Artifact Registry runs, as
# its official base states it (PG_MAJOR), read from the registry: CloudNativePG
# reads the database's tag as it, and Cloud Build left no image here to inspect.
export def registry-pg-major [repo: string, digest: string]: nothing -> string {
	let host = ($repo | split row "/" | first)
	let path = ($repo | split row "/" | skip 1 | str join "/")
	let headers = [
		Authorization $"Bearer (^gcloud auth print-access-token | str trim)"
		Accept "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
	]
	let get = {|what| http get --raw --headers $headers $"https://($host)/v2/($path)/($what)" | if ($in | describe) == "binary" { decode utf-8 } else { $in } | from json }
	let top = (do $get $"manifests/($digest)")
	let manifest = if ($top.manifests? | is-not-empty) { do $get $"manifests/($top.manifests | first | get digest)" } else { $top }
	do $get $"blobs/($manifest.config.digest)" | get config.Env | where {|e| $e starts-with "PG_MAJOR=" } | first | split row "=" | last
}

# The runtime images built in Cloud Build and pushed to the environment's
# registry (gcp/build.nu), by service: the database's tagged with its Postgres
# major, every other with the release's tag.
export def cloud-build-images [app_dir: string, name: string, services: list<string>, target_env: record, tag: string]: nothing -> record {
	let override = (do { cd $app_dir; ^docker compose --profile "*" config } | release-override)
	let plan = {project: $target_env.build.project, registry: $target_env.registry, preview: $tag}
	let built = (push-images $app_dir $plan $name $services --platform ($target_env.platform? | default "linux/amd64") --override $override)
	$built | items {|svc, ref|
		let ref = ($ref | reject -o key)
		if $svc != "database" { return {svc: $svc, ref: $ref} }
		let repo = $"($target_env.registry)/($name)-database"
		let major = (registry-pg-major $repo $ref.digest)
		^gcloud --quiet artifacts docker tags add $"($repo)@($ref.digest)" $"($repo):($major)" | ignore
		{svc: $svc, ref: {tag: $major, digest: $ref.digest}}
	} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
}

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
		# The app's Android builds whose passkeys auth admits (capabilities.auth.android).
		android: ($environment.WEBAUTHN_ANDROID_ORIGINS? | default "")
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
	--cluster-env (-e): string  # kind, metal, gke, eks or aks; absent, the app's metal cluster where it gives one, else kind
	--skip-operators = false # Skip operator bootstrap
	--skip-observability = false # Skip VictoriaMetrics/Jaeger/Vector bootstrap
	--preview: string = ""   # Release the whole stack into a namespace of its own, `<name>-<preview>`, beside the released one
	--delete                 # With --preview: remove that preview's namespace (its database and secrets with it)
] {
	let app_info = (resolve-app $app)
	let cluster_env = ($cluster_env | default $env.SAY_RELEASE_ARGS_CLUSTER_ENV? | default (default-environment $app_info.cue_path))
	if $delete and ($preview | is-empty) {
		error make { msg: "--delete removes a preview: name it with --preview=<name>. A release is never deleted from here." }
	}
	# A preview is the release under another name (App.preview, k8s/schema/release.cue), unified into the package.
	let preview_file = if ($preview | is-not-empty) {
		let f = (mktemp -t preview.XXXXXX.json | str trim)
		{App: {preview: $preview}} | to json | save -f $f
		$f
	} else { "" }
	let manifests = if ($preview_file | is-not-empty) { render-manifests $app_info.cue_path $cluster_env --data $preview_file } else { render-manifests $app_info.cue_path $cluster_env }

	if $dry_run {
		print $manifests
		return
	}

	if $snapshot {
		print $"Snapshot mode: manifests rendered for ($app_info.name) \(($cluster_env)\). No cluster mutations."
		return
	}

	# A cloud release needs its operators, observability and TLS on the target,
	# which only the Kind, metal and GKE paths provision so far.
	if $cluster_env not-in ["kind" "metal" "gke"] {
		error make { msg: $"release to ($cluster_env) is not implemented: only --dry-run and --snapshot render its manifests" }
	}

	let root = (git rev-parse --show-toplevel | str trim)
	let app_source_dir = $app_info.dir

	let meta_res = (do { cue export --expression "{name: App.name, id: App.id, ns: App.ns, namespace: App.namespace, type: App.type, image: App.image, render: App.render, services: App.services, alerting: App.alerting, blobs: len([if App.blobs != _|_ {1}]) > 0, own: {for n, s in App.services {(n): [for k, _ in s.env {k}]}}}" $app_info.cue_path ...(if ($preview_file | is-not-empty) { [$preview_file] } else { [] }) } | complete)
	if $meta_res.exit_code != 0 {
		error make { msg: $"Failed to read release metadata from ($app_info.cue_path): ($meta_res.stderr)" }
	}
	let app_meta = ($meta_res.stdout | from json)

	let target_ns = $app_meta.ns
	let rname = $app_meta.id
	let gateway_host = ($manifests | from yaml | where kind == "Gateway" | get 0.spec.listeners.0.hostname)
	let workload_name = $app_meta.id
	let is_pronto = ($app_meta.type == "pronto")
	let has_render = $app_meta.render.enabled

	# The caddy image proxies its SSR routes to `render` whenever the app builds one,
	# so a release that omits it serves 502 on every rendered page.
	let compose_services = (do { cd $app_source_dir; docker compose --profile "*" config --services } | lines)
	let compose_render = ("render" in $compose_services)
	if $compose_render != $has_render {
		error make { msg: $"($app_info.cue_path): render.enabled is ($has_render) but the app's compose project (if $compose_render { 'defines' } else { 'lacks' }) a render service" }
	}

	# The app's own services (App.services), each a service of its compose project.
	let services = ($app_meta.services | columns)
	let missing = ($services | where {|s| $s not-in $compose_services })
	if ($missing | is-not-empty) {
		error make { msg: $"($app_info.cue_path): App.services names ($missing | str join ', '), which the app's compose project lacks" }
	}

	# The blob plane (App.blobs) is the app's rclone-s3 and imgproxy compose services, built and pushed
	# as its own services are.
	let blob_svcs = if $app_meta.blobs { ["rclone-s3" "imgproxy"] } else { [] }
	let blobs_missing = ($blob_svcs | where {|s| $s not-in $compose_services })
	if ($blobs_missing | is-not-empty) {
		error make { msg: $"($app_info.cue_path): App.blobs needs the app's compose project to define ($blobs_missing | str join ', ')" }
	}

	let target_env = if $cluster_env == "gke" {
		let config = (^cue export --expression GKE --out json $app_info.cue_path | from json)
		let kubeconfig = (mktemp -t kubeconfig.XXXXXX | str trim)
		kubectl config view --minify --flatten --context $config.context | save -f $kubeconfig
		$env.KUBECONFIG = $kubeconfig
		$config.environment
	} else { read-environment $cluster_env $app_info.cue_path }
	let registry = $target_env.registry
	if $cluster_env == "gke" {
		kubectl get crd clusters.postgresql.cnpg.io externalsecrets.external-secrets.io configurations.dapr.io gateways.gateway.networking.k8s.io backendtrafficpolicies.gateway.envoyproxy.io | ignore
		kubectl get gatewayclass $target_env.gatewayClassName | ignore
		let tls = ($manifests | from yaml | where kind == "Gateway" | first | get spec.listeners | where protocol == "HTTPS" | get -o 0.tls.certificateRefs.0.name)
		if ($tls | is-not-empty) { kubectl get secret $tls -n $target_ns | ignore }
	}

	# Kind's cluster is made here; a metal one is the operator's, named by its context.
	if $cluster_env == "kind" { ensure-cluster }
	let context = ($target_env.context? | default (open --raw ($k8s_dir | path join "cluster.yaml") | from yaml | where kind == "Cluster" | first | get name))
	# Every kubectl call below targets this cluster, whatever context is current.
	let kubeconfig = (mktemp -t kubeconfig.XXXXXX | str trim)
	kubectl config view --minify --flatten --context $context | save -f $kubeconfig
	$env.KUBECONFIG = $kubeconfig
	let tunnel = if ($target_env.access? | is-not-empty) {
		let t = {target: $target_env.access.ssh, port: (port), socket: $"/tmp/pronto-api-(random chars --length 8).sock"}
		kubectl config set-cluster (kubectl config view -o jsonpath='{.clusters[0].name}') --server $"https://127.0.0.1:($t.port)" | ignore
		open-api-tunnel $t.target $t.port $t.socket
		$t
	}
	let reopen = if $tunnel != null { {|| close-api-tunnel $tunnel.target $tunnel.socket; open-api-tunnel $tunnel.target $tunnel.port $tunnel.socket } }
	# A preview's namespace holds everything it made (its database and the volumes, its secrets and routes):
	# deleting it deletes them. It is the preview's own: `ns` is never the released namespace.
	if $delete {
		if $target_ns == $app_meta.namespace { error make { msg: $"refusing to delete ($target_ns): it is the release's own namespace, not a preview's" } }
		print $"Deleting the preview ($preview): namespace ($target_ns)..."
		kubectl delete namespace $target_ns --ignore-not-found --wait=true --timeout=300s
		if $tunnel != null { close-api-tunnel $tunnel.target $tunnel.socket }
		print $"[SUCCESS] Deleted the preview ($preview) of ($app_info.name) from ($cluster_env)."
		return
	}
	if not $skip_operators {
		ensure-operators --ingress $target_env.ingress --reopen $reopen
		if $target_env.ingress.by == "tunnel" { ensure-tunnel $target_env.ingress.id }
	}
	if not $skip_observability {
		ensure-observability $target_env.domainSuffix
	}


	# Ensure target namespace exists before creating namespaced prerequisites
	kubectl create namespace $target_ns --dry-run=client -o yaml | kubectl apply -f -

	if not $is_pronto {
		error make { msg: $"Only Pronto applications are supported for k8s release: ($app_info.name)" }
	}

	# migrate runs where the app has ledger migrations or permissions to reconcile, as in compose.
	let has_migrate = ("migrate" in $compose_services)
	let build_svcs = ["database" "crud" "electric" "auth" "caddy"] | append (if $has_migrate { ["migrate"] } else { [] }) | append (if $has_render { ["render"] } else { [] }) | append $services | append $blob_svcs
	print $"Building native Pronto services \(($build_svcs | str join ', ')\) for ($app_info.name)..."
	# A node's registry is pushed to through this release's tunnel, on a local
	# port, while the manifests name it as the node sees it (registry).
	let push_registry = if $target_env.build.by == "node" {
		ensure-node-registry
		$"localhost:(forward-node-registry $tunnel.target $tunnel.socket)"
	} else { $registry }
	let pushed = if $target_env.build.by == "cloudbuild" {
		cloud-build-images $app_source_dir $app_info.name $build_svcs $target_env $app_meta.image.tag
	} else {
		let bake_targets = (bake-images $app_source_dir (do { cd $app_source_dir; docker compose --profile "*" config }) $build_svcs --platform ($target_env.platform? | default ""))
		$build_svcs | each {|svc|
			let local = ($bake_targets | get $svc | get tags | where {|t| $t ends-with ":latest" } | first)
			# The database's tag is its Postgres major, which CloudNativePG reads; the
			# official postgres base the image derives from states it as PG_MAJOR.
			let tag = if $svc == "database" {
				docker image inspect --format '{{json .Config.Env}}' $local | from json | where {|e| $e starts-with "PG_MAJOR=" } | first | split row "=" | last
			} else { $app_meta.image.tag }
			let repo = if ($push_registry | is-not-empty) { $"($push_registry)/($app_info.name)-($svc)" } else { $"($app_info.name)-($svc)" }
			docker tag $local $"($repo):($tag)"
			if ($push_registry | is-not-empty) {
				print $"Pushing ($repo):($tag)..."
				docker push $"($repo):($tag)"
			}
			let digest = (docker image inspect --format '{{json .RepoDigests}}' $"($repo):($tag)" | from json | where {|d| $d starts-with $"($repo)@" } | first | split row "@" | last)
			{svc: $svc, ref: {tag: $tag, digest: $digest}}
		} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref }
	}
	# What compose gives the migrate service beyond the database it names.
	let migrate = if $has_migrate {
		{migrate: {env: (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json | get services.migrate.environment | reject DATABASE_URL)}}
	} else { {} }
	# The providers compose gives the auth service, and each one's client:
	# compose refuses to render a provider whose client is unset.
	# What release.cue sets is the release's, over compose's, as gcp/release.nu's auth.oidc is.
	let fixed = (^cue export --expression App.auth.oidc --out json $app_info.cue_path | from json | columns)
	let oidc = (auth-provider-environment (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json | get services.auth.environment | reject -o ...$fixed))
	let own_env = (app-services-environment (do { cd $app_source_dir; docker compose --profile "*" config --format json } | from json) $services $app_meta.own)
	let pushed_file = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: ({image: {pushed: $pushed}, auth: ($oidc | reject secretValues)} | merge $migrate | merge (if ($services | is-empty) { {} } else { {services: $own_env} }) | merge (if ($preview | is-empty) { {} } else { {preview: $preview} }))} | to json | save -f $pushed_file
	let released = (render-manifests $app_info.cue_path $cluster_env --data $pushed_file)
	rm $pushed_file

	# Ingress / Gateway TLS secret for Kind HTTPS parity
	if $cluster_env == "kind" {
		ensure-tls-secret $rname $app_source_dir $target_ns $gateway_host
	}

	# secrets.enc.yaml holds sandbox keys, which a production cluster must never get.
	if $cluster_env == "kind" {
		apply-sops-secrets $rname $app_source_dir $target_ns
	}
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
	check-backup-secrets ($released | from yaml) $target_ns
	print $"Applying manifests for ($rname)..."
	$docs | where {|d| not ($d in $deployments_yaml or $d in $jobs_yaml) } | str join "\n---\n" | kubectl apply -f -

	# The cluster's status names a new image as soon as it starts rolling onto it,
	# and Ready stays true through the restart: the database is there once its
	# primary runs that image and is ready itself.
	let db_image = ($released | from yaml | where kind == "Cluster" | first | get spec.imageName)
	print $"Waiting for CloudNativePG cluster ($rname)-db in ($target_ns) on ($db_image)..."
	# The old primary's stop (its stopDelay, up to the Cluster's 120 s; a pod made before that bound
	# keeps its 1800 s) and the new one's start.
	let grace = ($released | from yaml | where kind == "Cluster" | first | get -o spec.stopDelay | default 0)
	let deadline = (date now) + (($grace + 300) * 1sec)
	loop {
		let primary = (kubectl get pods -n $target_ns -l $"cnpg.io/cluster=($rname)-db,cnpg.io/instanceRole=primary" -o json | from json | get items
			| where {|p| $p.metadata.deletionTimestamp? == null and ($p.spec.containers | where name == "postgres" | first | get image) == $db_image and ($p.status.conditions? | default [] | any {|c| $c.type == "Ready" and $c.status == "True" }) })
		if ($primary | is-not-empty) { break }
		if (date now) > $deadline { error make { msg: $"cluster/($rname)-db has no ready primary on ($db_image)" } }
		sleep 3sec
	}

	for job in (["initdb"] | append (if $has_migrate { ["migrate"] } else { [] })) {
		run-job ($jobs_yaml | where {|d| $d =~ $"\(?m\)^  name: ($rname)-($job)\\s*$" } | first) $"($rname)-($job)" $target_ns
	}

	# authenticator's memberships name roles initdb creates, so the operator
	# reconciles it, password included, only after the Jobs; crud logs in as it.
	let cluster = $"cluster.postgresql.cnpg.io/($rname)-db"
	# An attempt made before the Jobs (the instance is up first) stays failed:
	# CloudNativePG syncs roles when the Cluster changes, not on a timer, so a
	# first release on k3s waited out its five minutes on a role that was
	# already there. Changing the Cluster has it look again.
	kubectl annotate $cluster -n $target_ns --overwrite $"pronto.dev/schema-built=(date now | format date '%s')" | ignore
	print $"Waiting for ($cluster) to reconcile its managed roles..."
	let deadline = (date now) + 300sec
	loop {
		let roles = (kubectl get $cluster -n $target_ns -o json | from json | get status.managedRolesStatus? | default {})
		let pending = ($roles.cannotReconcile? | default {} | columns | append ($roles.byStatus?.pending-reconciliation? | default []))
		if ("authenticator" in ($roles.byStatus?.reconciled? | default [])) and ($pending | is-empty) { break }
		if (date now) > $deadline { error make { msg: $"($cluster) has not reconciled its managed roles: ($roles | to nuon)" } }
		sleep 3sec
	}

	# The app's own services call crud as the service role, with a token signed by
	# the JWT secret the cluster generated (an ExternalSecret, there by now: crud
	# logs in with it).
	if ($services | is-not-empty) { ensure-service-jwt $workload_name $target_ns }
	seed-configmaps $app_meta.services $app_source_dir $target_ns
	apply-alert-rules $workload_name ($app_meta.alerting?.rules? | default []) $app_source_dir $target_ns

	# A changed image digest rolls its deployment; an unchanged one has nothing to roll.
	$deployments_yaml | str join "\n---\n" | kubectl apply -f -
	let components = ["crud" "electric" "auth" "caddy"] | append (if $has_render { ["render"] } else { [] }) | append $services | append $blob_svcs
	for d in ($components | each { $"deployment/($rname)-($in)" }) {
		print $"Waiting for ($d) rollout..."
		kubectl rollout status $d -n $target_ns --timeout=180s
	}
	# The renderer reads the app through the door once, as it starts: one that rolled beside the door
	# may have read the old door's catalogues and handlers, and renders every page a 500 until it starts
	# again ("unknown message", "no Jessie module": PRONTO-154). So it starts again once the door has.
	if $has_render {
		kubectl rollout restart $"deployment/($rname)-render" -n $target_ns
		kubectl rollout status $"deployment/($rname)-render" -n $target_ns --timeout=180s
	}
	if $target_env.build.by == "node" { prune-node-registry $push_registry }

	# The mesh is intrinsic to a k8s release: a pod the injector let through bare is a failed release.
	let bare = (kubectl get pods -n $target_ns -l $"app.kubernetes.io/name=($rname),app.kubernetes.io/component in \(($components | str join ',')\)" --field-selector=status.phase=Running -o json
		| from json | get items
		| where {|p| $p.metadata.deletionTimestamp? == null and not ($p.spec.containers.name | any {|c| $c == "daprd" }) }
		| get metadata.name)
	if ($bare | is-not-empty) {
		error make { msg: $"Pods running without their Dapr sidecar: ($bare | str join ', ')" }
	}

	if $target_env.ingress.by == "tunnel" and ($preview | is-empty) {
		print $"The tunnel answers for ($gateway_host) once its DNS is a proxied CNAME onto ($target_env.ingress.id).cfargotunnel.com: cloudflared tunnel route dns ($target_env.ingress.id) ($gateway_host)"
	}
	if $tunnel != null { close-api-tunnel $tunnel.target $tunnel.socket }
	if ($preview | is-not-empty) {
		print $"\n[SUCCESS] Released the preview ($preview) of ($app_info.name) to ($cluster_env), namespace ($target_ns): no public name; reach it with kubectl port-forward -n ($target_ns) svc/caddy 18080:8080 and remove it with --preview=($preview) --delete"
	} else {
		print $"\n[SUCCESS] Released ($rname) natively to ($cluster_env): https://($gateway_host)/"
	}
}

