package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/yaml"
	"list"
	"strings"

	"github.com/bonisoft3/pronto/resilience"
)

// #BuildManifests maps a ReleaseSpec and Environment into standard Kubernetes manifests.
// A container's requests and limits: the release's own, under what its containerResources names
// for that container (crud, electric, auth, caddy, render, or one of the app's services).
#resourcesOf: {
	r:   _
	n:   string
	out: r.resources
	if r.containerResources[n] != _|_ {out: r.containerResources[n]}
}

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
			// few seconds after its successor is ready: its own sidecar keeps
			// answering through its container's preStop pause rather than
			// leaving those calls to fail (each a 500 at the door).
			"dapr.io/block-shutdown-duration": "20s"
		}
	}

	// What a pod signs in to Google Cloud with, no key held: an external_account credential that
	// reads the pod's projected token (audience = the provider's), trades it at STS for the
	// workload identity `provider`'s, and impersonates `serviceAccount`. GOOGLE_APPLICATION_CREDENTIALS
	// names the file this is written to; the metrics export and the blob plane share it.
	#workloadCredentials: {
		provider:       string
		serviceAccount: string
		tokenFile:      string | *"/var/run/secrets/gcp/token"
		out: {
			type:                              "external_account"
			audience:                          "//iam.googleapis.com/\(provider)"
			subject_token_type:                "urn:ietf:params:oauth:token-type:jwt"
			token_url:                         "https://sts.googleapis.com/v1/token"
			credential_source: file:           tokenFile
			service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/\(serviceAccount):generateAccessToken"
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
				// upstream's parameters for the services an app's compose runs beside the cluster
				// (feldera, conduit: logical slots); an app without them keeps the parameters its
				// live database runs with, as a change to them restarts it.
				if len(release.runtime) > 0 {
					postgresql: parameters: {
						wal_level:             "logical"
						max_replication_slots: "128"
						max_wal_senders:       "128"
						max_connections:       "200"
						fsync:                 "on"
						synchronous_commit:    "on"
						full_page_writes:      "on"
					}
				}
				// A stop is bounded: a smart shutdown waits for sessions for 15 s, then a fast one, and
				// at 120 s the pod is killed. CloudNativePG's default waits 1800 s, and Electric's
				// walsender holds a fast shutdown open, so every restart of the primary stalled a
				// release for half an hour. Killed, the next start replays the WAL it wrote. The
				// release waits for the primary (release.nu) longer than this stop.
				smartShutdownTimeout: 15
				stopDelay:            120
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
				if release.database.backup.provider != _|_ {
					// The backups' sign-in (backupObjs): the plugin's sidecar shares the postgres
					// container's mounts, /projected among them.
					projectedVolumeTemplate: sources: [{
						serviceAccountToken: {path: "gcp-token", audience: release.database.backup.audience, expirationSeconds: 3600}
					}, {
						configMap: {name: "\(release.name)-backup", items: [{key: "credentials.json", path: "gcp-credentials.json"}]}
					}]
				}
				if release.database.backup != _|_ {
					plugins: [{
						name:          "barman-cloud.cloudnative-pg.io"
						isWALArchiver: true
						parameters: barmanObjectName: "\(release.name)-backup"
					}]
				}
			}
		},
	]

	// release.database.backup: the bucket the barman-cloud plugin writes to, and the nightly
	// base backup; WAL goes there as the Cluster's archiver (prontoClusterObj's plugins). To an
	// S3 store with the keys Secret the release checks; to Cloud Storage with the credential the
	// ConfigMap holds (no key: #workloadCredentials over the Cluster's projected token), named by
	// GOOGLE_APPLICATION_CREDENTIALS, which gkeEnvironment has barman-cloud take as Google's default.
	let backupObjs = [
		if release.type == "pronto" && release.database.backup.provider != _|_
		let b = release.database.backup {
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata: {
				name:      "\(release.name)-backup"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			data: "credentials.json": json.Marshal((#workloadCredentials & {provider: b.provider, serviceAccount: b.serviceAccount, tokenFile: "/projected/gcp-token"}).out)
		},
		if release.type == "pronto" && release.database.backup != _|_
		let b = release.database.backup {
			apiVersion: "barmancloud.cnpg.io/v1"
			kind:       "ObjectStore"
			metadata: {
				name:      "\(release.name)-backup"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			spec: {
				retentionPolicy: b.retention
				if b.provider != _|_ && b.endpoint == _|_ {
					configuration: {
						destinationPath: "gs://\(b.bucket)/\(b.path)"
						googleCredentials: gkeEnvironment: true
					}
					instanceSidecarConfiguration: env: [{name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/projected/gcp-credentials.json"}]
				}
				if b.endpoint != _|_ && b.provider == _|_ {
					configuration: {
						destinationPath: "s3://\(b.bucket)/\(b.path)"
						endpointURL:     b.endpoint
						s3Credentials: {
							accessKeyId: {name: b.secret, key: "ACCESS_KEY_ID"}
							secretAccessKey: {name: b.secret, key: "ACCESS_SECRET_KEY"}
						}
					}
				}
				// One store or the other: with both or neither named there is no destination.
				configuration: {
					destinationPath!: string
					wal: compression:  "gzip"
					data: compression: "gzip"
				}
			}
		},
		if release.type == "pronto" && release.database.backup != _|_ {
			apiVersion: "postgresql.cnpg.io/v1"
			kind:       "ScheduledBackup"
			metadata: {
				name:      "\(release.name)-db-nightly"
				namespace: release.namespace
				labels:    appLabels & {"app.kubernetes.io/component": "database"}
			}
			spec: {
				schedule:             release.database.backup.schedule
				immediate:            true
				backupOwnerReference: "self"
				cluster: name: "\(release.name)-db"
				method: "plugin"
				pluginConfiguration: name: "barman-cloud.cloudnative-pg.io"
			}
		},
	]

	// The schema, built as compose builds it, by the app's own images: initdb
	// runs the database image's initdb directory once, on a fresh database, and
	// migrate applies pending pgroll migrations and reconciles permissions on
	// every release. The image's docker_process_sql pins the local socket,
	// so the Job restates it against
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
						// A cluster that enforces NetworkPolicy (k3s's kube-router; Kind
						// enforces none) admits a new pod's address a moment after it
						// starts, and refuses it until then: the Job's one attempt once
						// failed there. It begins once the database answers it.
						initContainers: [{
							name:            "database-ready"
							image:           (#appImage & {"svc": "database"}).out
							imagePullPolicy: targetEnv.imagePullPolicy
							command: ["bash", "-c", "for _ in $(seq 120); do pg_isready -q && exit 0; sleep 1; done; echo \"$PGHOST:$PGPORT does not answer\" >&2; exit 1"]
							"env": schemaEnv
						}]
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
					shopt -s extglob
					# pgroll records any DDL run outside it as an "inferred" migration, a link
					# in the chain its previous_migration walks; every release replaying these
					# steps added hundreds, and at 8,353 that walk ran past the job's timeout
					# (Bonk Chess, 2026-10-29). These steps are no migrations: psql tells it so, in
					# the one spelling pgroll's trigger takes (= 'TRUE': `true` recorded 6,149 more).
					export PGOPTIONS="-c pgroll.no_inferred_migrations=TRUE"
					marker=$(psql -XtAc "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()")
					if [ "$marker" = "pronto initdb" ]; then
					  echo "initdb: already built"
					  # Its re-runnable steps are the release's, though (emit.cue's), as on Cloud Run
					  # (gcp.cue's): a new entity's table and a new field's column, every policy,
					  # trigger and publication, the status charts' triggers (010_machines), the
					  # mecha machines' code (found by its suffix, wherever the program places it), and the app's own migrations (database.replays), each
					  # idempotent, run again, keeping every row, before migrate's pgroll steps call
					  # what they define. Live traffic can deadlock a step's ALTER: being idempotent,
					  # the step is run again, up to three times.
					  for step in 005_create_tables.sql 006_policies.sql 007_txid.sql 008_publication.sql 010_machines.sql $(cd /docker-entrypoint-initdb.d && ls [0-7][0-9][0-9]_mecha_actors.sql 2>/dev/null) \(strings.Join(release.database.replays, " ")); do
					    f=/docker-entrypoint-initdb.d/$step
					    if [ -f "$f" ]; then echo "initdb: replaying $step"
					      for try in 1 2 3; do
					        # 010 drops and recreates triggers and constraints: one transaction, so no
					        # write slips between them and a failure leaves the old ones in force.
					        if [ "$step" = 010_machines.sql ]; then one=--single-transaction; else one=; fi
					        if psql -v ON_ERROR_STOP=1 -Xq $one -f "$f"; then break; fi
					        if [ "$try" = 3 ]; then exit 1; fi
					        echo "initdb: $step failed, again in 10s"; sleep 10
					      done
					    fi
					  done
					  exit 0
					fi
					source /usr/local/bin/docker-entrypoint.sh
					docker_process_sql() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password --no-psqlrc --dbname "$POSTGRES_DB" "$@"; }
					# A test's rows (#App.state.fixture) are never a release's.
					docker_process_init_files /docker-entrypoint-initdb.d/!(950_fixture.sql)
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

	// No sidecar bounds a call between the cluster's own apps: a Dapr timeout that fires while
	// a response is still being copied returns its handler and leaves the copy running, whose
	// next write lands on a recycled buffer and panics the sidecar (dapr/dapr#10371, open in every
	// release through 1.18). Bonk Chess's door sidecar died that way under its scenarios
	// (2026-11-06), and every upstream with it, so the door answered 500. Each hop stays bounded
	// outside the mesh: the gateway's request bound, caddy's per-upstream bound (the door's), render's
	// own on each read (renderDoor), Postgres's statement bounds, and Electric's hold. The budget's
	// mesh numbers still nest those (resilience.cue) for compose and Cloud Run. The Resiliency is
	// still written, empty, so a release replaces a cluster's earlier one. No circuit breaker either:
	// Dapr counts any answer outside 200-399 as a failure, so a client's 401s, a shape's 409s or a
	// missing row's 404s would open a target's circuit for everyone. No retry: a write is not replayed.
	let daprResiliencyObj = [if release.type == "pronto" {
		apiVersion: "dapr.io/v1alpha1"
		kind:       "Resiliency"
		metadata: {
			name:      "\(release.name)-resiliency"
			namespace: release.namespace
			labels:    appLabels
		}
		spec: {
			policies: {}
			targets: {}
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
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            "crud"
						image:           (#appImage & {svc: "crud"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
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
						resources: (#resourcesOf & {r: release, n: "crud"}).out
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
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            "electric"
						image:           (#appImage & {svc: "electric"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
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
						resources: (#resourcesOf & {r: release, n: "electric"}).out
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
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            "auth"
						image:           (#appImage & {svc: "auth"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
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
							if release.auth.android != "" {{name: "WEBAUTHN_ANDROID_ORIGINS", value: release.auth.android}},
							for k, v in release.auth.oidc {{name: k, value: v}},
								for k in release.auth.oidcSecrets {{
									name: k
									valueFrom: secretKeyRef: {
										name: "\(release.name)-oidc"
										key: k
									}
								}},
						]
						resources: (#resourcesOf & {r: release, n: "auth"}).out
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
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            "caddy"
						image:           (#appImage & {svc: "caddy"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: 8080}]
						env: [
							if release.env["ORIGIN"] == _|_ {
								name:  "ORIGIN"
								value: originValue
							},
							for up in ["CRUD", "AUTH", "ELECTRIC", "TICKER", "RCLONE_S3", "IMGPROXY", "RENDER"] {name: "PRONTO_UPSTREAM_\(up)", value: "localhost:3500"},
							for n in list.Concat([[for n, _ in release.services {n}], release.doors]) {name: "PRONTO_UPSTREAM_\(strings.ToUpper(strings.Replace(n, "-", "_", -1)))", value: "localhost:3500"},
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
						resources: (#resourcesOf & {r: release, n: "caddy"}).out
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
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            "render"
						image:           (#appImage & {svc: "render"}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
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
						resources: (#resourcesOf & {r: release, n: "render"}).out
						// render answers /health once every table has synced, which takes
						// longer than liveness alone waits (5 s, then 3 misses 10 s apart:
						// a pod still syncing was killed after about 35 s, PRONTO-107). Up to
						// 150 s to start, compose's start_period with room; liveness and
						// readiness begin once it has answered.
						startupProbe: {httpGet: {path: "/health", port: release.render.port}, periodSeconds: 2, failureThreshold: 75}
						livenessProbe: {
							httpGet: {
								path: "/health"
								port: release.render.port
							}
							initialDelaySeconds: 5
							periodSeconds:       10
						}
						// Ready only once it renders: its own /health, and the door it
						// reads every page from (DOOR, caddy through the sidecar)
						// answering. A rollout keeps the old pod serving until then,
						// where /health alone let it go while caddy was still starting
						// and every page answered 500. Liveness stays its own /health,
						// so a slow door never restarts it.
						readinessProbe: {
							exec: command: ["deno", "eval", "for (const u of [`http://localhost:${Deno.env.get('PORT')}/health`, `${Deno.env.get('DOOR')}/shell/shell.json`]) { const r = await fetch(u); await r.body?.cancel(); if (!r.ok) Deno.exit(1) }"]
							initialDelaySeconds: 2
							periodSeconds:       5
							timeoutSeconds:      5
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

	// The app's alerting (release.alerting): its rules, which the release writes to <name>-alert-rules,
	// evaluated by a vmalert of its own against the cluster's VictoriaMetrics (observability's vmsingle),
	// its alerts' state written back there, reloading a changed rule file within a minute.
	let vmalertObjs = [if len(release.alerting.rules) > 0 {
		let labels = appLabels & {"app.kubernetes.io/component": "vmalert"}
		let vm = "http://vmsingle.observability.svc.cluster.local:8428"
		{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-vmalert"
				namespace: release.namespace
				"labels":  labels
			}
			spec: {
				replicas: 1
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "vmalert"
				}
				template: {
					metadata: "labels": labels
					spec: enableServiceLinks: false
					spec: containers: [{
						name:  "vmalert"
						image: "docker.io/victoriametrics/vmalert:v1.106.1@sha256:b546a4fbd2d382419dcf521caba096a1f09b15c9338c8f89fb009e5b8d0cfbce"
						args: [
							"-rule=/etc/vmalert/rules/*.yaml",
							"-rule=/etc/vmalert/rules/*.yml",
							"-datasource.url=\(vm)",
							"-remoteWrite.url=\(vm)",
							"-remoteRead.url=\(vm)",
							"-configCheckInterval=1m",
							"-external.label=app=\(release.name)",
							if release.alerting.notifier != _|_ {"-notifier.url=\(release.alerting.notifier)"},
							if release.alerting.notifier == _|_ {"-notifier.blackhole"},
						]
						ports: [{name: "http", containerPort: 8880}]
						readinessProbe: httpGet: {path: "/ready", port: 8880}
						resources: (#resourcesOf & {r: release, n: "vmalert"}).out
						volumeMounts: [{name: "rules", mountPath: "/etc/vmalert/rules", readOnly: true}]
					}]
					spec: volumes: [{name: "rules", configMap: name: "\(release.name)-alert-rules"}]
				}
			}
		}
	}]

	// release.metricsExport: an OpenTelemetry collector scraping each service's metrics port through
	// its Service and writing to Managed Service for Prometheus, signed in through workload identity.
	let metricsExportObjs = [if release.metricsExport != _|_ {
		let x = release.metricsExport
		let exportName = "\(release.name)-metrics-export"
		let labels = appLabels & {"app.kubernetes.io/component": "metrics-export"}
		let config = {
			receivers: prometheus: config: scrape_configs: [for sn, s in release.services if s.metrics != _|_ {
				job_name:        sn
				scrape_interval: x.interval
				metrics_path:    s.metrics.path
				static_configs: [{targets: ["\(sn).\(release.namespace).svc.cluster.local:\(s.metrics.port)"]}]
			}]
			processors: {
				resource: attributes: [
					{key: "cloud.region", value: x.location, action: "upsert"},
					{key: "k8s.cluster.name", value: x.cluster, action: "upsert"},
					{key: "k8s.namespace.name", value: release.namespace, action: "upsert"},
				]
				batch: {}
			}
			exporters: googlemanagedprometheus: project: x.project
			service: pipelines: metrics: {
				receivers: ["prometheus"]
				processors: ["resource", "batch"]
				exporters: ["googlemanagedprometheus"]
			}
		}
		let credentials = (#workloadCredentials & {provider: x.provider, serviceAccount: x.serviceAccount}).out
		[{
			apiVersion: "v1"
			kind:       "ServiceAccount"
			metadata: {name: exportName, namespace: release.namespace, "labels": labels}
		}, {
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata: {name: exportName, namespace: release.namespace, "labels": labels}
			data: {
				"config.yaml":      yaml.Marshal(config)
				"credentials.json": json.Marshal(credentials)
			}
		}, {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {name: exportName, namespace: release.namespace, "labels": labels}
			spec: {
				replicas: 1
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "metrics-export"
				}
				template: {
					metadata: "labels": labels
					// A changed config rolls the collector.
					metadata: annotations: "pronto.dev/config": hex.Encode(sha256.Sum256(yaml.Marshal(config) + json.Marshal(credentials)))
					spec: {
						serviceAccountName: exportName
						enableServiceLinks: false
						containers: [{
							name:  "otelcol"
							image: "docker.io/otel/opentelemetry-collector-contrib:0.160.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6"
							args: ["--config=/etc/otelcol/config.yaml"]
							env: [{name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/etc/otelcol/credentials.json"}]
							resources: (#resourcesOf & {r: release, n: "metrics-export"}).out
							volumeMounts: [
								{name: "config", mountPath: "/etc/otelcol", readOnly: true},
								{name: "token", mountPath: "/var/run/secrets/gcp", readOnly: true},
							]
						}]
						volumes: [
							{name: "config", configMap: name: exportName},
							{name: "token", projected: sources: [{serviceAccountToken: {path: "token", audience: x.audience, expirationSeconds: 3600}}]},
						]
					}
				}
			}
		}]
	}]

	// release.blobs: mecha's blob plane over a Cloud Storage bucket, as gcp.cue's rclone-s3 and
	// imgproxy sidecars are. rclone serves the bucket as the S3 bucket every app names (mecha-objects),
	// signed in through workload identity (no key); imgproxy reads it over the cluster network (the
	// services' network policy admits the app's pods on these ports) rather than through the mesh,
	// whose invoke path would be part of what the S3 client signs. Both are in the mesh as
	// app-ids rclone-s3 and imgproxy, where the door's PRONTO_UPSTREAM_RCLONE_S3 and _IMGPROXY reach them.
	let blobsPorts = {rcloneS3: 3900, imgproxy: 8081}
	let blobsObjs = [if release.blobs != _|_ {
		let x = release.blobs
		let blobsName = "\(release.name)-blobs"
		let credentials = (#workloadCredentials & {provider: x.provider, serviceAccount: x.serviceAccount}).out
		let rcloneLabels = appLabels & {"app.kubernetes.io/component": "rclone-s3"}
		let imgproxyLabels = appLabels & {"app.kubernetes.io/component": "imgproxy"}
		let rcloneURL = "http://rclone-s3.\(release.namespace).svc.cluster.local:\(blobsPorts.rcloneS3)"
		[{
			apiVersion: "v1"
			kind:       "ServiceAccount"
			metadata: {name: blobsName, namespace: release.namespace, labels: rcloneLabels}
		}, {
			apiVersion: "v1"
			kind:       "ConfigMap"
			metadata: {name: blobsName, namespace: release.namespace, labels: rcloneLabels}
			data: "credentials.json": json.Marshal(credentials)
		}, {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {name: "\(release.name)-rclone-s3", namespace: release.namespace, labels: rcloneLabels}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "rclone-s3"
				}
				template: {
					metadata: {
						labels:      rcloneLabels
						annotations: (#daprSidecar & {id: "rclone-s3", port: "\(blobsPorts.rcloneS3)"}).out
						// A changed credential rolls the pods.
						annotations: "pronto.dev/config": hex.Encode(sha256.Sum256(json.Marshal(credentials)))
					}
					spec: {
						serviceAccountName: blobsName
						enableServiceLinks: false
						containers: [{
							name:            "rclone-s3"
							image:           (#appImage & {svc: "rclone-s3"}).out
							imagePullPolicy: targetEnv.imagePullPolicy
							command: ["rclone"]
							args: ["serve", "s3", "--addr=0.0.0.0:\(blobsPorts.rcloneS3)", "--vfs-cache-mode=off", "objects:"]
							lifecycle: preStop: sleep: seconds: 15
							ports: [{name: "http", containerPort: blobsPorts.rcloneS3}]
							// mecha's blob plane over the bucket: a combine remote names its root
							// mecha-objects, and the pod's service account reaches it with no key.
							env: [
								{name: "RCLONE_CONFIG_OBJECTS_TYPE", value: "combine"},
								{name: "RCLONE_CONFIG_OBJECTS_UPSTREAMS", value: "mecha-objects=gcs:\(x.bucket)"},
								{name: "RCLONE_CONFIG_GCS_TYPE", value: "google cloud storage"},
								{name: "RCLONE_CONFIG_GCS_ENV_AUTH", value: "true"},
								{name: "RCLONE_CONFIG_GCS_BUCKET_POLICY_ONLY", value: "true"},
								{name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/etc/gcp/credentials.json"},
							]
							startupProbe: {tcpSocket: port: blobsPorts.rcloneS3, periodSeconds: 2, failureThreshold: 60}
							resources: (#resourcesOf & {r: release, n: "rclone-s3"}).out
							volumeMounts: [
								{name: "credentials", mountPath: "/etc/gcp", readOnly: true},
								{name: "token", mountPath: "/var/run/secrets/gcp", readOnly: true},
							]
						}]
						volumes: [
							{name: "credentials", configMap: name: blobsName},
							{name: "token", projected: sources: [{serviceAccountToken: {path: "token", audience: x.audience, expirationSeconds: 3600}}]},
						]
					}
				}
			}
		}, {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {name: "rclone-s3", namespace: release.namespace, labels: rcloneLabels}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "rclone-s3"
				}
				ports: [{name: "http", port: blobsPorts.rcloneS3, targetPort: blobsPorts.rcloneS3, protocol: "TCP"}]
			}
		}, {
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {name: "\(release.name)-imgproxy", namespace: release.namespace, labels: imgproxyLabels}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "imgproxy"
				}
				template: {
					metadata: {
						labels:      imgproxyLabels
						annotations: (#daprSidecar & {id: "imgproxy", port: "\(blobsPorts.imgproxy)"}).out
					}
					spec: {
						enableServiceLinks: false
						containers: [{
							name:            "imgproxy"
							image:           (#appImage & {svc: "imgproxy"}).out
							imagePullPolicy: targetEnv.imagePullPolicy
							lifecycle: preStop: sleep: seconds: 15
							ports: [{name: "http", containerPort: blobsPorts.imgproxy}]
							// As gcp.cue's imgproxy (and the app's compose): mecha's presets alone, no key signs a URL.
							env: [
								{name: "IMGPROXY_USE_S3", value: "true"},
								{name: "IMGPROXY_S3_ENDPOINT", value: rcloneURL},
								// The store takes any key pair; imgproxy's S3 client insists on one.
								{name: "AWS_ACCESS_KEY_ID", value: "GK000000000000000000000000"},
								{name: "AWS_SECRET_ACCESS_KEY", value: "0000000000000000000000000000000000000000000000000000000000000000"},
								{name: "AWS_REGION", value: "rclone"},
								{name: "IMGPROXY_BIND", value: ":\(blobsPorts.imgproxy)"},
								{name: "IMGPROXY_MAX_SRC_RESOLUTION", value: "50"},
								// The store and Google's photo host, as mecha's #ImgproxySources.
								{name: "IMGPROXY_ALLOWED_SOURCES", value: "s3://mecha-objects/,https://lh3.googleusercontent.com/"},
								{name: "IMGPROXY_ONLY_PRESETS", value: "true"},
								{name: "IMGPROXY_PRESETS", value: "thumb=rs:fill:128:128/f:webp,avatar=rs:fill:256:256/f:webp,picture=rs:fit:1024:1024/f:webp"},
								{name: "IMGPROXY_MAX_RESULT_DIMENSION", value: "1024"},
								{name: "IMGPROXY_SET_CANONICAL_HEADER", value: "false"},
								{name: "IMGPROXY_CACHE_CONTROL_PASSTHROUGH", value: "true"},
							]
							startupProbe: {tcpSocket: port: blobsPorts.imgproxy, periodSeconds: 2, failureThreshold: 60}
							resources: (#resourcesOf & {r: release, n: "imgproxy"}).out
						}]
					}
				}
			}
		}, {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {name: "imgproxy", namespace: release.namespace, labels: imgproxyLabels}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "imgproxy"
				}
				ports: [{name: "http", port: blobsPorts.imgproxy, targetPort: blobsPorts.imgproxy, protocol: "TCP"}]
			}
		}]
	}]

	// The app's own services (release.services): a Deployment and a Service each,
	// in the mesh as render is. Compose's SERVICE_JWT is a development value: the
	// release's own is minted against the cluster's PGRST_JWT_SECRET (release.nu
	// ensure-service-jwt) into <name>-service-jwt.
	let appServiceObjs = [for n, s in release.services {
		let labels = appLabels & {"app.kubernetes.io/component": n}
		let serviceName = n
		[{
			apiVersion: "apps/v1"
			kind:       "Deployment"
			metadata: {
				name:      "\(release.name)-\(n)"
				namespace: release.namespace
				"labels":  labels
			}
			spec: {
				replicas: release.replicas
				selector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": n
				}
				template: {
					metadata: {
						"labels":    labels
						annotations: (#daprSidecar & {id: n, port: "\(s.port)"}).out
						if s.metrics != _|_ {
							annotations: {
								"prometheus.io/scrape": "true"
								"prometheus.io/port":   "\(s.metrics.port)"
								"prometheus.io/path":   s.metrics.path
							}
						}
					}
					// A Service's links would give AUTH_PORT=tcp://... to a pod that reads AUTH_PORT as its port.
					spec: enableServiceLinks: false
					spec: containers: [{
						name:            n
						image:           (#appImage & {svc: n}).out
						imagePullPolicy: targetEnv.imagePullPolicy
						// A pod going away keeps serving while the mesh learns of its
						// successor (#daprSidecar's block-shutdown-duration holds its sidecar).
						lifecycle: preStop: sleep: seconds: 15
						ports: [{name: "http", containerPort: s.port}, if s.metrics != _|_ {{name: "metrics", containerPort: s.metrics.port}}]
						env: list.Concat([
							// A variable a Secret holds is that Secret's alone: compose's development value for it goes.
							[for k, v in s.env if k != "PORT" && k != "SERVICE_JWT" && k != "ORIGIN" && s.secrets[k] == _|_ {name: k, value: v}],
							[
								{name: "PORT", value: "\(s.port)"},
								{name: "ORIGIN", value: originValue},
								{name: "SERVICE_JWT", valueFrom: secretKeyRef: {name: "\(release.name)-service-jwt", key: "SERVICE_JWT"}},
								for k, v in s.secrets {name: k, valueFrom: secretKeyRef: {name: v, key: k}},
							],
							(#denoTelemetry & {service: n}).env,
						])
						resources: (#resourcesOf & {r: release, n: serviceName}).out
						if len(s.files) > 0 {
							volumeMounts: [for dir, cm in s.files {name: "files-\(cm)", mountPath: dir, readOnly: true}]
						}
					}]
					if len(s.files) > 0 {
						spec: volumes: [for _, cm in s.files {name: "files-\(cm)", configMap: name: cm}]
					}
				}
			}
		}, {
			apiVersion: "v1"
			kind:       "Service"
			metadata: {
				name:      n
				namespace: release.namespace
				"labels":  labels
			}
			spec: {
				type: "ClusterIP"
				selector: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": n
				}
				ports: [
					{name: "http", port: s.port, targetPort: s.port, protocol: "TCP"},
					if s.metrics != _|_ {{name: "metrics", port: s.metrics.port, targetPort: s.metrics.port, protocol: "TCP"}},
				]
			}
		}]
	}]

	// A service's clock (services.<n>.clock): each minute (its schedule), a pod that POSTs to the
	// service's path with the service role's token, as Cloud Scheduler pokes the ticker on Cloud Run.
	// It carries the app's name label, which the services' network policy admits on their ports.
	let appServiceClockObjs = [for n, s in release.services if s.clock != _|_ {
		let labels = appLabels & {"app.kubernetes.io/component": "\(n)-clock"}
		{
			apiVersion: "batch/v1"
			kind:       "CronJob"
			metadata: {
				name:      "\(release.name)-\(n)-clock"
				namespace: release.namespace
				"labels":  labels
			}
			spec: {
				schedule:                   s.clock.schedule
				timeZone:                   "Etc/UTC"
				concurrencyPolicy:          "Forbid"
				startingDeadlineSeconds:    50
				successfulJobsHistoryLimit: 1
				failedJobsHistoryLimit:     3
				jobTemplate: spec: {
					backoffLimit:            0
					activeDeadlineSeconds:   60
					ttlSecondsAfterFinished: 600
					template: {
						metadata: "labels": labels
						spec: {
							restartPolicy:      "Never"
							enableServiceLinks: false
							containers: [{
								name:  "poke"
								image: "docker.io/curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777"
								env: [{name: "SERVICE_JWT", valueFrom: secretKeyRef: {name: "\(release.name)-service-jwt", key: "SERVICE_JWT"}}]
								// A new pod's address reaches the network policies a few seconds after it starts
								// (k3s's kube-router refuses it until then): it waits, up to 30s, for the service to
								// take a connection, then pokes once.
								command: ["sh", "-c", """
									u=http://\(n).\(release.namespace).svc.cluster.local:\(s.port)
									for i in $(seq 15); do [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$u/")" != 000 ] && break; sleep 2; done
									exec curl -fsS -m 50 -X POST -H "Authorization: Bearer $SERVICE_JWT" "$u\(s.clock.path)?caller=k8s-cronjob"
									"""]
								resources: limits: {cpu: "100m", memory: "32Mi"}
							}]
						}
					}
				}
			}
		}
	}]

	// Each of the app's own services takes the door's requests on its port and
	// the mesh's, and reaches the cluster through the mesh and the internet on
	// 443 (a broker): the backends' policy holds the cluster's own, which reach
	// nothing outside.
	let appServicesNetworkPolicyObj = [
		if release.networkPolicy.enabled if len(release.services) > 0 || release.blobs != _|_ {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {
				name:      "\(release.name)-services-netpol"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				podSelector: matchExpressions: [{
					key:      "app.kubernetes.io/component"
					operator: "In"
					values: list.Concat([[for n, _ in release.services {n}], [if release.blobs != _|_ for c in ["rclone-s3", "imgproxy"] {c}]])
				}]
				policyTypes: ["Ingress", "Egress"]
				ingress: [
					{
						from: [{podSelector: matchLabels: "app.kubernetes.io/name": release.name}]
						ports: list.Concat([
							[for _, s in release.services {port: s.port, protocol: "TCP"}],
							[if release.blobs != _|_ for _, p in blobsPorts {port: p, protocol: "TCP"}],
							[{port: 50002, protocol: "TCP"}, {port: 3500, protocol: "TCP"}],
						])
					},
					// A service with a hostname of its own takes the gateway's requests on its port, as caddy does.
					if len([for _, s in release.services if s.host != _|_ {s}]) > 0 {
						ports: [for _, s in release.services if s.host != _|_ {port: s.port, protocol: "TCP"}]
					},
					{
						from: [{namespaceSelector: matchLabels: "kubernetes.io/metadata.name": "observability"}]
						ports: [{port: 9090, protocol: "TCP"}, for _, s in release.services if s.metrics != _|_ {port: s.metrics.port, protocol: "TCP"}]
					},
					// A service's metrics, which the cluster's VictoriaMetrics and the app's metrics export scrape.
					if len([for _, s in release.services if s.metrics != _|_ {s}]) > 0 {
						from: [{podSelector: matchLabels: {
							"app.kubernetes.io/name":      release.name
							"app.kubernetes.io/component": "metrics-export"
						}}]
						ports: [for _, s in release.services if s.metrics != _|_ {port: s.metrics.port, protocol: "TCP"}]
					},
				]
				egress: [
					{ports: [{port: 53, protocol: "UDP"}, {port: 53, protocol: "TCP"}]},
					{
						to: [{podSelector: matchLabels: "app.kubernetes.io/name": release.name}]
						ports: list.Concat([[{port: 50002, protocol: "TCP"}, {port: 3500, protocol: "TCP"}], [if release.blobs != _|_ {{port: blobsPorts.rcloneS3, protocol: "TCP"}}]])
					},
					{
						to: [{namespaceSelector: matchLabels: "kubernetes.io/metadata.name": "observability"}]
						ports: [{port: 4317, protocol: "TCP"}, {port: 4318, protocol: "TCP"}, {port: 9411, protocol: "TCP"}]
					},
					{
						to: [{namespaceSelector: matchLabels: "kubernetes.io/metadata.name": "dapr-system"}]
						ports: [
							{port: 4000, protocol: "TCP"},
							{port: 50001, protocol: "TCP"},
							{port: 50005, protocol: "TCP"},
							{port: 50006, protocol: "TCP"},
							{port: 6500, protocol: "TCP"},
						]
					},
					{
						to: [{ipBlock: {cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]}}]
						ports: [{port: 443, protocol: "TCP"}]
					},
				]
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
					// A service's own hostname (services.<n>.host), on HTTP: Cloudflare's tunnel holds its certificate.
					for n, s in release.services if s.host != _|_ {
						{
							name:     "host-\(n)"
							protocol: "HTTP"
							port:     80
							hostname: s.host
							allowedRoutes: namespaces: from: "Same"
						}
					},
					// Behind a tunnel, Cloudflare holds the certificate.
					if release.gateway.tls.enabled && targetEnv.ingress.by != "tunnel" {
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

	// A service's own hostname straight to it (services.<n>.host): a broker the internet calls by name.
	let serviceHostRouteObjs = [for n, s in release.services if release.gateway.enabled if s.host != _|_ {
		apiVersion: "gateway.networking.k8s.io/v1"
		kind:       "HTTPRoute"
		metadata: {
			name:      "\(release.name)-\(n)-route"
			namespace: release.namespace
			labels:    appLabels & {"app.kubernetes.io/component": n}
		}
		spec: {
			parentRefs: [{name: "\(release.name)-gateway", sectionName: "host-\(n)"}]
			hostnames: [s.host]
			rules: [{
				matches: [{path: {type: "PathPrefix", value: "/"}}]
				timeouts: request: "\(bounds.gateway.default)s"
				backendRefs: [{name: n, port: s.port}]
			}]
		}
	}]

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
					// What the door proxies to outside the cluster, as Cloud Run's door does: a plugin's
					// upstream on the internet (pronto-analytics' Umami at /a/), on 443 only, and nothing
					// private.
					{
						to: [{ipBlock: {cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]}}]
						ports: [{port: 443, protocol: "TCP"}]
					},
				]
			}
		},
	]

	// Sign in with a provider: auth fetches the identity broker's discovery and keys, and trades the
	// code, on the internet (release.auth.oidc's issuer, e.g. id.bonkchess.com), on 443 only and
	// nothing private, as the services' and the door's policies allow theirs. The backends' policy
	// gives auth no egress past the cluster, so without this the start hung on "Connection refused"
	// and the door answered 504 (2026-11-09 12:10 BRT, Bonk Chess's first hour on the node). Only
	// auth, only when the app signs in with a provider; a policy of its own, since policies add up.
	let authEgressNetworkPolicyObj = [
		if release.networkPolicy.enabled && len(release.auth.oidc) > 0 {
			apiVersion: "networking.k8s.io/v1"
			kind:       "NetworkPolicy"
			metadata: {
				name:      "\(release.name)-auth-oidc-egress"
				namespace: release.namespace
				labels:    appLabels
			}
			spec: {
				podSelector: matchLabels: {
					"app.kubernetes.io/name":      release.name
					"app.kubernetes.io/component": "auth"
				}
				policyTypes: ["Egress"]
				egress: [{
					to: [{ipBlock: {cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]}}]
					ports: [{port: 443, protocol: "TCP"}]
				}]
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
							{port: 3000, protocol: "TCP"},
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

	let runtimeObjects = (#Runtime & {
		app:         release
		environment: targetEnv
		images: {for name, _ in release.runtime {(name): (#appImage & {svc: name}).out}}
	}).objects

	// objects collects all generated Kubernetes API definitions in standard order
	objects: [
		for list in [
			namespaceObj,
			prontoSecretGeneratorObj,
			prontoExternalSecretObj,
			daprConfigObj,
			daprResiliencyObj,
			backupObjs,
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
			for o in appServiceObjs {o},
			appServiceClockObjs,
			for o in blobsObjs {o},
			vmalertObjs,
			for o in metricsExportObjs {o},
			// What the app's compose project runs beside the cluster (App.runtime, runtime.cue); the
			// metal path names its services in App.services instead, so it is empty there.
			runtimeObjects,
			gatewayObj,
			httpRouteObj,
			serviceHostRouteObjs,
			backendTrafficPolicyObj,
			caddyNetworkPolicyObj,
			backendsNetworkPolicyObj,
			authEgressNetworkPolicyObj,
			databaseNetworkPolicyObj,
			appServicesNetworkPolicyObj,
		]
		for item in list {item},
	]

	// manifests encodes the objects as a multi-document YAML stream
	manifests: yaml.MarshalStream(objects)
}
