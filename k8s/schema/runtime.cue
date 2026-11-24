package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/yaml"
	"strings"
)

#Runtime: {
	app:         #ReleaseSpec
	environment: #Environment
	images: [string]: string
	let servicePorts = {compute: 9997, risingwave: 4566, redis: 6379, conduit: 8080, "mesh-events": 3500, transform: 4195, ticker: 9998, clock: 9996, "rclone-s3": 3900, imgproxy: 8081}
	let mounts = {redis: "/data", "rclone-s3": "/data"}
	let appLabels = {"app.kubernetes.io/name": app.name}
	let replays = app.replays
	let replayGroups = [for r in replays {r.group}]
	let subscriptions = strings.Join([for r in replays {yaml.Marshal({
		apiVersion: "dapr.io/v2alpha1"
		kind:       "Subscription"
		metadata: name: "\(r.group)-retry"
		spec: {
			pubsubname:      "redis-streams"
			topic:           "\(r.group)-retry"
			routes: default: "/\(r.name)/replay"
			deadLetterTopic: "\(r.group)-dead"
		}
		scopes: ["mechaed"]
	})}], "---\n")
	let subscriptionsDigest = hex.Encode(sha256.Sum256(subscriptions))
	objects: [for svc, runtime in app.runtime for object in [
		if mounts[svc] != _|_ {
			apiVersion: "v1"
			kind:       "PersistentVolumeClaim"
			metadata: {name: "\(app.name)-\(svc)", namespace: app.namespace}
			spec: {
				accessModes: ["ReadWriteOnce"]
				resources: requests: storage: app.runtimeStorage
				if environment.storageClass != "" {storageClassName: environment.storageClass}
			}
		},
		if svc == "mesh-events" && len(replays) > 0 {
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata: {
				name:      "\(app.name)-mesh-events-subscriptions"
				namespace: app.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "mesh-events"}
			}
			data: "retry.yaml": subscriptions
		},
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {name: "\(app.name)-\(svc)", namespace: app.namespace}
			spec: {
				// A rolling replacement would give two writers the same CDC slots and state.
				replicas: 1
				strategy: type: "Recreate"
				selector: matchLabels: appLabels & {"app.kubernetes.io/component": svc}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": svc}
						if svc == "mesh-events" && len(replays) > 0 {
							annotations: "checksum/subscriptions": subscriptionsDigest
						}
						if svc == "ticker" || svc == "rclone-s3" || svc == "imgproxy" {
							annotations: {
								"dapr.io/enabled":  "true"
								"dapr.io/app-id":   svc
								"dapr.io/app-port": "\(servicePorts[svc])"
								"dapr.io/config":   "\(app.name)-dapr-config"
							}
						}
					}
					spec: {
						terminationGracePeriodSeconds: 120
						if mounts[svc] != _|_ {
							volumes: [{name: "state", persistentVolumeClaim: claimName: "\(app.name)-\(svc)"}]
						}
						if svc == "mesh-events" && len(replays) > 0 {
							volumes: [{name: "subscriptions", configMap: name: "\(app.name)-mesh-events-subscriptions"}]
						}
						containers: [{
							"name":          svc
							image:           images[svc]
							imagePullPolicy: environment.imagePullPolicy
							resources:       app.runtimeResources
							if mounts[svc] != _|_ {volumeMounts: [{name: "state", mountPath: mounts[svc]}]}
							if svc == "mesh-events" && len(replays) > 0 {
								volumeMounts: [{name: "subscriptions", mountPath: "/mesh-events/subscriptions", readOnly: true}]
							}
							if svc == "risingwave" {args: ["single_node"]}
							if svc == "redis" {args: ["redis-server", "--appendonly", "yes", "--appendfsync", "always", "--aof-load-corrupt-tail-max-size", "65536", "--maxmemory", "$(REDIS_MAXMEMORY)", "--maxmemory-policy", "noeviction"]}
							env: [
								if len(runtime.databaseEnvironment) > 0 {{name: "PGPASSWORD", valueFrom: secretKeyRef: {name: "\(app.name)-db-postgres", key: "password"}}},
								for envName in runtime.databaseEnvironment {name: envName, value: "postgresql://postgres:$(PGPASSWORD)@database:5432/\(app.name)?sslmode=disable"},
								if runtime.serviceToken {{name: "SERVICE_JWT", valueFrom: secretKeyRef: {name: "\(app.name)-service-token", key: "SERVICE_JWT"}}},
								for k, v in runtime.env {name: k, value: v},
								if svc == "redis" if runtime.env.REDIS_MAXMEMORY == _|_ {{name: "REDIS_MAXMEMORY", value: "256mb"}},
								if svc == "mesh-events" && len(replays) > 0 {{name: "MESH_SUBSCRIPTIONS_DIR", value: "/mesh-events/subscriptions"}},
								if svc == "mesh-events" && len(replays) > 0 {{name: "MESH_APP_ADDRESS", value: "transform"}},
								if svc == "mesh-events" && len(replays) > 0 {{name: "MESH_APP_PORT", value: "\(servicePorts.transform)"}},
								if svc == "transform" && len(replays) > 0 if runtime.env.CDC_RETRY_GROUPS == _|_ {{name: "CDC_RETRY_GROUPS", value: json.Marshal(replayGroups)}},
								if svc == "transform" && len(replays) > 0 if runtime.env.CDC_REPLAY_PORT == _|_ {{name: "CDC_REPLAY_PORT", value: "\(servicePorts.transform)"}},
								if svc == "conduit" {{name: "CONDUIT_DB_TYPE", value: "postgres"}},
								if svc == "conduit" {{name: "CONDUIT_DB_POSTGRES_CONNECTION_STRING", value: "$(DATABASE_URL)"}},
								if runtime.jwtSecret {{name: "PGRST_JWT_SECRET", valueFrom: secretKeyRef: {name: "\(app.name)-auth-secrets", key: "PGRST_JWT_SECRET"}}},
							]
							if (svc != "transform" || len(replays) > 0) && svc != "clock" {
								ports: [{containerPort: servicePorts[svc]}]
								startupProbe: {tcpSocket: port: servicePorts[svc], periodSeconds: 5, failureThreshold: 180}
								readinessProbe: {tcpSocket: port: servicePorts[svc], periodSeconds: 5}
							}
						}]
					}
				}
			}
		},
		if (svc != "transform" || len(replays) > 0) && svc != "clock" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {"name": svc, namespace: app.namespace}
			spec: {
				selector: appLabels & {"app.kubernetes.io/component": svc}
				ports: [{port: servicePorts[svc], targetPort: servicePorts[svc]}]
			}
		},
		if app.networkPolicy.enabled {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {name: "\(app.name)-\(svc)", namespace: app.namespace}
			spec: {
				podSelector: matchLabels: appLabels & {"app.kubernetes.io/component": svc}
				policyTypes: ["Ingress", "Egress"]
				if svc == "risingwave" {
					ingress: [{from: [{podSelector: {matchLabels: appLabels & {"app.kubernetes.io/component": "compute"}, matchExpressions: [#notBridge]}}], ports: [{port: 4566, protocol: "TCP"}]}]
				}
				if svc != "risingwave" {
					ingress: [{from: [{podSelector: {matchLabels: appLabels, matchExpressions: [#notBridge]}}]}]
				}
				egress: [
					{to: [{podSelector: matchLabels: appLabels}]},
					{to: [{podSelector: matchLabels: {"cnpg.io/cluster": "\(app.name)-db"}}], ports: [{port: 5432, protocol: "TCP"}]},
					{ports: [{port: 53, protocol: "TCP"}, {port: 53, protocol: "UDP"}]},
					{to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": "dapr-system"}}], ports: [for p in [443, 4000, 50001, 50005, 50006, 6500] {port: p, protocol: "TCP"}]},
					{to: [{namespaceSelector: matchLabels: {"kubernetes.io/metadata.name": "observability"}}], ports: [{port: 4317, protocol: "TCP"}, {port: 4318, protocol: "TCP"}]},
				]
			}
		},
	] {object}]
}
