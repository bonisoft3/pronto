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
# What a registry is asked for a manifest: any of the four kinds a build pushes.
const registry_accept = "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json"

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
		# Every replica hot, serving the operator's gRPC (the owner, 2026-11-12: "I don't want
		# replicas idle. I want the hot with traffic"): with leader election a standby opens no
		# port 9090, so it took no traffic and was never Ready (PRONTO-391). Its reconcilers write
		# a cluster's Role and RoleBinding by server-side apply, the same from either replica.
		drop_args: ["--leader-elect"]
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

# The operators an environment installs: OPERATORS, with Dapr's control plane in HA where the
# environment asks for it (#Environment.dapr.ha) or the cluster already runs it so (`ha_now`, its
# sentry's replicas over one): Dapr is shared by every app, and a release whose own environment
# says nothing must not take the cluster's HA away. In HA, placement and scheduler are
# StatefulSets of 3 the release waits for too.
export def operators-for [environment: record, --ha-now]: nothing -> list {
	let ha = ($environment.dapr?.ha? | default false) or $ha_now
	$OPERATORS | each {|e|
		if $e.name == "dapr" and $ha {
			$e | upsert set ($e.set | append "global.ha.enabled=true") | insert check_statefulsets ["dapr-placement-server" "dapr-scheduler-server"]
		} else { $e }
	}
}

# The replicas each controller of an operator runs, set after its manifests are applied (a static
# manifest's own count would win again at the next apply otherwise): `controllers`, the
# environment's #Environment.controllers (2 on metal, leader-elected, so n+1; 1 elsewhere, as the
# manifests have them). Dapr's control plane counts by its own HA (operators-for).
export def controller-replicas [operators: list, controllers: int]: nothing -> list {
	$operators | each {|e|
		if $e.name == "dapr" or ($e.check_deployments? | default [] | is-empty) or $controllers <= 1 { $e } else { $e | insert replicas $controllers }
	}
}

# Whether the cluster's Dapr runs in HA now: its sentry at more than one replica.
def dapr-ha-now []: nothing -> bool {
	let r = (do { kubectl get deployment dapr-sentry -n dapr-system -o jsonpath={.spec.replicas} } | complete)
	if $r.exit_code != 0 { return false }
	(try { $r.stdout | str trim | into int } catch { 1 }) > 1
}

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
	let ext = ($entry.ext? | default (if $is_helm { "tgz" } else { "yaml" }))
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
	--environment: record = {} # the target's #Environment (its dapr.ha)
] {
	let operators = (if (dapr-ha-now) { operators-for $environment --ha-now } else { operators-for $environment }
		| controller-replicas $in ($environment.controllers? | default 1))
	for entry in $operators {
		try { install-operator $entry $timeout } catch {|e|
			if $reopen == null { error make {msg: $e.msg} }
			print $"($entry.name) failed through the tunnel to the API \(($e.msg)\): opening it again"
			do $reopen
			install-operator $entry $timeout
		}
	}

	ensure-envoy-gateway-class $ingress
}

# A manifest without the container arguments named, each a list item of its own (`- --flag`),
# as text so the rest of the manifest is applied byte for byte.
export def drop-args [args: list]: string -> string {
	let text = $in
	$args | reduce -f $text {|a, t| $t | str replace --all --regex $"\(?m\)^[ \t]*- ['\"]?($a)['\"]?[ \t]*\r?\n" "" }
}

# The StatefulSets an apply's stderr says it refused for an immutable field.
export def immutable-statefulsets [stderr: string]: nothing -> list<string> {
	$stderr | lines
		| where {|l| $l =~ 'is invalid: spec: Forbidden: updates to statefulset spec for fields other than' }
		| each {|l| $l | parse --regex 'The StatefulSet "(?<name>[^"]+)" is invalid' | get name }
		| flatten
		| uniq
}

# One operator: its manifests applied, its deployments waited for.
def install-operator [entry: record, timeout: string] {
	if ($entry.namespace? | is-not-empty) {
		kubectl create namespace $entry.namespace --dry-run=client -o yaml | kubectl apply -f -
	}

	let fetched = (fetch-verified $entry)
	let file = if ($entry.drop_args? | default [] | is-empty) { $fetched } else {
		let out = $"($fetched).hot.yaml"
		open --raw $fetched | drop-args ($entry.drop_args) | save --force --raw $out
		$out
	}
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
		let manifests = ($docs | where {|d| not (do $is_crd $d) } | str join "\n---\n")
		let applied = (do { $manifests | kubectl apply -n $entry.namespace --server-side --force-conflicts --validate=false --request-timeout=120s -f - } | complete)
		print -n $applied.stdout
		if $applied.exit_code != 0 {
			# A StatefulSet's volumeClaimTemplates, selector and serviceName are immutable: Dapr's
			# placement gains a raft-log volume per replica when its control plane turns HA
			# (PRONTO-395), and the apply is refused. The set is deleted and applied again: placement
			# rebuilds its tables from the sidecars, and every replica then serves.
			let stale = (immutable-statefulsets $applied.stderr)
			if ($stale | is-empty) { error make { msg: $"($entry.name): kubectl apply failed: ($applied.stderr)" } }
			for name in $stale {
				print $"statefulset/($name) has an immutable field that differs: deleting it to apply it again"
				kubectl delete statefulset $name -n $entry.namespace --wait
			}
			$manifests | kubectl apply -n $entry.namespace --server-side --force-conflicts --validate=false --request-timeout=120s -f -
		}
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

	if ($entry.replicas? | is-not-empty) {
		for d in ($entry.check_deployments? | default []) {
			kubectl scale $"deployment/($d)" -n $entry.namespace $"--replicas=($entry.replicas)"
		}
	}
	for d in ($entry.check_deployments? | default []) {
		print $"Waiting for deployment ($d) in ($entry.namespace)..."
		kubectl rollout status $"deployment/($d)" -n $entry.namespace $"--timeout=($timeout)"
	}
	# A StatefulSet's first rollout binds a volume per pod and pulls its image: five minutes.
	for d in ($entry.check_statefulsets? | default []) {
		print $"Waiting for statefulset ($d) in ($entry.namespace)..."
		kubectl rollout status $"statefulset/($d)" -n $entry.namespace --timeout=300s
	}
}

# Ensure Envoy Gateway's GatewayClass, `eg`, and the proxy behind it: on Kind
# a DaemonSet on the node's host ports, behind a tunnel a Service the tunnel
# dials by name. Every app's Gateway merges into the one proxy.
export def ensure-envoy-gateway-class [ingress: record = {by: "hostPort"}] {
	if $ingress.by == "tunnel" {
		envoy-proxy "tunnel-proxy" (tunnel-proxy-kubernetes) | kubectl apply -f -
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
# The node's one proxy behind the tunnel, n+1 (PRONTO-361): three Envoy pods, a budget of two through
# a drain or an eviction, spread over the nodes where it can (on one node they schedule as before).
export const proxy_pods = {
	"app.kubernetes.io/name": "envoy"
	"gateway.envoyproxy.io/owning-gatewayclass": "eg"
}
export def tunnel-proxy-kubernetes []: nothing -> record {
	{
		envoyService: {type: "ClusterIP", name: $tunnel_gateway}
		envoyDeployment: {
			replicas: 3
			pod: {topologySpreadConstraints: [(spread-over-nodes $proxy_pods)]}
		}
		envoyPDB: {minAvailable: 2}
	}
}

# A topologySpreadConstraint over the nodes' hostnames that schedules anyway where it cannot spread:
# k8s.cue's for an app's workloads, here for the edge's.
export def spread-over-nodes [labels: record]: nothing -> record {
	{maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway", labelSelector: {matchLabels: $labels}}
}

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
				# Three connectors, n+1 with a budget of two (PRONTO-361): a restart, an eviction or a
				# release of one drops no request.
				replicas: 3
				selector: {matchLabels: $labels}
				template: {
					metadata: {labels: $labels, annotations: {"pronto.dev/config": ($config | to json | hash sha256)}}
					spec: {
						topologySpreadConstraints: [(spread-over-nodes $labels)]
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
		{
			apiVersion: "policy/v1", kind: "PodDisruptionBudget"
			metadata: {name: "cloudflared", namespace: "cloudflared", labels: $labels}
			spec: {minAvailable: 2, selector: {matchLabels: $labels}}
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
	for it in $in_use {
		let there = (http head --full --allow-errors --headers {Accept: $registry_accept} $"http://($registry)/v2/($it.repo)/manifests/($it.digest)" | get status)
		if $there == 200 { node-registry-tag $registry $it.repo $it.digest (node-registry-keep-tag $it.digest) }
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
	$gc.stdout | lines | where {|l| $l =~ "blobs marked" } | each { print $in } | ignore
	let after = (kubectl exec -n pronto-registry deploy/registry -- du -sh /var/lib/registry | split row "\t" | first)
	print $"The node's registry: ($before) before its garbage collection, ($after) after."
}

export def ensure-node-registry [--timeout: string = "120s"] {
	node-registry-manifests | kubectl apply -f -
	kubectl rollout status deployment/registry -n pronto-registry $"--timeout=($timeout)"
}

# The node's builder (#Environment.build.by "buildkit"): a rootless buildkitd on
# the node's network, listening on its loopback alone, so it pushes to the node's
# registry as the node sees it (127.0.0.1:5000) and nothing outside the node
# reaches it but a port-forward through the cluster's API, which RBAC grants:
# a release that has neither Docker nor SSH (Studio's builder) builds through it.
# Its cache is a directory on the node, trimmed to gckeepstorage (PRONTO-154).
const node_buildkit = "moby/buildkit:v0.29.0-rootless@sha256:93efd7f1c17f16cea080c34f68e19863b9fe541db550bf607221ce425c0ab9ef"
const node_buildkit_port = 1234

export def node-buildkit-manifests []: nothing -> string {
	let state = {name: "state", mountPath: "/home/user/.local/share/buildkit"}
	[
		{apiVersion: "v1", kind: "Namespace", metadata: {name: "pronto-buildkit"}}
		{
			apiVersion: "v1", kind: "ConfigMap"
			metadata: {name: "buildkitd", namespace: "pronto-buildkit"}
			data: {"buildkitd.toml": ([
				$'[registry."127.0.0.1:($node_registry_port)"]'
				"  http = true"
				"[worker.oci]"
				"  gc = true"
				'  gckeepstorage = "20GB"'
			] | str join "\n")}
		}
		{
			apiVersion: "apps/v1"
			kind: "Deployment"
			metadata: {name: "buildkitd", namespace: "pronto-buildkit"}
			spec: {
				replicas: 1
				strategy: {type: "Recreate"}
				selector: {matchLabels: {app: "buildkitd"}}
				template: {
					metadata: {labels: {app: "buildkitd"}}
					spec: {
						hostNetwork: true
						# The cache directory is created root's; the daemon runs as user 1000.
						initContainers: [{
							name: "own", image: $node_buildkit
							command: ["sh" "-c" $"chown 1000:1000 ($state.mountPath)"]
							securityContext: {runAsUser: 0}
							volumeMounts: [$state]
						}]
						containers: [{
							name: "buildkitd"
							image: $node_buildkit
							# rootlesskit keeps the node's network, so the daemon's loopback is the node's.
							command: ["rootlesskit" "--net=host" "--copy-up=/etc" "--copy-up=/run" "buildkitd"]
							args: ["--addr" $"tcp://127.0.0.1:($node_buildkit_port)" "--oci-worker-no-process-sandbox" "--config" "/etc/buildkit/buildkitd.toml"]
							securityContext: {runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: "Unconfined"}, appArmorProfile: {type: "Unconfined"}}
							readinessProbe: {exec: {command: ["buildctl" "--addr" $"tcp://127.0.0.1:($node_buildkit_port)" "debug" "workers"]}, initialDelaySeconds: 3, periodSeconds: 10}
							resources: {requests: {cpu: "500m", memory: "1Gi"}, limits: {memory: "8Gi"}}
							volumeMounts: [{name: "config", mountPath: "/etc/buildkit"} $state]
						}]
						volumes: [
							{name: "config", configMap: {name: "buildkitd"}}
							{name: "state", hostPath: {path: "/var/lib/pronto-buildkit", type: "DirectoryOrCreate"}}
						]
					}
				}
			}
		}
		# What a release that builds through it is granted (bound by whoever runs one).
		{
			apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole"
			metadata: {name: "pronto-buildkit-client"}
			rules: [
				{apiGroups: [""], resources: ["pods"], verbs: ["get" "list"]}
				{apiGroups: ["apps"], resources: ["deployments"], verbs: ["get"]}
				{apiGroups: [""], resources: ["pods/portforward"], verbs: ["create"]}
			]
		}
	] | each { to yaml } | str join "---\n"
}

# The node's builder, made where this release may make it, else as it is: a
# release with the publisher's rights alone finds it there or fails saying so.
export def ensure-node-buildkit [--timeout: string = "180s"] {
	let can = (do { ^kubectl auth can-i create deployments -n pronto-buildkit } | complete | get stdout | str trim)
	if $can == "yes" {
		node-buildkit-manifests | kubectl apply -f -
	} else if (do { ^kubectl get deployment/buildkitd -n pronto-buildkit -o name } | complete | get exit_code) != 0 {
		error make {msg: "the node has no builder (deployment/buildkitd in pronto-buildkit) and this release may not make it: release once with the operator's kubeconfig and build.by \"buildkit\""}
	}
	kubectl rollout status deployment/buildkitd -n pronto-buildkit $"--timeout=($timeout)"
}

# A port-forward through the cluster's API to `port` on a deployment's pod (a
# host-network pod's port is the node's loopback): its local port and its pid,
# which stop-port-forward ends.
export def port-forward [namespace: string, deployment: string, port: int] {
	let log = (mktemp -t pf.XXXXXX | str trim)
	# A deployment by name, or any target kubectl names (pod/<name>: a release that may read pods alone).
	let target = if ($deployment | str contains "/") { $deployment } else { $"deployment/($deployment)" }
	let pid = (^bash -c $"kubectl port-forward -n ($namespace) ($target) :($port) > ($log) 2>&1 & echo $!" | str trim | into int)
	for _ in 1..60 {
		let found = (open --raw $log | parse --regex 'Forwarding from 127\.0\.0\.1:(?<p>\d+)')
		if ($found | is-not-empty) { return {port: ($found.0.p | into int), pid: $pid} }
		sleep 500ms
	}
	stop-port-forward {port: 0, pid: $pid}
	error make {msg: $"no port-forward to deployment/($deployment) in ($namespace): (open --raw $log)"}
}

export def stop-port-forward [pf: record] {
	do { ^kill $pf.pid } | complete | ignore
}

# The images built by the node's buildkitd and pushed by it to the node's
# registry, by service, as cloud-build-images gives them: the database's tagged
# with its Postgres major, read from the image's config in the registry.
export def buildkit-images [app_dir: string, compose: string, services: list<string>, app: string, tag: string, --platform: string]: nothing -> record {
	let compose = ($compose | release-tree)
	let root = (do { cd $app_dir; ^git rev-parse --show-toplevel } | str trim)
	let builder = $"pronto-buildkit-(random chars --length 6 | str lowercase)"
	let bk = (port-forward pronto-buildkit buildkitd $node_buildkit_port)
	let reg = (port-forward pronto-registry registry $node_registry_port)
	let meta = (mktemp -t bake-meta.XXXXXX.json | str trim)
	# A first push names the database by a tag of its own; its Postgres major is read after.
	let first = {|svc| if $svc == "database" { $"build-($builder)" } else { $tag } }
	let ref = {|svc| $"127.0.0.1:($node_registry_port)/($app)-($svc):(do $first $svc)" }
	let sets = ($services | each {|s| [--set $"($s).tags=(do $ref $s)"] } | flatten)
	let platform_set = if ($platform | is-not-empty) { [--set $"*.platform=($platform)"] } else { [] }
	try {
		^docker buildx create --name $builder --driver remote $"tcp://127.0.0.1:($bk.port)" | ignore
		do {
			cd $app_dir
			with-env {SOURCE_DATE_EPOCH: "0"} {
				$compose | ^docker buildx bake -f - --builder $builder --push --provenance=false --metadata-file $meta $"--allow=fs.read=($root)" ...$platform_set ...$sets ...$services
			}
		}
		let digests = (open $meta)
		let out = ($services | each {|svc|
			let digest = ($digests | get $svc | get "containerimage.digest")
			let final = if $svc == "database" {
				let major = (node-registry-pg-major $"127.0.0.1:($reg.port)" $"($app)-($svc)" $digest)
				node-registry-tag $"127.0.0.1:($reg.port)" $"($app)-($svc)" $digest $major
				http delete $"http://127.0.0.1:($reg.port)/v2/($app)-($svc)/manifests/(do $first $svc)" | ignore
				$major
			} else { $tag }
			{svc: $svc, ref: {tag: $final, digest: $digest}}
		} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref })
		do { ^docker buildx rm $builder } | complete | ignore
		stop-port-forward $bk; stop-port-forward $reg; rm -f $meta
		$out
	} catch {|e|
		do { ^docker buildx rm $builder } | complete | ignore
		stop-port-forward $bk; stop-port-forward $reg; rm -f $meta
		error make {msg: $e.msg}
	}
}

# `digest` in `repo` tagged `tag` too: its manifest put again under the tag.
export def node-registry-tag [registry: string, repo: string, digest: string, tag: string] {
	let got = (http get --raw --full --headers {Accept: $registry_accept} $"http://($registry)/v2/($repo)/manifests/($digest)")
	let type = ($got.headers.response | where name == "content-type" | get value.0)
	http put --content-type $type $"http://($registry)/v2/($repo)/manifests/($tag)" $got.body | ignore
}

# The Postgres major an image in the node's registry states (PG_MAJOR), as registry-pg-major reads Artifact Registry's.
export def node-registry-pg-major [registry: string, repo: string, digest: string]: nothing -> string {
	let get = {|what| http get --raw --headers {Accept: $registry_accept} $"http://($registry)/v2/($repo)/($what)" | if ($in | describe) == "binary" { decode utf-8 } else { $in } | from json }
	let top = (do $get $"manifests/($digest)")
	let manifest = if ($top.manifests? | is-not-empty) { do $get $"manifests/($top.manifests | first | get digest)" } else { $top }
	do $get $"blobs/($manifest.config.digest)" | get config.Env | where {|e| $e starts-with "PG_MAJOR=" } | first | split row "=" | last
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

# The sops that decrypts a released environment's secrets, pinned by checksum and fetched once
# per machine (fetch-verified), so the node and the Mac decrypt with the same build and need no
# install. sops reads age keys itself; no age binary is needed.
const sops_version = "v3.13.3"
const sops_checksums = {
	"darwin.amd64": "42162d5cef10b74fcf80a045a70e658d7ce6e63d6ea1be6f347e44015714468d"
	"darwin.arm64": "b97c0d434aab577dc40310e8d22ff9e45eef4c80638ab978daae9b4681c59286"
	"linux.amd64": "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b"
	"linux.arm64": "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77"
}

export def sops-platform []: nothing -> string {
	let os = match $nu.os-info.name { "macos" => "darwin", "linux" => "linux", $o => (error make {msg: $"no pinned sops for ($o)"}) }
	let arch = match $nu.os-info.arch { "x86_64" => "amd64", "aarch64" => "arm64", $a => (error make {msg: $"no pinned sops for ($a)"}) }
	$"($os).($arch)"
}

export def sops-bin []: nothing -> string {
	let platform = (sops-platform)
	let name = $"sops-($sops_version).($platform)"
	let bin = (fetch-verified {
		name: $name, ext: "bin", checksum: $"sha256:($sops_checksums | get $platform)"
		url: $"https://github.com/getsops/sops/releases/download/($sops_version)/($name)"
	})
	^chmod +x $bin
	$bin
}

# The age key that decrypts a released environment's secrets (.sops.yaml at the repository's root
# names every recipient): SOPS_AGE_KEY when set; on a Mac, its Keychain item `pronto-sops-age`;
# else the cluster's own key, the Secret pronto-sops/age-key, made on the node and never copied off it.
export def sops-age-key []: nothing -> string {
	if ($env.SOPS_AGE_KEY? | is-not-empty) { return $env.SOPS_AGE_KEY }
	if $nu.os-info.name == "macos" {
		let r = (do { ^security find-generic-password -s pronto-sops-age -w } | complete)
		if $r.exit_code == 0 { return ($r.stdout | str trim) }
	}
	let r = (do { ^kubectl get secret age-key -n pronto-sops -o 'jsonpath={.data.keys\.txt}' } | complete)
	if $r.exit_code != 0 or ($r.stdout | str trim | is-empty) {
		error make {msg: $"no age key to decrypt secrets: set SOPS_AGE_KEY, or make the Secret pronto-sops/age-key on the cluster \(($r.stderr | str trim)\)"}
	}
	$r.stdout | decode base64 | decode | str trim
}

# A released environment's secrets: the Secrets in the app's secrets.<environment>.enc.yaml
# (SOPS with age, values encrypted, names readable), decrypted in memory and applied to the app's
# namespace. Server-side, owned by pronto-sops, so one made by hand before is taken over, not refused.
export def apply-environment-secrets [app_dir: string, environment: string, namespace: string] {
	let enc_file = ($app_dir | path join $"secrets.($environment).enc.yaml")
	if not ($enc_file | path exists) { return }
	print $"Decrypting ($enc_file) into ($namespace)..."
	let sops = (sops-bin)
	with-env {SOPS_AGE_KEY: (sops-age-key)} { ^$sops -d $enc_file }
		| ^kubectl apply --server-side --force-conflicts --field-manager=pronto-sops -n $namespace -f -
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
# The rollout guard (PRONTO-367): no Deployment over one pod serves with fewer than all but one
# of its pods ready at any point of a release's rollout, and every one rolls out in time.

# One sample of Deployments as `kubectl get -o json` gives them: each one's name, the replicas it
# wants, those ready, and whether its rollout is done (all updated and ready, no old pod left).
export def rollout-sample [deployments: list]: nothing -> list {
	$deployments | each {|d|
		let want = ($d.spec.replicas? | default 1)
		let st = ($d.status? | default {})
		{
			name: $d.metadata.name
			replicas: $want
			ready: ($st.readyReplicas? | default 0)
			done: (($st.observedGeneration? | default 0) >= ($d.metadata.generation? | default 0)
				and ($st.updatedReplicas? | default 0) == $want
				and ($st.readyReplicas? | default 0) == $want
				and ($st.replicas? | default 0) == $want)
		}
	}
}

# The floor each Deployment holds through its rollout, from a sample taken before it: all but one of
# its pods for one over a single pod; no more than were ready then for one that starts lower (a new
# one, one growing, one already short), which the rollout is not to blame for.
export def rollout-floors [before: list]: nothing -> record {
	$before | reduce -f {} {|s, acc| $acc | upsert $s.name (if $s.replicas > 1 { [($s.replicas - 1) $s.ready] | math min } else { 0 }) }
}

# A sample's Deployments under their floors, each named.
export def rollout-breaches [floors: record, sample: list]: nothing -> list<string> {
	$sample | where {|s| $s.ready < ($floors | get -o $s.name | default 0) } | each {|s|
		$"($s.name): ($s.ready) of ($s.replicas) ready, under all but one \(($floors | get $s.name)\)"
	}
}

# The guard's verdict over a rollout's samples: the first breach, else those the last sample has not
# rolled out (their new pods never got ready, while the old kept serving), else it held.
export def rollout-verdict [floors: record, samples: list]: nothing -> record {
	for s in $samples {
		let b = (rollout-breaches $floors $s)
		if ($b | is-not-empty) { return {held: false, why: $"a service dropped below n-1 during the rollout: ($b | str join '; ')"} }
	}
	let pending = ($samples | last | where not done | get name)
	if ($pending | is-not-empty) { return {held: false, why: $"not rolled out in time, the old pods still serving: ($pending | str join ', ')"} }
	{held: true, why: ""}
}

# The objects of `kubectl get -o json`: a List's items, or the one object kubectl prints bare when
# a single name is asked for (PRONTO-421: the renderer's rollout, one Deployment, failed on `items`).
export def kube-items []: record -> list {
	let o = $in
	if ($o.kind? | default "") == "List" or ($o.items? != null) { $o.items? | default [] } else { [$o] }
}

# The named Deployments as the cluster has them now (those that exist).
def deployments-now [names: list, ns: string]: nothing -> list {
	let r = (do { kubectl get deployment ...$names -n $ns --ignore-not-found -o json } | complete)
	if $r.exit_code != 0 or ($r.stdout | str trim | is-empty) { return [] }
	$r.stdout | from json | kube-items
}

# Waits for the Deployments' rollouts, sampling every two seconds, and fails the release at the first
# sample that breaks a floor, or at `wait` with those still rolling, naming them.
def watch-rollout [names: list, ns: string, floors: record, wait: duration] {
	let deadline = (date now) + $wait
	mut samples = []
	loop {
		let sample = (rollout-sample (deployments-now $names $ns))
		$samples = [$sample]
		let b = (rollout-breaches $floors $sample)
		if ($b | is-not-empty) { error make {msg: $"a service dropped below n-1 during the rollout: ($b | str join '; ')"} }
		if ($sample | length) == ($names | length) and ($sample | all {|s| $s.done }) { break }
		if (date now) > $deadline { break }
		sleep 2sec
	}
	let missing = ($names | where {|n| $n not-in ($samples | last | get name) })
	if ($missing | is-not-empty) { error make {msg: $"not there after the apply: ($missing | str join ', ')"} }
	let verdict = (rollout-verdict $floors $samples)
	if not $verdict.held { error make {msg: $verdict.why} }
	let guarded = ($floors | transpose name floor | where floor > 0 | each {|g| $"($g.name) ≥ ($g.floor)" })
	print $"Rolled out ($names | length) deployments; the rollout guard held: (if ($guarded | is-empty) { 'none runs over one pod' } else { $guarded | str join ', ' })"
}

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

# The airlock's secrets (airlock.secrets) are the operator's, in the app's namespace: without one the
# airlock never starts, and the effects enqueued meanwhile wait unseen.
export def check-airlock-secrets [objects: list, namespace: string] {
	let refs = ($objects | where kind == "Deployment" and spec.template.metadata.labels."app.kubernetes.io/component"? == "airlock"
		| each {|d| $d.spec.template.spec.containers.0.env } | flatten
		| where {|e| $e.name != "PGPASSWORD" and $e.valueFrom?.secretKeyRef? != null }
		| each {|e| $e.valueFrom.secretKeyRef })
	for ref in $refs {
		# Its keys alone: no value is read.
		let got = (do { ^kubectl get secret $ref.name -n $namespace -o 'go-template={{range $k, $_ := .data}}{{$k}}{{"\n"}}{{end}}' } | complete)
		if $got.exit_code != 0 and not ($got.stderr =~ '\(NotFound\)') {
			error make { msg: $"airlock.secrets: reading Secret ($ref.name) in ($namespace): ($got.stderr | str trim)" }
		}
		if $ref.key not-in ($got.stdout | lines) {
			error make { msg: $"airlock.secrets: Secret ($ref.name) in ($namespace) needs ($ref.key), which an effect reads \(kubectl create secret generic ($ref.name) -n ($namespace) --from-file=($ref.key)=/dev/stdin\)" }
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

# A preview whose database starts as production's is (`--schema-from`): the steps that copy a
# released namespace's schema, without its rows, into a preview's empty database, each a dump
# run on the source's primary whose output the target's primary reads. Its roles (no passwords:
# a preview never holds production's), every object with its owner, pgroll's own rows (the
# migrations production has run, so migrate runs only the ones it has not) and the comment
# marking initdb done, so the preview's initdb replays its idempotent steps and its migrate
# upgrades the copy as the release will upgrade production (#619, #624's failures show here).
export def schema-copy-steps [
	source: record # {namespace, pod, database}: the released primary, read only
	target: record # {namespace, pod, database}: the preview's primary
	--pgroll       # the app migrates with pgroll: copy its schema's rows
]: nothing -> list<record> {
	let on = {|side, cmd| ["kubectl" "exec" "-i" "-n" $side.namespace $side.pod "-c" "postgres" "--"] | append $cmd }
	let psql = {|db, strict| ["psql" "-U" "postgres" "-d" $db "-Xq"] | append (if $strict { ["-v" "ON_ERROR_STOP=1"] } else { [] }) }
	[
		# The target's own roles (postgres, the operator's, its managed ones) already exist: their errors are expected.
		{what: "roles", strict: false
			from: (do $on $source ["pg_dumpall" "-U" "postgres" "--roles-only" "--no-role-passwords"])
			into: (do $on $target (do $psql "postgres" false))}
		{what: "schema", strict: true
			from: (do $on $source ["pg_dump" "-U" "postgres" "-d" $source.database "--schema-only" "--clean" "--if-exists"])
			into: (do $on $target (do $psql $target.database true))}
	] | append (if $pgroll { [
		{what: "pgroll", strict: true
			from: (do $on $source ["pg_dump" "-U" "postgres" "-d" $source.database "--data-only" "--schema=pgroll"])
			into: (do $on $target (do $psql $target.database true))}
	] } else { [] }) | append [
		{what: "initdb marker", strict: true
			from: (do $on $source ["psql" "-U" "postgres" "-d" $source.database "-XtAc" ("SELECT format('COMMENT ON DATABASE %I IS %L;', '" + $target.database + "', d) FROM shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS d WHERE d IS NOT NULL")])
			into: (do $on $target (do $psql $target.database true))}
	]
}

# A namespace's database primary: the pod, and the database its Cluster made.
export def db-primary [namespace: string, cluster?: string]: nothing -> record {
	let clusters = (kubectl get clusters.postgresql.cnpg.io -n $namespace -o json | from json | get items
		| where {|c| ($cluster | is-empty) or $c.metadata.name == $cluster })
	if ($clusters | length) != 1 { error make { msg: $"($namespace) has ($clusters | length) database clusters: name one" } }
	let c = ($clusters | first)
	{namespace: $namespace, pod: $c.status.currentPrimary, database: $c.spec.bootstrap.initdb.database}
}

# Electric's permanent slot from before its temporary ones (PRONTO-363): nobody streams from it
# once the new Electric is up, and it would hold WAL for ever. Dropped when no connection holds it;
# while one does (an old Electric's last seconds), waited for up to `wait`. A database without it
# (a rerun, a new app) is left as it is. Says what it did: "none" or "dropped".
export def drop-retired-electric-slot [db: record, --wait: duration = 180sec] {
	let sql = {|q| ["exec" "-n" $db.namespace $db.pod "-c" "postgres" "--" "psql" "-U" "postgres" "-d" $db.database "-XtAc" $q] }
	let slot = "electric_slot_default"
	let deadline = (date now) + $wait
	loop {
		let held = (do { ^kubectl ...(do $sql $"SELECT active FROM pg_replication_slots WHERE slot_name = '($slot)'") } | complete)
		if $held.exit_code != 0 { error make { msg: $"reading ($slot) on ($db.pod): ($held.stderr)" } }
		match ($held.stdout | str trim) {
			"" => { return "none" }
			"f" => {
				# Guarded again: a slot taken between the read and the drop is left, and read next time.
				let dropped = (do { ^kubectl ...(do $sql $"WITH d AS \(SELECT pg_drop_replication_slot\(slot_name\) FROM pg_replication_slots WHERE slot_name = '($slot)' AND NOT active\) SELECT count\(*\) FROM d") } | complete)
				if $dropped.exit_code == 0 and ($dropped.stdout | str trim) == "1" { return "dropped" }
			}
		}
		if (date now) > $deadline { error make { msg: $"($slot) on ($db.pod) is still held after ($wait): an Electric of the old release still streams from it" } }
		sleep 3sec
	}
}

# Copies the released namespace's schema into a preview's database (schema-copy-steps), once:
# a database initdb already marked is the preview's own by now, and is left as it is.
export def copy-schema [source_ns: string, target: record, --pgroll] {
	let marker = (kubectl exec -n $target.namespace $target.pod -c postgres -- psql -U postgres -d $target.database -XtAc "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()" | str trim)
	if $marker == "pronto initdb" {
		print $"($target.namespace)'s database is built already: its schema is not copied again"
		return
	}
	let source = (db-primary $source_ns)
	for step in (schema-copy-steps $source $target --pgroll=$pgroll) {
		print $"Copying ($step.what) from ($source.namespace) into ($target.namespace)..."
		let dump = (run-external ($step.from | first) ...($step.from | skip 1) | complete)
		if $dump.exit_code != 0 { error make { msg: $"($step.what): the dump in ($source.namespace) failed: ($dump.stderr)" } }
		let load = ($dump.stdout | run-external ($step.into | first) ...($step.into | skip 1) | complete)
		if $step.strict and $load.exit_code != 0 { error make { msg: $"($step.what): loading into ($target.namespace) failed: ($load.stderr)" } }
	}
}

# A service's environment as entries, from the map compose writes or the list (`K`, `K=v`).
def env-entries [svc: record]: nothing -> list<record> {
	let e = ($svc.environment? | default {})
	if ($e | describe) starts-with "list" {
		$e | each {|x| let p = ($x | into string | split row -n 2 "="); {key: $p.0, value: ($p | get -o 1)} }
	} else { $e | transpose key value }
}

# Whether `text` reads the variable `k` (`$k`, `${k}`, `${k:-…}`); `$$` is compose's escape, no read.
def reads-variable [text: string, k: string]: nothing -> bool {
	($text | str replace -a '$$' '') =~ ('\$\{?' + $k + '([^A-Za-z0-9_]|$)')
}

# The variables compose requires of the airlock, each an effect's secret: `${K:?…}`, or
# `${K:-simulator}` where a simulator stands in for the sink locally. Read from the project before
# interpolation (`config --no-interpolate`), since a release takes each from a Secret, never from
# the operator's environment. Any other variable the airlock reads from the environment fails it,
# but those the release sets itself (DATABASE_URL, ORIGIN).
export def airlock-secrets [raw: record]: nothing -> list<string> {
	let entries = (env-entries ($raw.services.airlock? | default {}))
	let secret = {|e| $e.value != null and (($e.value | into string) starts-with ("${" + $e.key + ":?") or ($e.value | into string) == ("${" + $e.key + ":-simulator}")) }
	let unknown = ($entries | where {|e| not (do $secret $e) and $e.key not-in ["DATABASE_URL" "ORIGIN"] and ($e.value == null or (($e.value | into string | str replace -a '$$' '') =~ '\$\{?[A-Za-z_]')) } | get key)
	if ($unknown | is-not-empty) {
		error make { msg: $"the airlock reads ($unknown | str join ', ') from the environment, which release@k8s neither takes from a Secret nor sets: an effect's secret is `${K:?…}` \(or `${K:-simulator}`\)" }
	}
	$entries | where {|e| do $secret $e } | get key
}

# The airlock's secrets another service of the project also reads, each with its readers: by a
# reference, by passing it through by name (`environment: [K]`, `K:`), or through an env_file,
# which may hold any of them. That service takes the variable's value from the environment, so the
# name gets no stand-in.
export def airlock-shared-secrets [raw: record]: nothing -> record {
	let others = ($raw.services | transpose name svc | where name != "airlock")
	airlock-secrets $raw | reduce -f {} {|k, acc|
		let readers = ($others | where {|o|
			($o.svc.env_file? | default [] | is-not-empty) or ($k in (env-entries $o.svc | get key)) or (reads-variable ($o.svc | to json --raw) $k)
		} | get name)
		if ($readers | is-empty) { $acc } else { $acc | insert $k $readers }
	}
}

# Each effect secret a service's build reads (build.args and the rest), which no build may: the
# images would carry it. An arg passed through by name (`args: [K]`, `K:`) reads it too, and is
# seen only before normalization (compose-raw).
export def airlock-build-refusals [raw: record]: nothing -> list<string> {
	let secrets = (airlock-secrets $raw)
	$raw.services | transpose name svc | where {|o| $o.svc.build? != null } | each {|o|
		let passed = (env-entries {environment: ($o.svc.build.args? | default {})} | where value == null | get key)
		let read = ($secrets | where {|k| $k in $passed or (reads-variable ($o.svc.build | to json --raw) $k) })
		if ($read | is-not-empty) { $"($o.name)'s build reads ($read | str join ', '), an effect's secret: an image would carry it" }
	} | compact
}

# The app's compose project as written, before interpolation and normalization (which drops a build
# arg passed through by name).
export def compose-raw [app_dir: string]: nothing -> record {
	do { cd $app_dir; ^docker compose --profile "*" config --no-interpolate --no-normalize --format json } | from json
}

# Each airlock secret no other service reads, as a stand-in for every compose read of the project:
# compose then neither refuses one unset nor reads the operator's, which the release never needs
# (its pods read them from Secrets).
export def airlock-stand-ins [app_dir: string]: nothing -> record {
	if not ($app_dir | path join compose.yaml | path exists) { return {} }
	let raw = (compose-raw $app_dir)
	let shared = (airlock-shared-secrets $raw | columns)
	airlock-secrets $raw | where {|k| $k not-in $shared } | reduce -f {} {|k, acc| $acc | insert $k "secretKeyRef" }
}

# The app's compose project: as text, as JSON (--json) or its services' names (--services), each
# airlock secret no other service reads a stand-in (airlock-stand-ins). A secret another service
# reads is that service's from the environment: unset, compose refuses it, and so does this, naming
# the service.
export def compose-config [app_dir: string, --json, --services]: nothing -> any {
	let args = if $services { ["--services"] } else if $json { ["--format" "json"] } else { [] }
	let r = (with-env (airlock-stand-ins $app_dir) { cd $app_dir; ^docker compose --profile "*" config ...$args } | complete)
	if $r.exit_code != 0 {
		let shared = (airlock-shared-secrets (compose-raw $app_dir) | transpose key readers | where {|e| $r.stderr =~ $"variable ($e.key) " })
		let why = ($shared | each {|e| $"($e.key) is an effect's secret and also ($e.readers | str join ', ')'s, which reads it from the environment: export it" } | str join "; ")
		error make { msg: (if ($why | is-empty) { $r.stderr | str trim } else { $"($why) \(($r.stderr | str trim)\)" }) }
	}
	if $services { $r.stdout | lines } else if $json { $r.stdout | from json } else { $r.stdout }
}

export def runtime-services [compose: record, --secrets: list<string> = []]: nothing -> record {
	let supported = ["compute" "feldera" "redis" "conduit" "mesh-events" "transform" "ticker" "clock" "rclone-s3" "imgproxy" "airlock" "airlock-mesh"]
	let services = ($compose.services | columns)
	# What the airlock reaches past its daprd runs beside it in compose, and in no pod here.
	if "tsbifrost" in $services {
		error make {msg: "native release does not deploy the AI gateway (tsbifrost): an effect with `ai` or capabilities.ai has no release@k8s"}
	}
	let mesh = ($compose.services."airlock-mesh"?.environment? | default {})
	let bridges = ($mesh.AIRLOCK_BRIDGES? | default "" | split row " " | where {|b| $b != "" } | append ($mesh | columns | where {|k| $k =~ '^BRIDGE_.*_URL$' }) | uniq)
	if ($bridges | is-not-empty) {
		error make {msg: $"native release does not deploy container bridges: this app's effects reach ($bridges | str join ', ')"}
	}
	if ("airlock" in $services) != ("airlock-mesh" in $services) {
		error make {msg: "native release deploys the airlock and its daprd (airlock-mesh) together: the compose project has one alone"}
	}
	let names = ($services | where {|s| $s in $supported })
	$names | reduce -f {} {|name, acc|
		let vars = ($compose.services | get $name | get -o environment | default {})
		if $name == "compute" and ($vars.DUCKSTREAM_ENGINE? | default "") != "feldera" {
			error make {msg: "native release requires DUCKSTREAM_ENGINE=feldera for compute"}
		}
		let own_secrets = if $name == "airlock" { $secrets } else { [] }
		$acc | insert $name {
			env: ($vars | reject -o DATABASE_URL FELDERA_DATABASE_URL SERVICE_JWT PGRST_JWT_SECRET CONDUIT_DB_TYPE CONDUIT_DB_POSTGRES_CONNECTION_STRING ...$own_secrets)
			databaseEnvironment: ([DATABASE_URL FELDERA_DATABASE_URL] | where {|key| $key in $vars })
			serviceToken: ("SERVICE_JWT" in $vars)
			jwtSecret: ("PGRST_JWT_SECRET" in $vars)
			secrets: $own_secrets
		}
	}
}

# What a release builds, rolls and signs a service token for, each once: the cluster's services, the
# app's own (App.services), the blob plane's and the runtime's (release-runtime). `components` are
# the ones Dapr's injector gives a sidecar, which the release checks for and rolls within its usual
# wait; `runtime`, the rest of the runtime's, rolls within native startup's.
# The airlock and airlock-mesh are never components: airlock-mesh is a daprd of its own.
export def release-plan [runtime: record, services: list<string>, blob_svcs: list<string>, --migrate, --render]: nothing -> record {
	let injected = ($runtime | columns | where {|s| $s in ["ticker" "rclone-s3" "imgproxy"] })
	let components = (["crud" "electric" "auth" "caddy"] | append (if $render { ["render"] } else { [] }) | append $services | append $blob_svcs | append $injected | uniq)
	{
		build: (["database" "crud" "electric" "auth" "caddy"] | append (if $migrate { ["migrate"] } else { [] }) | append (if $render { ["render"] } else { [] }) | append $services | append $blob_svcs | append ($runtime | columns) | uniq)
		components: $components
		runtime: ($runtime | columns | where {|s| $s not-in $components })
		serviceToken: (($services | is-not-empty) or ($runtime | values | any {|r| $r.serviceToken }))
	}
}

# What the compose project runs beside the cluster (runtime.cue), on every cluster but metal,
# whose release names its services itself (App.services, App.blobs) and runs no other.
export def release-runtime [app_dir: string, env_name: string]: nothing -> record {
	if $env_name == "metal" or not ($app_dir | path join compose.yaml | path exists) { return {} }
	runtime-services (compose-config $app_dir --json) --secrets (airlock-secrets (compose-raw $app_dir))
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
	let runtime = (release-runtime ($cue_path | path dirname) $env_name)
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
	let override = (compose-config $app_dir | release-override)
	let plan = {project: $target_env.build.project, registry: $target_env.registry, preview: $tag}
	# Cloud Build's compose reads every airlock secret as a stand-in, a shared one too: no build reads
	# one (airlock-build-refusals), and the operator's values stay on this machine.
	let build_env = (airlock-secrets (compose-raw $app_dir) | each {|k| $"($k)=secretKeyRef" })
	let built = (push-images $app_dir $plan $name $services --platform ($target_env.platform? | default "linux/amd64") --override $override --build-env $build_env)
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
		# The app's gate over its API keys (capabilities.auth.apiKeysGate): keys on, its flag deciding.
		apiKeysGate: ($environment.AUTH_API_KEYS_GATE? | default "")
		# The app's hook on a key's exchange (capabilities.auth.keyExchanged): auth calls it with the owner.
		keyExchanged: ($environment.AUTH_KEY_EXCHANGED_HOOK? | default "")
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

# A tenant's release (--tenant), cut to its own namespace: the namespace is its maker's, and so is its
# isolation (no NetworkPolicy of the app's, whose allows would widen what the maker denies); anything
# outside `namespace`, or cluster-wide, is refused before anything is applied.
export def tenant-manifests [namespace: string]: string -> string {
	# The documents are kept as the render wrote them, not read and written again: nushell's `to yaml` writes the
	# string "on" (caddy's PRONTO_TRACING) bare, and kubectl reads YAML 1.1, where that is a boolean, so the server
	# refused the Deployment ("cannot unmarshal bool into Go struct field EnvVar.value of type string").
	let kept = ($in | split row --regex '(?m)^---\s*$' | where ($it | str trim | is-not-empty)
		| each {|text| {text: $text, doc: ($text | from yaml)} }
		| where {|d| $d.doc.kind not-in ["Namespace" "NetworkPolicy"] })
	let outside = ($kept | get doc | where {|d| ($d.metadata.namespace? | default "") != $namespace })
	if ($outside | is-not-empty) {
		error make {msg: $"a tenant's release writes only inside ($namespace), and this one holds (($outside | each {|d| $'($d.kind)/($d.metadata.name) in ($d.metadata.namespace? | default "the cluster")' } | str join ', '))"}
	}
	$kept | get text | each {|t| ($t | str trim --left --char "\n" | str trim --right) + "\n" } | str join "---\n"
}

# What `docker buildx bake` is allowed on a tenant's build: the repository read, and the write of the folder it
# bakes the images into as OCI archives (`output=type=oci,dest=<out>/<svc>.tar`). buildx (0.19 and later) refuses a
# write it was not granted ("additional privileges requested"), so the first image build of a tenant's release failed.
export def tenant-bake-allows [root: string, out: string]: nothing -> list<string> {
	[$"--allow=fs.read=($root)" $"--allow=fs.write=($out)"]
}

# What a tenant's release refuses before it builds: a namespace and a host to release into, and
# nothing that needs more than the namespace's publisher (no preview, no SSH to the node, no node registry
# pushed through it, no secrets decrypted with the cluster's key).
export def tenant-refusals [tenant: string, host: string, preview: string, target: record, app_dir: string, environment: string, images: string = ""]: nothing -> list<string> {
	[
		(if ($tenant | is-not-empty) and ($images | is-empty) { "--tenant needs --images or --buildkit: a tenant's release builds nothing with its publisher's rights (tenant-images builds them)" })
		(if ($tenant | is-empty) and ($images | is-not-empty) { "--images and --buildkit are a tenant's: name its namespace with --tenant" })
		(if ($tenant | is-not-empty) and ($host | is-empty) { "--tenant needs --host, the one address its namespace was given" })
		(if ($tenant | is-empty) and ($host | is-not-empty) { "--host is a tenant's address: name its namespace with --tenant" })
		(if ($tenant | is-not-empty) and ($preview | is-not-empty) { "a tenant's release is never a preview" })
		(if ($tenant | is-not-empty) and ($target.build?.by? == "node") { "a tenant's release cannot push to the node's registry, which only SSH reaches: build with buildkit or cloudbuild" })
		(if ($tenant | is-not-empty) and ($app_dir | path join $"secrets.($environment).enc.yaml" | path exists) { $"a tenant's release decrypts no secrets with the cluster's key: secrets.($environment).enc.yaml is the operator's" })
	] | compact
}

# Where the airlock cannot go. A tenant's release drops every NetworkPolicy (tenant-manifests), the
# airlock's two walls with them. A preview would perform real effects with the release's sinks'
# credentials, and its namespace holds none of the release's Secrets (check-airlock-secrets).
export def airlock-refusals [runtime: record, tenant: string, preview: string]: nothing -> list<string> {
	if "airlock" not-in $runtime { return [] }
	[
		(if ($tenant | is-not-empty) { "a tenant's release deploys no airlock: it drops every NetworkPolicy, and the airlock's are its walls" })
		(if ($preview | is-not-empty) { "a preview of an app with effects is refused: its airlock would perform them for real, with the release's sinks' credentials" })
	] | compact
}

# A tenant's repository for one of its services: under its namespace's name, so the builder that pushes
# it (tenant-images) pushes nowhere another release reads from. It is the schema's tenant naming (k8s.cue).
export def tenant-repo [tenant: string, app: string, svc: string]: nothing -> string {
	$"($tenant)-($app)-($svc)"
}

# A tenant's images (PRONTO-130), built where a tenant's untrusted build may run and pushed by whoever
# runs this, never by the build: `buildkit` is a buildkitd that keeps its process sandbox and reaches
# nothing on the node (pronto's services/buildkit-tenants), which hands each image back as an OCI archive;
# they are pushed to the node's registry through a port-forward to its pod, under tenant-repo's names
# alone. Answers what release@k8s --tenant --images reads, by service: the database's tagged with its
# Postgres major. Needs docker's client and buildx (no daemon), crane and kubectl.
export def tenant-images [app_dir: string, compose: string, services: list<string>, app: string, tenant: string, tag: string, buildkit: string, --platform: string]: nothing -> record {
	let compose = ($compose | release-tree)
	let root = (do { cd $app_dir; ^git rev-parse --show-toplevel } | str trim)
	let builder = $"pronto-tenant-(random chars --length 6 | str lowercase)"
	let out = (mktemp -d -t tenant-images.XXXXXX | str trim)
	let sets = ($services | each {|s| [--set $"($s).output=type=oci,dest=($out)/($s).tar" --set $"($s).tags="] } | flatten)
	let platform_set = if ($platform | is-not-empty) { [--set $"*.platform=($platform)"] } else { [] }
	let pod = (^kubectl get pods -n pronto-registry -l app=registry -o jsonpath='{.items[0].metadata.name}' | str trim)
	if ($pod | is-empty) { error make {msg: "the node's registry has no pod to push to"} }
	^docker buildx create --name $builder --driver remote $buildkit | ignore
	let reg = (try { port-forward pronto-registry $"pod/($pod)" $node_registry_port } catch {|e| do { ^docker buildx rm $builder } | complete | ignore; error make {msg: $e.msg} })
	try {
		do {
			cd $app_dir
			with-env {SOURCE_DATE_EPOCH: "0"} {
				$compose | ^docker buildx bake -f - --builder $builder --provenance=false ...(tenant-bake-allows $root $out) ...$platform_set ...$sets ...$services
			}
		}
		let registry = $"127.0.0.1:($reg.port)"
		let pushed = ($services | each {|svc|
			let layout = ($out | path join $svc)
			mkdir $layout
			^tar -xf ($out | path join $"($svc).tar") -C $layout
			let repo = (tenant-repo $tenant $app $svc)
			let first = if $svc == "database" { $"build-($builder)" } else { $tag }
			let ref = (^crane push --insecure $layout $"($registry)/($repo):($first)" | str trim)
			let digest = ($ref | split row "@" | last)
			let final = if $svc == "database" {
				let major = (node-registry-pg-major $registry $repo $digest)
				node-registry-tag $registry $repo $digest $major
				http delete $"http://($registry)/v2/($repo)/manifests/($first)" | ignore
				$major
			} else { $tag }
			{svc: $svc, ref: {tag: $final, digest: $digest}}
		} | reduce -f {} {|it, acc| $acc | insert $it.svc $it.ref })
		do { ^docker buildx rm $builder } | complete | ignore
		stop-port-forward $reg; rm -rf $out
		$pushed
	} catch {|e|
		do { ^docker buildx rm $builder } | complete | ignore
		stop-port-forward $reg; rm -rf $out
		error make {msg: $e.msg}
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
	--schema-from: string = "" # With --preview: a new preview's database starts as this namespace's schema, without its rows (schema-copy-steps)
	--tenant: string = ""    # Release into this namespace, made by someone else, with its publisher's rights alone (the KUBECONFIG given): no namespace, operators, tunnel or observability (PRONTO-130)
	--host: string = ""      # With --tenant: the one address the namespace was given, over the app's gateway.host
	--images: string = ""    # With --tenant: a JSON file of the images tenant-images pushed, by service
	--buildkit: string = ""  # With --tenant, instead of --images: build them now on this sandboxed buildkitd (tenant-images)
	--push-kubeconfig: string = "" # With --buildkit: who pushes them (pronto-registry's port-forward), never the publisher; empty, the pod's own account
] {
	let app_info = (resolve-app $app)
	let cluster_env = ($cluster_env | default $env.SAY_RELEASE_ARGS_CLUSTER_ENV? | default (default-environment $app_info.cue_path))
	if $delete and ($preview | is-empty) {
		error make { msg: "--delete removes a preview: name it with --preview=<name>. A release is never deleted from here." }
	}
	if ($schema_from | is-not-empty) and ($preview | is-empty) {
		error make { msg: "--schema-from copies a schema into a preview's database: name it with --preview=<name>. A release's own database is never overwritten." }
	}
	let is_tenant = ($tenant | is-not-empty)
	if $is_tenant and $delete { error make { msg: "--delete removes a preview; a tenant's namespace is its maker's to remove" } }
	# A preview is the release under another name (App.preview, k8s/schema/release.cue), unified into the
	# package; a tenant's, the release in another's namespace at its given address (App.tenant, App.tenantHost).
	let preview_file = if ($preview | is-not-empty) or $is_tenant {
		let f = (mktemp -t preview.XXXXXX.json | str trim)
		{App: (if $is_tenant { {tenant: $tenant, tenantHost: $host} } else { {preview: $preview} })} | to json | save -f $f
		$f
	} else { "" }
	let rendered = if ($preview_file | is-not-empty) { render-manifests $app_info.cue_path $cluster_env --data $preview_file } else { render-manifests $app_info.cue_path $cluster_env }
	let manifests = if $is_tenant { $rendered | tenant-manifests $tenant } else { $rendered }

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
	let compose_services = (compose-config $app_source_dir --services)
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
	let runtime = (release-runtime $app_source_dir $cluster_env)
	let refused = (tenant-refusals $tenant $host $preview $target_env $app_source_dir $cluster_env ([$images $buildkit] | str join "") | append (airlock-refusals $runtime $tenant (if $delete { "" } else { $preview })) | append (airlock-build-refusals (compose-raw $app_source_dir)))
	if ($images | is-not-empty) and ($buildkit | is-not-empty) { error make { msg: "--images or --buildkit, not both" } }
	if ($refused | is-not-empty) { error make { msg: ($refused | str join "; ") } }
	if $cluster_env == "gke" {
		kubectl get crd clusters.postgresql.cnpg.io externalsecrets.external-secrets.io configurations.dapr.io gateways.gateway.networking.k8s.io backendtrafficpolicies.gateway.envoyproxy.io | ignore
		kubectl get gatewayclass $target_env.gatewayClassName | ignore
		let tls = ($manifests | from yaml | where kind == "Gateway" | first | get spec.listeners | where protocol == "HTTPS" | get -o 0.tls.certificateRefs.0.name)
		if ($tls | is-not-empty) { kubectl get secret $tls -n $target_ns | ignore }
	}

	# Kind's cluster is made here; a metal one is the operator's, named by its context.
	if $cluster_env == "kind" and not $is_tenant { ensure-cluster }
	# A tenant's release runs with the KUBECONFIG it was given (its publisher's, from inside the cluster or
	# beside it): no context of the operator's, and no SSH to the node.
	if not $is_tenant {
		let context = ($target_env.context? | default (open --raw ($k8s_dir | path join "cluster.yaml") | from yaml | where kind == "Cluster" | first | get name))
		# Every kubectl call below targets this cluster, whatever context is current.
		let kubeconfig = (mktemp -t kubeconfig.XXXXXX | str trim)
		kubectl config view --minify --flatten --context $context | save -f $kubeconfig
		$env.KUBECONFIG = $kubeconfig
	}
	let tunnel = if ($target_env.access? | is-not-empty) and not $is_tenant {
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
	if not $skip_operators and not $is_tenant {
		ensure-operators --ingress $target_env.ingress --reopen $reopen --environment $target_env
		if $target_env.ingress.by == "tunnel" { ensure-tunnel $target_env.ingress.id }
	}
	if not $skip_observability and not $is_tenant {
		ensure-observability $target_env.domainSuffix
	}

	if $is_tenant {
		# The namespace is there and its publisher may write in it, or nothing is built.
		if (do { ^kubectl auth can-i create deployments -n $target_ns } | complete | get stdout | str trim) != "yes" {
			error make { msg: $"this KUBECONFIG may not release into ($target_ns): a tenant's release runs as the namespace's publisher" }
		}
	} else {
		# Ensure target namespace exists before creating namespaced prerequisites
		kubectl create namespace $target_ns --dry-run=client -o yaml | kubectl apply -f -
	}

	if not $is_pronto {
		error make { msg: $"Only Pronto applications are supported for k8s release: ($app_info.name)" }
	}

	# migrate runs where the app has ledger migrations or permissions to reconcile, as in compose.
	let has_migrate = ("migrate" in $compose_services)
	# What runs beside the cluster (runtime.cue), built from the app's compose services as the cluster's own are.
	let plan = (release-plan $runtime $services $blob_svcs --migrate=$has_migrate --render=$has_render)
	let build_svcs = $plan.build
	print $"Building native Pronto services \(($build_svcs | str join ', ')\) for ($app_info.name)..."
	# A node's registry is pushed to through this release's tunnel, on a local
	# port, while the manifests name it as the node sees it (registry).
	let push_registry = if $target_env.build.by == "node" and not $is_tenant {
		ensure-node-registry
		$"localhost:(forward-node-registry $tunnel.target $tunnel.socket)"
	} else { $registry }
	let pushed = if $is_tenant {
		let given = if ($buildkit | is-not-empty) {
			# Pushed with the builder's own rights: the publisher's KUBECONFIG is set aside for it.
			let compose = (compose-config $app_source_dir)
			let push_env = if ($push_kubeconfig | is-not-empty) { {KUBECONFIG: $push_kubeconfig} } else { {} }
			# A closure's environment is its own: the publisher's KUBECONFIG is back once it returns.
			do {
				hide-env KUBECONFIG
				with-env $push_env { tenant-images $app_source_dir $compose $build_svcs $app_info.name $tenant $app_meta.image.tag $buildkit --platform ($target_env.platform? | default "") }
			}
		} else { open $images }
		let missing = ($build_svcs | where {|s| $s not-in ($given | columns) })
		if ($missing | is-not-empty) { error make { msg: $"--images has no image for ($missing | str join ', ')" } }
		$given | select ...$build_svcs
	} else if $target_env.build.by == "cloudbuild" {
		cloud-build-images $app_source_dir $app_info.name $build_svcs $target_env $app_meta.image.tag
	} else if $target_env.build.by == "buildkit" {
		ensure-node-buildkit
		buildkit-images $app_source_dir (compose-config $app_source_dir) $build_svcs $app_info.name $app_meta.image.tag --platform ($target_env.platform? | default "")
	} else {
		let bake_targets = (bake-images $app_source_dir (compose-config $app_source_dir) $build_svcs --platform ($target_env.platform? | default ""))
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
		{migrate: {env: (compose-config $app_source_dir --json | get services.migrate.environment | reject DATABASE_URL)}}
	} else { {} }
	# The providers compose gives the auth service, and each one's client:
	# compose refuses to render a provider whose client is unset.
	# What release.cue sets is the release's, over compose's, as gcp/release.nu's auth.oidc is.
	let fixed = (^cue export --expression App.auth.oidc --out json $app_info.cue_path | from json | columns)
	let oidc = (auth-provider-environment (compose-config $app_source_dir --json | get services.auth.environment | reject -o ...$fixed))
	let own_env = (app-services-environment (compose-config $app_source_dir --json) $services $app_meta.own)
	let pushed_file = (mktemp -t pushed.XXXXXX.json | str trim)
	{App: ({image: {pushed: $pushed}, auth: ($oidc | reject secretValues)} | merge $migrate | merge (if ($services | is-empty) { {} } else { {services: $own_env} }) | merge (if ($preview | is-empty) { {} } else { {preview: $preview} }) | merge (if $is_tenant { {tenant: $tenant, tenantHost: $host} } else { {} }))} | to json | save -f $pushed_file
	let released = (render-manifests $app_info.cue_path $cluster_env --data $pushed_file | if $is_tenant { tenant-manifests $tenant } else { $in })
	rm $pushed_file

	# Ingress / Gateway TLS secret for Kind HTTPS parity
	if $cluster_env == "kind" {
		ensure-tls-secret $rname $app_source_dir $target_ns $gateway_host
	}

	# secrets.enc.yaml holds sandbox keys, which a production cluster must never get.
	if $cluster_env == "kind" {
		apply-sops-secrets $rname $app_source_dir $target_ns
	} else {
		apply-environment-secrets $app_source_dir $cluster_env $target_ns
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
	check-airlock-secrets ($released | from yaml) $target_ns
	# A tenant's publisher may write some kinds and not others, and admission holds its hosts: the API
	# server is asked first, so a refusal fails the release before it has changed anything.
	if $is_tenant {
		let dry = ($released | do { ^kubectl apply --dry-run=server -f - } | complete)
		if $dry.exit_code != 0 { error make { msg: $"($target_ns)'s publisher may not release this: ($dry.stderr | str trim)" } }
	}
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

	if ($schema_from | is-not-empty) {
		if $schema_from == $target_ns { error make { msg: $"--schema-from ($schema_from) is the preview's own namespace" } }
		copy-schema $schema_from (db-primary $target_ns $"($rname)-db") --pgroll=$has_migrate
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

	# The app's own services and the runtime's (the ticker) call crud as the service role, with a
	# token signed by the JWT secret the cluster generated (an ExternalSecret, there by now: crud
	# logs in with it).
	if $plan.serviceToken { ensure-service-jwt $workload_name $target_ns }
	seed-configmaps $app_meta.services $app_source_dir $target_ns
	apply-alert-rules $workload_name ($app_meta.alerting?.rules? | default []) $app_source_dir $target_ns

	let components = $plan.components
	let names = ($components | each { $"($rname)-($in)" })
	let runtime_names = ($plan.runtime | each { $"($rname)-($in)" })
	# Each Deployment's floor through its rollout, from what runs before it (PRONTO-367).
	let floors = (rollout-floors (rollout-sample (deployments-now $names $target_ns)))
	let runtime_floors = if ($runtime_names | is-empty) { {} } else { rollout-floors (rollout-sample (deployments-now $runtime_names $target_ns)) }
	# A changed image digest rolls its deployment; an unchanged one has nothing to roll.
	$deployments_yaml | str join "\n---\n" | kubectl apply -f -
	# A preview is a second whole stack starting on a node already running the released one and the rest (its pods
	# wait on each other through a loaded node): it is given longer than a release to come up (PRONTO-153).
	let rollout_wait = if ($preview | is-not-empty) { 900sec } else { 180sec }
	watch-rollout $names $target_ns $floors $rollout_wait
	# Native compute's first start compiles its pipelines, and the airlock admits every handler before it listens.
	if ($runtime_names | is-not-empty) {
		watch-rollout $runtime_names $target_ns $runtime_floors 900sec
	}
	# The renderer reads the app through the door once, as it starts: one that rolled beside the door
	# may have read the old door's catalogues and handlers, and renders every page a 500 until it starts
	# again ("unknown message", "no Jessie module": PRONTO-154). So it starts again once the door has.
	if $has_render {
		let render = [$"($rname)-render"]
		let render_floors = (rollout-floors (rollout-sample (deployments-now $render $target_ns)))
		kubectl rollout restart $"deployment/($rname)-render" -n $target_ns
		watch-rollout $render $target_ns $render_floors $rollout_wait
	}
	# Every Electric now runs on a temporary slot of its own: the permanent one goes, once.
	print $"Electric's permanent slot: (drop-retired-electric-slot (db-primary $target_ns $"($rname)-db"))"
	if $target_env.build.by == "node" { prune-node-registry $push_registry }
	# A release with the publisher's rights alone may not run the registry's collector: the next operator's release does.
	if $target_env.build.by == "buildkit" and ((do { ^kubectl auth can-i create pods/exec -n pronto-registry } | complete | get stdout | str trim) == "yes") {
		let reg = (port-forward pronto-registry registry $node_registry_port)
		try { prune-node-registry $"127.0.0.1:($reg.port)" } catch {|e| stop-port-forward $reg; error make {msg: $e.msg} }
		stop-port-forward $reg
	}

	# The mesh is intrinsic to a k8s release: a pod the injector let through bare is a failed release.
	let bare = (kubectl get pods -n $target_ns -l $"app.kubernetes.io/name=($rname),app.kubernetes.io/component in \(($components | str join ',')\)" --field-selector=status.phase=Running -o json
		| from json | get items
		| where {|p| $p.metadata.deletionTimestamp? == null and not ($p.spec.containers.name | any {|c| $c == "daprd" }) }
		| get metadata.name)
	if ($bare | is-not-empty) {
		error make { msg: $"Pods running without their Dapr sidecar: ($bare | str join ', ')" }
	}

	if $target_env.ingress.by == "tunnel" and ($preview | is-empty) and not $is_tenant {
		print $"The tunnel answers for ($gateway_host) once its DNS is a proxied CNAME onto ($target_env.ingress.id).cfargotunnel.com: cloudflared tunnel route dns ($target_env.ingress.id) ($gateway_host)"
	}
	if $tunnel != null { close-api-tunnel $tunnel.target $tunnel.socket }
	if $is_tenant {
		print $"\n[SUCCESS] Released ($rname) into ($target_ns) as its publisher: https://($gateway_host)/"
	} else if ($preview | is-not-empty) {
		print $"\n[SUCCESS] Released the preview ($preview) of ($app_info.name) to ($cluster_env), namespace ($target_ns): no public name; reach it with kubectl port-forward -n ($target_ns) svc/caddy 18080:8080 and remove it with --preview=($preview) --delete"
	} else {
		print $"\n[SUCCESS] Released ($rname) natively to ($cluster_env): https://($gateway_host)/"
	}
}

