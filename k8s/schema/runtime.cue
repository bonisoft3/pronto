package schema

#Runtime: {
	app:         #ReleaseSpec
	environment: #Environment
	images: [string]: string
	let servicePorts = {compute: 9997, feldera: 8080, redis: 6379, conduit: 8080, "mesh-events": 3500, transform: 4195, ticker: 9998, clock: 9996, "rclone-s3": 3900, imgproxy: 8081}
	let mounts = {feldera: "/home/ubuntu/.feldera", compute: "/lake", redis: "/data", "rclone-s3": "/data"}
	let appLabels = {"app.kubernetes.io/name": app.name}
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
						if svc == "feldera" {securityContext: fsGroup: 1000}
						if mounts[svc] != _|_ {
							volumes: [{name: "state", persistentVolumeClaim: claimName: "\(app.name)-\(svc)"}]
						}
						containers: [{
							"name":          svc
							image:           images[svc]
							imagePullPolicy: environment.imagePullPolicy
							resources:       app.runtimeResources
							if mounts[svc] != _|_ {volumeMounts: [{name: "state", mountPath: mounts[svc]}]}
							if svc == "redis" {args: ["redis-server", "--appendonly", "yes", "--appendfsync", "always"]}
							env: [
								if len(runtime.databaseEnvironment) > 0 {{name: "PGPASSWORD", valueFrom: secretKeyRef: {name: "\(app.name)-db-postgres", key: "password"}}},
								for envName in runtime.databaseEnvironment {name: envName, value: "postgresql://postgres:$(PGPASSWORD)@database:5432/\(app.name)?sslmode=disable"},
								if runtime.serviceToken {{name: "SERVICE_JWT", valueFrom: secretKeyRef: {name: "\(app.name)-service-token", key: "SERVICE_JWT"}}},
								for k, v in runtime.env {name: k, value: v},
								if svc == "conduit" {{name: "CONDUIT_DB_TYPE", value: "postgres"}},
								if svc == "conduit" {{name: "CONDUIT_DB_POSTGRES_CONNECTION_STRING", value: "$(DATABASE_URL)"}},
								if runtime.jwtSecret {{name: "PGRST_JWT_SECRET", valueFrom: secretKeyRef: {name: "\(app.name)-auth-secrets", key: "PGRST_JWT_SECRET"}}},
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
				ingress: [{from: [{podSelector: matchLabels: appLabels}]}]
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
