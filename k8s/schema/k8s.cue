package schema

import (
	"encoding/yaml"
	"list"
	"strings"

	"github.com/bonisoft3/pronto/resilience"
)

// #BuildManifests maps a ReleaseSpec and Environment into standard Kubernetes manifests.
#BuildManifests: {
	release: #ReleaseSpec
	env:     #Environment

	let targetEnv = env
	let appLabels = {
		"app.kubernetes.io/name":       release.name
		"app.kubernetes.io/instance":   release.name
		"app.kubernetes.io/managed-by": "cue"
	}
	let gatewayHostname = [
		if release.gateway.host != _|_ {release.gateway.host},
		"\(release.name).\(targetEnv.domainSuffix)",
	][0]

	let namespaceObj = [
		if release.namespace != "default" {
			apiVersion: "v1"
			kind:       "Namespace"
			metadata: name: release.namespace
		},
	]



	// Every service runs the image the app's own compose project builds, pushed
	// to the environment's registry: what integrate tested is what releases.
	#appImage: {
		svc: string
		let ref = [
			if release.image.pushed[svc] != _|_ {":\(release.image.pushed[svc].tag)@\(release.image.pushed[svc].digest)"},
			":\(release.image.tag)",
		][0]
		out: [
			if targetEnv.registry != "" {"\(targetEnv.registry)/\(release.name)-\(svc)\(ref)"},
			"\(release.name)-\(svc)\(ref)",
		][0]
	}

	// Every pod joins the mesh: caddy reaches its upstreams through its sidecar
	// (PRONTO_UPSTREAM_*), and each hop's sidecar reports a span to Jaeger.
	#daprSidecar: {
		id:   string
		port: string
		out: {
			"dapr.io/enabled":        "true"
			"dapr.io/app-id":         id
			"dapr.io/app-port":       port
			"dapr.io/config":         "\(release.name)-dapr-config"
			"dapr.io/enable-metrics": "true"
			"dapr.io/metrics-port":   "9090"
			// A pod being replaced is still the one other sidecars resolve for a
			// few seconds after its successor is ready: its sidecar keeps
			// answering through each app container's 15s preStop pause, inside
			// the default 30s grace, rather than leaving those calls to fail.
			"dapr.io/block-shutdown-duration": "20s"
		}
	}

	// Where a service sends its spans: Deno exports OTLP over HTTP (4318),
	// caddy's `tracing` over gRPC (4317); both read the same variables.
	#otelExport: {
		service: string
		port:    *4318 | 4317
		env: [
			{name: "OTEL_SERVICE_NAME", value: service},
			{name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://jaeger.observability.svc.cluster.local:\(port)"},
		]
	}

	// Deno's built-in OpenTelemetry spans Deno.serve and fetch, and carries the
	// request's traceparent onto the fetches made while serving it.
	#denoTelemetry: {
		service: string
		env: list.Concat([[{name: "OTEL_DENO", value: "true"}], (#otelExport & {"service": service}).env])
	}

	let originValue = [
		if release.env["ORIGIN"] != _|_ {release.env["ORIGIN"]},
		"https://\(gatewayHostname)",
	][0]

	let authRpId = [
		if release.auth.rpId != _|_ {release.auth.rpId},
		if release.gateway.host != _|_ {release.gateway.host},
		if targetEnv.domainSuffix != "" {"\(release.name).\(targetEnv.domainSuffix)"},
		"localhost",
	][0]

	let authOrigin = [
		if release.auth.origin != _|_ {release.auth.origin},
		originValue,
	][0]

	let prontoClusterObj = [
		if release.type == "pronto" {
			apiVersion: "postgresql.cnpg.io/v1"
			kind:       "Cluster"
			metadata: {
				name:      "\(release.name)-db"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			spec: {
				instances: 1
				imageName: (#appImage & {svc: "database"}).out
				// mecha's database image derives from the official postgres image,
				// whose postgres user is 999, not CloudNativePG's 26.
				postgresUID: 999
				postgresGID: 999
				// One credential for postgres, the role that owns the schema
				// and the one auth and the schema Jobs connect as.
				enableSuperuserAccess: true
				superuserSecret: name: "\(release.name)-db-postgres"
				managed: roles: [{
					name:        "electric"
					ensure:      "present"
					login:       true
					replication: true
					bypassrls:   true
					passwordSecret: name: "\(release.name)-electric-db"
				}, {
					// PostgREST's login. The operator revokes any membership this
					// list leaves out, so it names every role a token can: the
					// schema's, which exist only once initdb has run.
					name:    "authenticator"
					ensure:  "present"
					login:   true
					inherit: false
					inRoles: release.database.tokenRoles
					passwordSecret: name: "\(release.name)-authenticator-db"
				}]
				bootstrap: initdb: {
					database:       release.name
					owner:          "postgres"
					localeProvider: "icu"
					icuLocale:      "und"
					secret: name:   "\(release.name)-db-postgres"
				}
				storage: {
					size: release.database.storage
					if targetEnv.storageClass != "" {
						storageClass: targetEnv.storageClass
					}
				}
			}
		},
	]

	// The schema, built as compose builds it, by the app's own images: initdb
	// runs the database image's initdb directory once, on a fresh database, and
	// migrate carries it forward with pgroll on every release. The image's
	// docker_process_sql pins the local socket, so the Job restates it against
	// the cluster's database Service; every step otherwise runs as the image's
	// entrypoint runs it. A database comment marks initdb done.
	let schemaEnv = [
		{name: "PGHOST", value: "database"},
		{name: "PGPORT", value: "5432"},
		{name: "POSTGRES_USER", value: "postgres"},
		{name: "POSTGRES_DB", value: release.name},
		{name: "PGDATABASE", value: release.name},
		{name: "PGUSER", value: "postgres"},
		{
			name: "PGPASSWORD"
			valueFrom: secretKeyRef: {name: "\(release.name)-db-postgres", key: "password"}
		},
	]
	let schemaJob = {
		component: string
		svc:       string
		env: [...]
		command?: [...string]
		out: {
			apiVersion: "batch/v1"
			kind:       "Job"
			metadata: {
				name:      "\(release.name)-\(component)"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": component}
			}
			spec: {
				backoffLimit: 0
				template: {
					metadata: labels: appLabels & {"app.kubernetes.io/component": component}
					spec: {
						restartPolicy: "Never"
						containers: [{
							name:            component
							image:           (#appImage & {"svc": svc}).out
							imagePullPolicy: targetEnv.imagePullPolicy
							if command != _|_ {"command": command}
							"env": env
						}]
					}
				}
			}
		}
	}
	let schemaJobObj = [
		if release.type == "pronto" {
			(schemaJob & {
				component: "initdb"
				svc:       "database"
				// The roles' passwords the image's initdb step sets, from the
				// secrets the operator sets them from too.
				env: list.Concat([schemaEnv, [for role in ["electric", "authenticator"] {
					name: "\(strings.ToUpper(role))_PASSWORD"
					valueFrom: secretKeyRef: {name: "\(release.name)-\(role)-db", key: "password"}
				}]])
				command: ["bash", "-c", """
					set -euo pipefail
					marker=$(psql -XtAc "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()")
					if [ "$marker" = "pronto initdb" ]; then
					  echo "initdb: already built"
					  # Its re-runnable steps are the release's, though (emit.cue's): a new
					  # entity's table, every policy, trigger and publication, and the hybrid
					  # machines' code run again, keeping every row.
					  for step in 005_create_tables 006_policies 007_txid 008_publication 016_mecha_actors; do
					    f=/docker-entrypoint-initdb.d/$step.sql
					    if [ -f "$f" ]; then psql -v ON_ERROR_STOP=1 -Xq -f "$f"; fi
					  done
					  exit 0
					fi
					source /usr/local/bin/docker-entrypoint.sh
					docker_process_sql() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password --no-psqlrc --dbname "$POSTGRES_DB" "$@"; }
					docker_process_init_files /docker-entrypoint-initdb.d/*
					psql -XqAc "COMMENT ON DATABASE \\"$POSTGRES_DB\\" IS 'pronto initdb'"
					"""]
			}).out
		},
		if release.type == "pronto" && release.migrate != _|_ {
			(schemaJob & {
				component: "migrate"
				svc:       "migrate"
				env: list.Concat([schemaEnv, [
					{name: "DATABASE_URL", value: "postgres://postgres:$(PGPASSWORD)@database:5432/\(release.name)?sslmode=disable"},
					for k, v in release.migrate.env {name: k, value: v},
				]])
			}).out
		},
	]

	let prontoDatabaseServiceObj = [
		if release.type == "pronto" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "database"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"cnpg.io/cluster":      "\(release.name)-db"
					"cnpg.io/instanceRole": "primary"
				}
				ports: [{
					name:       "postgres"
					port:       5432
					targetPort: 5432
					protocol:   "TCP"
				}]
			}
		},

	]

	// The app's secrets come from the cluster's store when it has one, and are
	// otherwise generated once in-cluster by ESO; none is ever a literal.
	// Generated values carry no symbols: electric's lands inside a URL.
	let appSecrets = [
		{key: "PGRST_JWT_SECRET", length: 48, target: "\(release.name)-auth-secrets"},
		{key: "ELECTRIC_SECRET", length: 32, target: "\(release.name)-auth-secrets"},
		{key: "ELECTRIC_PASSWORD", length: 32, target: "\(release.name)-electric-db", role: "electric"},
		{key: "AUTHENTICATOR_PASSWORD", length: 32, target: "\(release.name)-authenticator-db", role: "authenticator"},
		{key: "POSTGRES_PASSWORD", length: 32, target: "\(release.name)-db-postgres", role: "postgres"},
	]

	let prontoSecretGeneratorObj = [
		if release.type == "pronto" && !release.externalSecrets.enabled
		for sec in appSecrets {
			apiVersion: "generators.external-secrets.io/v1alpha1"
			kind:       "Password"
			metadata: {
				name:      "\(release.name)-\(strings.ToLower(strings.Replace(sec.key, "_", "-", -1)))"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				length:      sec.length
				digits:      8
				symbols:     0
				noUpper:     false
				allowRepeat: true
			}
		},
	]

	// One secret's entries: a store lookup, or its generator's password renamed to its key.
	let secretSource = {
		sec: _
		data: [if release.externalSecrets.enabled {
			{secretKey: sec.key, remoteRef: key: "\(release.name)/\(sec.key)"}
		}]
		dataFrom: [if !release.externalSecrets.enabled {
			{
				sourceRef: generatorRef: {
					apiVersion: "generators.external-secrets.io/v1alpha1"
					kind:       "Password"
					name:       "\(release.name)-\(strings.ToLower(strings.Replace(sec.key, "_", "-", -1)))"
				}
				rewrite: [{regexp: {source: "password", target: sec.key}}]
			}
		}]
	}

	let storeRef = {
		if release.externalSecrets.enabled {
			secretStoreRef: {
				name: release.externalSecrets.secretStoreRef
				kind: "ClusterSecretStore"
			}
		}
	}

	let prontoExternalSecretObj = [
		if release.type == "pronto" {
			apiVersion: "external-secrets.io/v1beta1"
			kind:       "ExternalSecret"
			metadata: {
				name:      "\(release.name)-auth-secrets"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: storeRef & {
				// A generated secret never rotates under running pods.
				refreshInterval: [if release.externalSecrets.enabled {"1h"}, "0"][0]
				target: {
					name:           "\(release.name)-auth-secrets"
					creationPolicy: "Owner"
				}
				let auth = [for sec in appSecrets if sec.target == "\(release.name)-auth-secrets" {secretSource & {"sec": sec}}]
				data: list.FlattenN([for src in auth {src.data}], 1)
				dataFrom: list.FlattenN([for src in auth {src.dataFrom}], 1)
			}
		},
		// A database role's credential, as CloudNativePG reads it: electric's
		// and authenticator's (managed.roles) and postgres's (superuser and
		// owner), so the schema declares the roles and never their passwords.
		for sec in appSecrets if sec.role != _|_ if release.type == "pronto" {
			apiVersion: "external-secrets.io/v1beta1"
			kind:       "ExternalSecret"
			metadata: {
				name:      sec.target
				namespace: release.namespace
				labels:    appLabels
			}
			spec: storeRef & {
				refreshInterval: [if release.externalSecrets.enabled {"1h"}, "0"][0]
				target: {
					name:           sec.target
					creationPolicy: "Owner"
					template: {
						type: "kubernetes.io/basic-auth"
						data: {
							username: sec.role
							password: "{{ .\(sec.key) }}"
						}
					}
				}
				let src = secretSource & {"sec": sec}
				data:     src.data
				dataFrom: src.dataFrom
			}
		},
	]

	let bounds = resilience.resilience.timeouts

	// Every call between sidecars to the cluster's own apps is bounded. No
	// circuit breaker: Dapr 1.14 counts any answer outside 200-399 as a
	// failure, so a client's 401s, a shape's 409s or a missing row's 404s would
	// open a target's circuit for everyone. No retry policy either: a write is
	// not replayed.
	let daprResiliencyObj = [if release.type == "pronto" {
		apiVersion: "dapr.io/v1alpha1"
		kind:       "Resiliency"
		metadata: {
			name:      "\(release.name)-resiliency"
			namespace: release.namespace
			labels:    appLabels
		}
		spec: {
			policies: {
				timeouts: {for id, s in bounds.mesh {(id): "\(s)s"}}
			}
			targets: apps: {
				for id, _ in bounds.mesh {
					(id): timeout: id
				}
			}
		}
	}]

	let daprConfigObj = [{
		apiVersion: "dapr.io/v1alpha1"
		kind:       "Configuration"
		metadata: {
			name:      "\(release.name)-dapr-config"
			namespace: release.namespace
			labels:    appLabels
		}
		spec: {
			tracing: {
				samplingRate: "1"
				otel: {
					endpointAddress: "jaeger.observability.svc.cluster.local:4317"
					isSecure:        false
					protocol:        "grpc"
				}
			}
			metric: enabled: true
		}
	}]


	let prontoCrudDeploymentObj = [
		if release.type == "pronto" {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-crud"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "crud"}
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "crud"
				}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": "crud"}
						annotations: (#daprSidecar & {id: "crud", port: "3000"}).out
					}
					spec: containers: [{
						name:            "crud"
						image:           (#appImage & {svc: "crud"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						lifecycle: preStop: sleep: seconds: 15
						ports: [
							{name: "http", containerPort: 3000},
							{name: "admin", containerPort: 3001},
						]
						env: [
							{
								name: "AUTHENTICATOR_PASSWORD"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-authenticator-db"
									key:  "password"
								}
							},
							{
								name:  "PGRST_DB_URI"
								value: "postgres://authenticator:$(AUTHENTICATOR_PASSWORD)@database:5432/\(release.name)"
							},
							{name: "PGRST_DB_SCHEMA", value: "public"},
							{name: "PGRST_DB_ANON_ROLE", value: "anon"},
							{name: "PGRST_DB_PRE_REQUEST", value: "public.app_pre_request"},
							{
								name: "PGRST_JWT_SECRET"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-auth-secrets"
									key:  "PGRST_JWT_SECRET"
								}
							},
							{name: "PGRST_SERVER_HOST", value: "*"},
							{name: "PGRST_SERVER_PORT", value: "3000"},
							{name: "PGRST_ADMIN_SERVER_PORT", value: "3001"},
						]
						resources: release.resources
						livenessProbe: {
							httpGet: {
								path: "/ready"
								port: 3001
							}
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						readinessProbe: {
							httpGet: {
								path: "/ready"
								port: 3001
							}
							initialDelaySeconds: 5
							periodSeconds:       5
						}
					}]
				}
			}
		},
	]

	let prontoCrudServiceObj = [
		if release.type == "pronto" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "crud"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "crud"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "crud"
				}
				ports: [{
					name:       "http"
					port:       3000
					targetPort: 3000
					protocol:   "TCP"
				}]
			}
		},

	]

	let prontoElectricDeploymentObj = [
		if release.type == "pronto" {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-electric"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "electric"}
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "electric"
				}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": "electric"}
						annotations: (#daprSidecar & {id: "electric", port: "3000"}).out
					}
					spec: containers: [{
						name:            "electric"
						image:           (#appImage & {svc: "electric"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: 3000}]
						env: [
							{name: "ELECTRIC_PORT", value: "3000"},
							{
								name: "ELECTRIC_PASSWORD"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-electric-db"
									key:  "password"
								}
							},
							{
								name:  "DATABASE_URL"
								value: "postgresql://electric:$(ELECTRIC_PASSWORD)@database:5432/\(release.name)?sslmode=disable"
							},
							{
								name: "ELECTRIC_SECRET"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-auth-secrets"
									key:  "ELECTRIC_SECRET"
								}
							},
							{name: "ELECTRIC_MANUAL_TABLE_PUBLISHING", value: "true"},
						]
						resources: release.resources
						livenessProbe: {
							httpGet: {
								path: "/v1/health"
								port: 3000
							}
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						readinessProbe: {
							httpGet: {
								path: "/v1/health"
								port: 3000
							}
							initialDelaySeconds: 5
							periodSeconds:       5
						}
					}]
				}
			}
		},
	]

	let prontoElectricServiceObj = [
		if release.type == "pronto" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "electric"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "electric"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "electric"
				}
				ports: [{
					name:       "http"
					port:       3000
					targetPort: 3000
					protocol:   "TCP"
				}]
			}
		},

	]

	let prontoAuthDeploymentObj = [
		if release.type == "pronto" {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-auth"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "auth"}
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "auth"
				}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": "auth"}
						annotations: (#daprSidecar & {id: "auth", port: "9999"}).out
						if release.auth.oidcSecretDigest != "" {
							annotations: "pronto.dev/oidc-secret-digest": release.auth.oidcSecretDigest
						}
					}
					spec: containers: [{
						name:            "auth"
						image:           (#appImage & {svc: "auth"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: 9999}]
						env: [
							for e in (#denoTelemetry & {service: "auth"}).env {e},
							{
								name: "PG_PASSWORD"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-db-postgres"
									key:  "password"
								}
							},
							{
								name:  "DATABASE_URL"
								value: "postgres://postgres:$(PG_PASSWORD)@database:5432/\(release.name)"
							},
							{name: "AUTH_STATEMENT_TIMEOUT_MS", value: "\(bounds.statement.client*1000)"},
							{
								name: "PGRST_JWT_SECRET"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-auth-secrets"
									key:  "PGRST_JWT_SECRET"
								}
							},
							{name: "WEBAUTHN_RP_ID", value: authRpId},
							{name: "WEBAUTHN_ORIGIN", value: authOrigin},
							for k, v in release.auth.oidc {{name: k, value: v}},
								for k in release.auth.oidcSecrets {{
									name: k
									valueFrom: secretKeyRef: {
										name: "\(release.name)-oidc"
										key: k
									}
								}},
						]
						resources: release.resources
						livenessProbe: {
							tcpSocket: port: 9999
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						readinessProbe: {
							tcpSocket: port: 9999
							initialDelaySeconds: 5
							periodSeconds:       5
						}
					}]
				}
			}
		},
	]

	let prontoAuthServiceObj = [
		if release.type == "pronto" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "auth"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "auth"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "auth"
				}
				ports: [{
					name:       "http"
					port:       9999
					targetPort: 9999
					protocol:   "TCP"
				}]
			}
		},

	]

	let prontoCaddyDeploymentObj = [
		if release.type == "pronto" {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-caddy"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "caddy"}
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "caddy"
				}
				template: {
					metadata: {
						labels: appLabels & {"app.kubernetes.io/component": "caddy"}
						annotations: (#daprSidecar & {id: "caddy", port: "8080"}).out
					}
					spec: containers: [{
						name:            "caddy"
						image:           (#appImage & {svc: "caddy"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: 8080}]
						env: [
							if release.env["ORIGIN"] == _|_ {
								name:  "ORIGIN"
								value: originValue
							},
							for up in ["CRUD", "AUTH", "ELECTRIC", "TICKER", "RCLONE_S3", "IMGPROXY", "RENDER"] {name: "PRONTO_UPSTREAM_\(up)", value: "localhost:3500"},
							{name: "PRONTO_TRACING", value: "on"},
							for e in (#otelExport & {service: "caddy", port: 4317}).env {e},
							{
								name: "ELECTRIC_SECRET"
								valueFrom: secretKeyRef: {
									name: "\(release.name)-auth-secrets"
									key:  "ELECTRIC_SECRET"
								}
							},
							for k, v in release.env {
								name:  k
								value: v
							},
						]
						resources: release.resources
						livenessProbe: {
							httpGet: {
								path: "/health"
								port: 8080
							}
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						readinessProbe: {
							httpGet: {
								path: "/health"
								port: 8080
							}
							initialDelaySeconds: 5
							periodSeconds:       5
						}
					}]
				}
			}
		},
	]

	let prontoCaddyServiceObj = [
		if release.type == "pronto" {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "caddy"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "caddy"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "caddy"
				}
				ports: [{
					name:       "http"
					port:       8080
					targetPort: 8080
					protocol:   "TCP"
				}]
			}
		},


	]

	let prontoRenderDeploymentObj = [
		if release.type == "pronto" && release.render.enabled {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-render"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "render"}
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "render"
				}
				template: {
					metadata: {
						labels:      appLabels & {"app.kubernetes.io/component": "render"}
						annotations: (#daprSidecar & {id: "render", port: "\(release.render.port)"}).out
					}
					spec: containers: [{
						name:            "render"
						image:           (#appImage & {svc: "render"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: release.render.port}]
						env: [
							{name: "DOOR", value: "http://localhost:3500/v1.0/invoke/caddy/method"},
							{name: "DOOR_TIMEOUT_MS", value: "\(bounds.renderDoor*1000)"},
							{name: "ENTRY", value: "/render/entry.html"},
							{name: "ORIGIN", value: originValue},
							{name: "PORT", value: "\(release.render.port)"},
							for e in (#denoTelemetry & {service: "render"}).env {e},
						]
						resources: release.resources
						livenessProbe: {
							httpGet: {
								path: "/health"
								port: release.render.port
							}
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						readinessProbe: {
							httpGet: {
								path: "/health"
								port: release.render.port
							}
							initialDelaySeconds: 2
							periodSeconds:       5
						}
					}]
				}
			}
		},
	]

	let prontoRenderServiceObj = [
		if release.type == "pronto" && release.render.enabled {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      "render"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "render"}
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "render"
				}
				ports: [{name: "http", port: release.render.port, targetPort: release.render.port, protocol: "TCP"}]
			}
		},

	]

	let gatewayObj = [
		if release.gateway.enabled {
			apiVersion: "gateway.networking.k8s.io/v1"
			kind:       "Gateway"
			metadata: {
				name:      "\(release.name)-gateway"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				gatewayClassName: targetEnv.gatewayClassName
				listeners: [
					{
						name:     "http"
						protocol: "HTTP"
						port:     80
						hostname: gatewayHostname
						allowedRoutes: namespaces: from: "Same"
					},
					if release.gateway.tls.enabled {
						{
							name:     "https"
							protocol: "HTTPS"
							port:     443
							hostname: gatewayHostname
							tls: {
								mode: "Terminate"
								certificateRefs: [{
									name: [
										if release.gateway.tls.secretName != _|_ {release.gateway.tls.secretName},
										"\(release.name)-tls",
									][0]
								}]
							}
							allowedRoutes: namespaces: from: "Same"
						}
					},
				]
			}
		},
	]

	let httpRouteObj = [
		if release.gateway.enabled {
			apiVersion: "gateway.networking.k8s.io/v1"
			kind:       "HTTPRoute"
			metadata: {
				name:      "\(release.name)-route"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				parentRefs: [{
					name: "\(release.name)-gateway"
				}]
				hostnames: [gatewayHostname]
				// Envoy's own default is 15s, under Electric's 20s live hold.
				rules: [for prefix, s in {"/": bounds.gateway.default, "/electric/": bounds.gateway.electric} {
					matches: [{path: {type: "PathPrefix", value: prefix}}]
					timeouts: request: "\(s)s"
					backendRefs: [{name: "caddy", port: 8080}]
				}]
			}
		},
	]

	// The gateway's breaker is Envoy's concurrency limits on caddy's pool.
	let backendTrafficPolicyObj = [
		if release.gateway.enabled {
			apiVersion: "gateway.envoyproxy.io/v1alpha1"
			kind:       "BackendTrafficPolicy"
			metadata: {
				name:      "\(release.name)-backend"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				targetRefs: [{group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "\(release.name)-route"}]
				timeout: tcp: connectTimeout: "\(bounds.dial)s"
				circuitBreaker: resilience.resilience.gateway
			}
		},
	]

	let caddyNetworkPolicyObj = [
		if release.networkPolicy.enabled {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {
				name:      "\(release.name)-caddy-netpol"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "caddy"}
			}
			spec: {
				podSelector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "caddy"
				}
				policyTypes: ["Ingress", "Egress"]
				ingress: [
					{
						ports: [{port: 8080, protocol: "TCP"}]
					},
					{
						from: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "observability"
							}
						}]
						ports: [{port: 9090, protocol: "TCP"}]
					},
					{
						from: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name": release.name
							}
						}]
						ports: [
							{port: 50002, protocol: "TCP"},
							{port: 3500, protocol: "TCP"},
						]
					},
				]
				egress: [
					{
						ports: [
							{port: 53, protocol: "UDP"},
							{port: 53, protocol: "TCP"},
						]
					},
					{
						to: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name": release.name
							}
						}]
						ports: [
							{port: 3000, protocol: "TCP"},
							{port: 9999, protocol: "TCP"},
							if release.render.enabled {{port: release.render.port, protocol: "TCP"}},
							{port: 50002, protocol: "TCP"},
							{port: 3500, protocol: "TCP"},
						]
					},
					{
						to: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "observability"
							}
						}]
						ports: [
							{port: 4317, protocol: "TCP"},
							{port: 4318, protocol: "TCP"},
							{port: 9411, protocol: "TCP"},
						]
					},
					{
						to: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "dapr-system"
							}
						}]
						ports: [
							{port: 4000, protocol: "TCP"},
							{port: 50001, protocol: "TCP"},
							{port: 50005, protocol: "TCP"},
							{port: 50006, protocol: "TCP"},
							{port: 6500, protocol: "TCP"},
						]
					},
				]
			}
		},
	]

	let backendsNetworkPolicyObj = [
		if release.networkPolicy.enabled {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {
				name:      "\(release.name)-backends-netpol"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				podSelector: matchExpressions: [{
					key:      "app.kubernetes.io/component"
					operator: "In"
					values: [
						"crud",
						"auth",
						"electric",
						if release.render.enabled {"render"},
					]
				}]
				policyTypes: ["Ingress", "Egress"]
				ingress: [
					{
						from: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name":      release.name
								"app.kubernetes.io/component": "caddy"
							}
						}]
						ports: [
							{port: 3000, protocol: "TCP"},
							{port: 9999, protocol: "TCP"},
							if release.render.enabled {{port: release.render.port, protocol: "TCP"}},
						]
					},
					{
						ports: [{port: 3001, protocol: "TCP"}]
					},
					{
						from: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "observability"
							}
						}]
						ports: [{port: 9090, protocol: "TCP"}]
					},
					{
						from: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name": release.name
							}
						}]
						ports: [
							{port: 50002, protocol: "TCP"},
							{port: 3500, protocol: "TCP"},
						]
					},
				]
				egress: [
					{
						ports: [
							{port: 53, protocol: "UDP"},
							{port: 53, protocol: "TCP"},
						]
					},
					{
						to: [{
							podSelector: matchLabels: {
								"cnpg.io/cluster": "\(release.name)-db"
							}
						}]
						ports: [{port: 5432, protocol: "TCP"}]
					},
					if release.render.enabled {
						{
							to: [{
								podSelector: matchLabels: {
									"app.kubernetes.io/name":      release.name
									"app.kubernetes.io/component": "caddy"
								}
							}]
							ports: [{port: 8080, protocol: "TCP"}]
						}
					},
					{
						to: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name": release.name
							}
						}]
						ports: [
							{port: 50002, protocol: "TCP"},
							{port: 3500, protocol: "TCP"},
						]
					},
					{
						to: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "observability"
							}
						}]
						ports: [
							{port: 4317, protocol: "TCP"},
							{port: 4318, protocol: "TCP"},
							{port: 9411, protocol: "TCP"},
						]
					},
					{
						to: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "dapr-system"
							}
						}]
						ports: [
							{port: 4000, protocol: "TCP"},
							{port: 50001, protocol: "TCP"},
							{port: 50005, protocol: "TCP"},
							{port: 50006, protocol: "TCP"},
							{port: 6500, protocol: "TCP"},
						]
					},
				]
			}
		},
	]

	let databaseNetworkPolicyObj = [
		if release.networkPolicy.enabled {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {
				name:      "\(release.name)-database-netpol"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			spec: {
				podSelector: matchLabels: {
					"cnpg.io/cluster": "\(release.name)-db"
				}
				policyTypes: ["Ingress", "Egress"]
				ingress: [
					{
						from: [{
							podSelector: matchLabels: {
								"app.kubernetes.io/name": release.name
							}
						}]
						ports: [{port: 5432, protocol: "TCP"}]
					},
					{
						from: [{
							podSelector: matchLabels: {
								"cnpg.io/cluster": "\(release.name)-db"
							}
						}]
						ports: [
							{port: 5432, protocol: "TCP"},
							{port: 8000, protocol: "TCP"},
						]
					},
					{
						from: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "observability"
							}
						}]
						ports: [{port: 9187, protocol: "TCP"}]
					},
					{
						from: [{
							namespaceSelector: matchLabels: {
								"kubernetes.io/metadata.name": "cnpg-system"
							}
						}]
						ports: [
							{port: 5432, protocol: "TCP"},
							{port: 8000, protocol: "TCP"},
						]
					},
				]
				egress: [
					{
						ports: [
							{port: 53, protocol: "UDP"},
							{port: 53, protocol: "TCP"},
						]
					},
					// CloudNativePG's instance manager runs in the postgres pod and
					// watches its Cluster and secrets through the API server.
					{
						ports: [
							{port: 443, protocol: "TCP"},
							{port: 6443, protocol: "TCP"},
						]
					},
					{
						to: [{
							podSelector: matchLabels: {
								"cnpg.io/cluster": "\(release.name)-db"
							}
						}]
						ports: [
							{port: 5432, protocol: "TCP"},
							{port: 8000, protocol: "TCP"},
						]
					},
				]
			}
		},
	]

	// objects collects all generated Kubernetes API definitions in standard order
	objects: [
		for list in [
			namespaceObj,
			prontoSecretGeneratorObj,
			prontoExternalSecretObj,
			daprConfigObj,
			daprResiliencyObj,
			prontoClusterObj,
			schemaJobObj,
			prontoDatabaseServiceObj,
			prontoCrudDeploymentObj,
			prontoCrudServiceObj,
			prontoElectricDeploymentObj,
			prontoElectricServiceObj,
			prontoAuthDeploymentObj,
			prontoAuthServiceObj,
			prontoCaddyDeploymentObj,
			prontoCaddyServiceObj,
			prontoRenderDeploymentObj,
			prontoRenderServiceObj,
			gatewayObj,
			httpRouteObj,
			backendTrafficPolicyObj,
			caddyNetworkPolicyObj,
			backendsNetworkPolicyObj,
			databaseNetworkPolicyObj,
		]
		for item in list {item},
	]

	// manifests encodes the objects as a multi-document YAML stream
	manifests: yaml.MarshalStream(objects)
}
