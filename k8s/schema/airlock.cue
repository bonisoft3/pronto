package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/yaml"
	"list"
	"strings"
)

// A bridge's pods, by the label the release gives them: the app's own
// services admit its pods by the app's name, and a bridge runs the app's
// code with the world in reach, so none of them admits a bridge. A network
// plugin that holds a new pod to its policies only once it runs would
// otherwise leave a bridge's first moments the run of the cluster.
#bridgeLabel: "pronto.dev/bridge"
#notBridge:   {key: #bridgeLabel, operator: "DoesNotExist"}

// The airlock as compose runs it (libraries/mecha/services/airlock/README.md):
// the airlock, its daprd (`airlock-mesh`) and the bridge containers the daprd
// calls, each on the image the app's compose project builds. Compose keeps the
// wall with networks; here each is a NetworkPolicy, so the airlock reaches only
// the database and its daprd, the daprd alone reaches the world, and each
// bridge goes out on its own.
//
// The daprd is a pod of its own, never the airlock's sidecar: a sidecar shares
// its pod's network namespace, so the airlock would reach whatever its daprd
// does. It runs standalone, as compose's does, on the resources its image
// holds (the wall, the breaker, the blob plane's binding and one HTTPEndpoint
// per effect), with the endpoints mounted over the image's: those are the
// docker target's, and an effect may name another sink for k8s.
#Airlock: {
	app:         #ReleaseSpec
	environment: #Environment
	// The door's origin, which a handler names to a sink that links back.
	origin: string
	images: [string]: string

	let A = app.airlock
	let appLabels = {"app.kubernetes.io/name": app.name}
	let component = {c: string, out: appLabels & {"app.kubernetes.io/component": c}}
	let meshPort = 3500
	let airlockPort = 9997

	// The world: every address but the private, shared, link-local (a cloud's
	// metadata service) and loopback ranges and the cluster's own, which the
	// release reads from the cluster since a node, its pods or the API server
	// may be public. That holds for pods and nodes alike where the network
	// plugin applies an ipBlock to both, as Kubernetes documents it; one that
	// rewrites a pod's address on its way out may show a peer another.
	let outside = [{
		ipBlock: {
			cidr: "0.0.0.0/0"
			except: list.Concat([
				["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"],
				[for a in A.clusterAddresses if !strings.Contains(a, ":") {a}],
			])
		}
	}, {
		ipBlock: {
			cidr: "::/0"
			except: list.Concat([
				["::1/128", "fc00::/7", "fe80::/10"],
				[for a in A.clusterAddresses if strings.Contains(a, ":") {a}],
			])
		}
	}]

	// The cluster's resolver alone: port 53 to anywhere would be a way out
	// for whatever speaks on it. Its pods, and the addresses the kubelets
	// hand pods as their resolver, which a node-local cache's is.
	let dns = {
		to: list.Concat([[{
			namespaceSelector: matchLabels: "kubernetes.io/metadata.name": "kube-system"
			podSelector: matchLabels: "k8s-app":                           "kube-dns"
		}], [for a in A.resolvers {ipBlock: cidr: a}]])
		ports: [{port: 53, protocol: "UDP"}, {port: 53, protocol: "TCP"}]
	}

	let endpointFiles = {for n, url in A.endpoints {
		("\(n).yaml"): yaml.Marshal({
			apiVersion: "dapr.io/v1alpha1"
			kind:       "HTTPEndpoint"
			metadata: name: n
			spec: baseUrl:  url
		})
	}}

	// The wall is its NetworkPolicies, and a sink k8s cannot reach would be
	// dialed under the docker target's endpoint.
	let refused = [if app.airlock != _|_ for r in [
		for n, url in A.endpoints if url == null {"effect \(n) names no sink the k8s release reaches: give it sink.targets.k8s"},
		if !app.networkPolicy.enabled {"the airlock's wall is its NetworkPolicies: networkPolicy.enabled is false"},
		// A bridge's Service takes its container's name, which CloudNativePG's
		// own Services for the database hold.
		for c, _ in A.bridges for s in ["rw", "ro", "r"] if c == "\(app.name)-db-\(s)" {"a bridge on k8s names container \(c), which the database's Service names: rename the container"},
		// The cluster's own namespaces admit every pod of theirs to what they
		// run, a bridge among them, and hold its Services, `default` the API
		// server's, which a bridge's Service of the same name would take.
		if list.Contains(["default", "kube-system", "kube-public", "kube-node-lease", "cnpg-system", "dapr-system", "observability", "external-secrets", "envoy-gateway-system"], app.namespace) {"the airlock's bridges would share namespace \(app.namespace) with the cluster's own, which admits its pods: release the app into its own"},
		// Its Jobs' names, the longest the ledger's upgrade's, within the 63
		// characters Kubernetes allows one.
		if len("\(app.name)-airlock-upgrade") > 63 {"the app's name \(app.name) leaves its Job \(app.name)-airlock-upgrade past the 63 characters a Job's name takes: shorten it"},
	] {r}]

	objects: list.Concat([[for r in refused {error(r)}], [if app.airlock != _|_ for object in list.Concat([[
		{
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata:   {name: "\(app.name)-airlock-endpoints", namespace: app.namespace, labels: (component & {c: "airlock-mesh"}).out}
			data:       endpointFiles
		},
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata:   {name: "\(app.name)-airlock-mesh", namespace: app.namespace, labels: (component & {c: "airlock-mesh"}).out}
			spec: {
				replicas: 1
				selector: matchLabels: (component & {c: "airlock-mesh"}).out
				template: {
					metadata: {
						labels: (component & {c: "airlock-mesh"}).out
						// subPath mounts never follow their ConfigMap, so a changed
						// endpoint rolls the pod.
						annotations: "pronto.dev/endpoints-digest": hex.Encode(sha256.Sum256(yaml.Marshal(endpointFiles)))
					}
					spec: {
						automountServiceAccountToken: false
						// No dapr.io annotation: the injector adds no sidecar to the
						// daprd, which runs the image's own entrypoint.
						volumes: [{name: "endpoints", configMap: name: "\(app.name)-airlock-endpoints"}]
						containers: [{
							name:            "daprd"
							image:           images["airlock-mesh"]
							imagePullPolicy: environment.imagePullPolicy
							ports:           [{name: "http", containerPort: meshPort}]
							env:             [for k, v in A.meshEnv {name: k, value: v}]
							volumeMounts:    [for f, _ in endpointFiles {name: "endpoints", mountPath: "/dapr/airlock/\(f)", subPath: f, readOnly: true}]
							// An answer's pictures pass through it, up to 64 MiB.
							resources:      app.airlockResources
							readinessProbe: {tcpSocket: port: meshPort, periodSeconds: 5}
						}]
					}
				}
			}
		},
		{
			apiVersion: "v1"
			kind:       "Service"
			metadata:   {name: "airlock-mesh", namespace: app.namespace, labels: (component & {c: "airlock-mesh"}).out}
			spec: {
				selector: (component & {c: "airlock-mesh"}).out
				ports:    [{name: "http", port: meshPort, targetPort: meshPort, protocol: "TCP"}]
			}
		},
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata:   {name: "\(app.name)-airlock", namespace: app.namespace, labels: (component & {c: "airlock"}).out}
			spec: {
				// Processes share the queue safely (the README's "After a
				// crash"), so a rolling replacement may overlap.
				replicas: 1
				selector: matchLabels: (component & {c: "airlock"}).out
				template: {
					metadata: {
						labels: (component & {c: "airlock"}).out
						if A.secretDigest != "" {
							annotations: "pronto.dev/airlock-secret-digest": A.secretDigest
						}
					}
					spec: {
						automountServiceAccountToken: false
						// Graphile hands back the jobs it holds on SIGTERM.
						terminationGracePeriodSeconds: 60
						containers: [{
							name:            "airlock"
							image:           images.airlock
							imagePullPolicy: environment.imagePullPolicy
							ports:           [{name: "tcp", containerPort: airlockPort}]
							env: list.Concat([
								[{name: "PGPASSWORD", valueFrom: secretKeyRef: {name: "\(app.name)-db-postgres", key: "password"}}],
								// The ledger's owner, as compose connects; the image's
								// --allow-net names `database` and `airlock-mesh`.
								[{name: "DATABASE_URL", value: "postgresql://postgres:$(PGPASSWORD)@database:5432/\(app.name)?sslmode=disable"}],
								[{name: "ORIGIN", value: origin}],
								// Bridges named for k8s are called; the rest settle
								// as not deployed.
								[{name: "AIRLOCK_TARGET", value: "k8s"}],
								// A release's airlock: it refuses the development seal key by
								// its id, however it is spelled, and refuses to start where the
								// local stack's AIRLOCK_SEAL_DEV reaches it too (seal.ts sealLocal).
								[{name: "AIRLOCK_RELEASE", value: "k8s"}],
								[for k, v in A.env {name: k, value: v}],
								[for k in A.secrets {name: k, valueFrom: secretKeyRef: {name: "\(app.name)-airlock", key: k}}],
								// Never AIRLOCK_SEAL_DEV: the airlock refuses the development key
								// wherever the local stack does not say it is the local stack.
								[if A.seal {name: "AIRLOCK_SEAL_KEY", valueFrom: secretKeyRef: {name: "\(app.name)-airlock", key: "AIRLOCK_SEAL_KEY"}}],
								[if A.seal {name: "AIRLOCK_SEAL_KEY_PREVIOUS", valueFrom: secretKeyRef: {name: "\(app.name)-airlock", key: "AIRLOCK_SEAL_KEY_PREVIOUS", optional: true}}],
							])
							resources: app.airlockResources
							// The port opens once every handler is admitted and the
							// worker runs.
							startupProbe:   {tcpSocket: port: airlockPort, periodSeconds: 2, failureThreshold: 90}
							readinessProbe: {tcpSocket: port: airlockPort, periodSeconds: 5}
						}]
					}
				}
			}
		},
		// The ticker's wake (WAKE_URLS) reaches the airlock's health port.
		{
			apiVersion: "v1"
			kind:       "Service"
			metadata:   {name: "airlock", namespace: app.namespace, labels: (component & {c: "airlock"}).out}
			spec: {
				selector: (component & {c: "airlock"}).out
				ports:    [{name: "tcp", port: airlockPort, targetPort: airlockPort, protocol: "TCP"}]
			}
		},
		// compose's `airlock` and `airlock-wake` networks: the database, its
		// daprd, and the ticker's wake in.
		{
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata:   {name: "\(app.name)-airlock", namespace: app.namespace, labels: (component & {c: "airlock"}).out}
			spec: {
				podSelector: matchLabels: (component & {c: "airlock"}).out
				policyTypes: ["Ingress", "Egress"]
				ingress: [{
					from:  [{podSelector: matchLabels: (component & {c: "ticker"}).out}]
					ports: [{port: airlockPort, protocol: "TCP"}]
				}]
				egress: [
					dns,
					{to: [{podSelector: matchLabels: {"cnpg.io/cluster": "\(app.name)-db"}}], ports: [{port: 5432, protocol: "TCP"}]},
					{to: [{podSelector: matchLabels: (component & {c: "airlock-mesh"}).out}], ports: [{port: meshPort, protocol: "TCP"}]},
				]
			}
		},
		// `airlock-out` and `airlock-egress`: the airlock in, the bridges, the
		// blob plane and the world out.
		{
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata:   {name: "\(app.name)-airlock-mesh", namespace: app.namespace, labels: (component & {c: "airlock-mesh"}).out}
			spec: {
				podSelector: matchLabels: (component & {c: "airlock-mesh"}).out
				policyTypes: ["Ingress", "Egress"]
				ingress: [{
					from:  [{podSelector: matchLabels: (component & {c: "airlock"}).out}]
					ports: [{port: meshPort, protocol: "TCP"}]
				}]
				egress: list.Concat([
					[dns],
					[for c, b in A.bridges {to: [{podSelector: matchLabels: (component & {"c": c}).out}], ports: [{port: b.port, protocol: "TCP"}]}],
					[if app.runtime["rclone-s3"] != _|_ {to: [{podSelector: matchLabels: (component & {c: "rclone-s3"}).out}], ports: [{port: 3900, protocol: "TCP"}]}],
					[{to: outside}],
				])
			}
		},
	], [for c, b in A.bridges for object in [
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata:   {name: "\(app.name)-bridge-\(c)", namespace: app.namespace, labels: (component & {"c": c}).out & {(#bridgeLabel): "true"}}
			spec: {
				// Always up: nothing in front of a bridge holds a call while one
				// starts, so a cold bridge would fail the run that woke it.
				replicas: 1
				selector: matchLabels: (component & {"c": c}).out
				template: {
					metadata: {
						labels: (component & {"c": c}).out & {(#bridgeLabel): "true"}
						if b.envDigest != "" {
							annotations: "pronto.dev/env-digest": b.envDigest
						}
					}
					spec: {
						// Nothing of the API is a bridge's to call.
						automountServiceAccountToken: false
						containers: [{
							name:            c
							image:           images[b.build]
							imagePullPolicy: environment.imagePullPolicy
							ports:           [{name: "http", containerPort: b.port}]
							// The environment compose gives the container, secrets
							// among it, which the release writes and no manifest holds.
							envFrom:        [{secretRef: {name: "\(app.name)-bridge-\(c)", optional: true}}]
							resources:      app.airlockResources
							startupProbe:   {tcpSocket: port: b.port, periodSeconds: 2, failureThreshold: 90}
							readinessProbe: {tcpSocket: port: b.port, periodSeconds: 5}
						}]
					}
				}
			}
		},
		// The daprd dials the bridge by its container's name, as in compose.
		{
			apiVersion: "v1"
			kind:       "Service"
			metadata:   {name: c, namespace: app.namespace, labels: (component & {"c": c}).out & {(#bridgeLabel): "true"}}
			spec: {
				selector: (component & {"c": c}).out
				ports:    [{name: "http", port: b.port, targetPort: b.port, protocol: "TCP"}]
			}
		},
		// compose's `bridge-<name>-egress`: the daprd in, the world out.
		// Named `bridge-` within the app, so no container's name takes one of
		// the release's own, the Secret auth reads among them.
		{
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata:   {name: "\(app.name)-bridge-\(c)", namespace: app.namespace, labels: (component & {"c": c}).out & {(#bridgeLabel): "true"}}
			spec: {
				podSelector: matchLabels: (component & {"c": c}).out
				policyTypes: ["Ingress", "Egress"]
				ingress: [{
					from:  [{podSelector: matchLabels: (component & {c: "airlock-mesh"}).out}]
					ports: [{port: b.port, protocol: "TCP"}]
				}]
				egress: [dns, {to: outside}]
			}
		},
	] {object}]]) {object}]])
}
