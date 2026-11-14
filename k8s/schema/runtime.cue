package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/yaml"
	"regexp"
	"strconv"
)

#Runtime: {
	app:         #ReleaseSpec
	environment: #Environment
	images: [string]: string
	// Where readers are: the door's origin, over compose's development one.
	origin: string
	let servicePorts = {compute: 9997, feldera: 8080, redis: 6379, conduit: 8080, "mesh-events": 3500, transform: 4195, ticker: 9998, clock: 9996, "rclone-s3": 3900, imgproxy: 8081, airlock: 9997, "airlock-mesh": 3500}
	let mounts = {feldera: "/home/ubuntu/.feldera", compute: "/lake", redis: "/data", "rclone-s3": "/data"}
	let appLabels = {"app.kubernetes.io/name": app.id}
	let componentLabels = {for svc, _ in servicePorts {(svc): appLabels & {"app.kubernetes.io/component": svc}}}
	let dns = {ports: [{port: 53, protocol: "TCP"}, {port: 53, protocol: "UDP"}]}
	// DNS named: the cluster's kube-dns, NodeLocal DNSCache's address where a node runs one, and the
	// metadata server's, which answers DNS under GKE's Cloud DNS (on 53 alone: its HTTP stays shut).
	let namedDns = dns & {to: [
		{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": "kube-system"}, podSelector: matchLabels: {"k8s-app": "kube-dns"}},
		{ipBlock: cidr: "169.254.20.10/32"},
		{ipBlock: cidr: "169.254.169.254/32"},
	]}
	let mesh = *app.runtime["airlock-mesh"].env | {}
	let sinks = app.airlock.sinks
	// The sinks' ports, each origin's own or 443 (mecha's #Origin).
	let sinkPorts = {
		for _, s in sinks if s.origin != _|_ {
			let p = [if s.origin =~ ":[0-9]+$" {strconv.Atoi(regexp.FindSubmatch("^.*:([0-9]+)$", s.origin)[1])}, 443][0]
			"\(p)": p
		}
	}
	// The in-cluster sinks' pod ports, by namespace.
	let inCluster = {for _, s in sinks if s.service != _|_ {(s.service.namespace): "\(s.service.targetPort)": s.service.targetPort}}
	// Each effect's HTTPEndpoint on this target, mounted over the one the image bakes from compose's.
	let endpoints = {for n, s in sinks {
		"\(n).yaml": yaml.Marshal({
			apiVersion: "dapr.io/v1alpha1"
			kind:       "HTTPEndpoint"
			metadata: name: n
			spec: baseUrl: [
				if s.origin != _|_ {s.origin},
				if s.service != _|_ {"http://\(s.service.name).\(s.service.namespace).svc.cluster.local\([if s.service.port != 80 {":\(s.service.port)"}, ""][0])\([if s.service.path != _|_ {s.service.path}, ""][0])"},
			][0]
		})
	}}
	// A service mesh's control plane, which its sidecars in the airlock's pods reach.
	let meshControlPlane = [if app.networkPolicy.meshControlPlane != _|_ {
		let m = app.networkPolicy.meshControlPlane
		to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": m.namespace}}]
		ports: [for p in m.ports {port: p, protocol: "TCP"}]
	}]
	// The two walls compose keeps with two networks (mecha's #AirlockNetworks), as two pods: the
	// airlock reaches the database and its daprd alone, and only the ticker's wake reaches it; its
	// daprd is reached by the airlock alone and reaches the sinks, under networkPolicy.internet
	// "airlock" the app's one way out. One pod would share one network namespace, leaving the
	// airlock's --allow-net the only wall.
	let airlockPolicies = {
		airlock: {
			ingress: [{from: [{podSelector: matchLabels: componentLabels.ticker}], ports: [{port: 9997, protocol: "TCP"}]}]
			egress: [
				{to: [{podSelector: matchLabels: {"cnpg.io/cluster": "\(app.id)-db"}}], ports: [{port: 5432, protocol: "TCP"}]},
				{to: [{podSelector: matchLabels: componentLabels["airlock-mesh"]}], ports: [{port: 3500, protocol: "TCP"}]},
				namedDns,
				for r in meshControlPlane {r},
			]
		}
		"airlock-mesh": {
			ingress: [{from: [{podSelector: matchLabels: componentLabels.airlock}], ports: [{port: 3500, protocol: "TCP"}]}]
			egress: [
				namedDns,
				// The internet: no private, shared (carrier-grade NAT) or link-local address, where a
				// cloud's metadata server answers.
				if len(sinkPorts) > 0 {
					to: [{ipBlock: {cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"]}}]
					ports: [for _, p in sinkPorts {port: p, protocol: "TCP"}]
				},
				// Each in-cluster sink's namespace, on its pods' ports: a NetworkPolicy matches the
				// connection after the Service's address is translated to a pod's.
				for ns, podPorts in inCluster {
					to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": ns}}]
					ports: [for _, p in podPorts {port: p, protocol: "TCP"}]
				},
				// The blob plane's binding, where the app has one.
				if mesh.BLOBS_S3_URL != _|_ {
					to: [{podSelector: matchLabels: componentLabels["rclone-s3"]}]
					ports: [{port: servicePorts["rclone-s3"], protocol: "TCP"}]
				},
				for r in meshControlPlane {r},
			]
		}
	}
	objects: [for svc, runtime in app.runtime for object in [
		if svc == "airlock-mesh" {
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata: {name: "\(app.id)-airlock-endpoints", namespace: app.ns}
			data: endpoints
		},
		if mounts[svc] != _|_ {
			apiVersion: "v1"
			kind:       "PersistentVolumeClaim"
			metadata: {name: "\(app.id)-\(svc)", namespace: app.ns}
			spec: {
				accessModes: ["ReadWriteOnce"]
				resources: requests: storage: app.runtimeStorage
				if environment.storageClass != "" {storageClassName: environment.storageClass}
			}
		},
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {name: "\(app.id)-\(svc)", namespace: app.ns}
			spec: {
				// A rolling replacement would give two writers the same CDC slots and state.
				replicas: 1
				strategy: type: "Recreate"
				selector: matchLabels: appLabels & {"app.kubernetes.io/component": svc}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": svc}
						if svc == "ticker" || svc == "rclone-s3" || svc == "imgproxy" {
							annotations: {
								"dapr.io/enabled":  "true"
								"dapr.io/app-id":   svc
								"dapr.io/app-port": "\(servicePorts[svc])"
								"dapr.io/config":   "\(app.id)-dapr-config"
							}
						}
						// A changed endpoint rolls the daprd, which reads its resources at start.
						if svc == "airlock-mesh" {annotations: "pronto.dev/config": hex.Encode(sha256.Sum256(yaml.Marshal(endpoints)))}
					}
					spec: {
						terminationGracePeriodSeconds: 120
						if svc == "feldera" {securityContext: fsGroup: 1000}
						if mounts[svc] != _|_ {
							volumes: [{name: "state", persistentVolumeClaim: claimName: "\(app.id)-\(svc)"}]
						}
						if svc == "airlock-mesh" {volumes: [{name: "endpoints", configMap: name: "\(app.id)-airlock-endpoints"}]}
						containers: [{
							"name":          svc
							image:           images[svc]
							imagePullPolicy: environment.imagePullPolicy
							resources:       app.runtimeResources
							if mounts[svc] != _|_ {volumeMounts: [{name: "state", mountPath: mounts[svc]}]}
							// File by file: the image's wall, resiliency and blob binding stay.
							if svc == "airlock-mesh" {volumeMounts: [for n, _ in sinks {name: "endpoints", mountPath: "/dapr/airlock/\(n).yaml", subPath: "\(n).yaml", readOnly: true}]}
							if svc == "redis" {args: ["redis-server", "--appendonly", "yes", "--appendfsync", "always"]}
							env: [
								if len(runtime.databaseEnvironment) > 0 {{name: "PGPASSWORD", valueFrom: secretKeyRef: {name: "\(app.id)-db-postgres", key: "password"}}},
								for envName in runtime.databaseEnvironment {name: envName, value: "postgresql://postgres:$(PGPASSWORD)@database:5432/\(app.id)?sslmode=disable"},
								if runtime.serviceToken {{name: "SERVICE_JWT", valueFrom: secretKeyRef: {name: "\(app.id)-service-jwt", key: "SERVICE_JWT"}}},
								for k, v in runtime.env if k != "ORIGIN" {name: k, value: v},
								if runtime.env.ORIGIN != _|_ {{name: "ORIGIN", value: origin}},
								for k in runtime.secrets {name: k, valueFrom: secretKeyRef: {name: app.airlock.secrets[k], key: k}},
								if svc == "conduit" {{name: "CONDUIT_DB_TYPE", value: "postgres"}},
								if svc == "conduit" {{name: "CONDUIT_DB_POSTGRES_CONNECTION_STRING", value: "$(DATABASE_URL)"}},
								if runtime.jwtSecret {{name: "PGRST_JWT_SECRET", valueFrom: secretKeyRef: {name: "\(app.id)-auth-secrets", key: "PGRST_JWT_SECRET"}}},
							]
							if svc != "transform" && svc != "clock" {
								ports: [{containerPort: servicePorts[svc]}]
								startupProbe: {tcpSocket: port: servicePorts[svc], periodSeconds: 5, failureThreshold: 180}
								readinessProbe: {tcpSocket: port: servicePorts[svc], periodSeconds: 5}
							}
						}]
					}
				}
			}
		},
		if svc != "transform" && svc != "clock" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {"name": svc, namespace: app.ns}
			spec: {
				selector: appLabels & {"app.kubernetes.io/component": svc}
				ports: [{port: servicePorts[svc], targetPort: servicePorts[svc]}]
			}
		},
		if app.networkPolicy.enabled {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {name: "\(app.id)-\(svc)", namespace: app.ns}
			spec: {
				podSelector: matchLabels: appLabels & {"app.kubernetes.io/component": svc}
				policyTypes: ["Ingress", "Egress"]
				if airlockPolicies[svc] != _|_ {airlockPolicies[svc]}
				if airlockPolicies[svc] == _|_ {
					ingress: [{from: [{podSelector: matchLabels: appLabels}]}]
					egress: [
						{to: [{podSelector: matchLabels: appLabels}]},
						{to: [{podSelector: matchLabels: {"cnpg.io/cluster": "\(app.id)-db"}}], ports: [{port: 5432, protocol: "TCP"}]},
						dns,
						{to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": "dapr-system"}}], ports: [for p in [443, 4000, 50001, 50005, 50006, 6500] {port: p, protocol: "TCP"}]},
						{to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": "observability"}}], ports: [{port: 4317, protocol: "TCP"}, {port: 4318, protocol: "TCP"}]},
					]
				}
			}
		},
	] {object}]
}
