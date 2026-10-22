package schema

import (
	"encoding/json"
	"encoding/yaml"
	"list"
	"strings"

	"github.com/bonisoft3/pronto/resilience"
)

// #Release is an app on GCP: Cloud SQL for its database, and caddy, crud, auth
// and electric as containers of one Cloud Run service, sharing localhost the way
// mecha's bundled unit does (docs/deployment.md#the-bundled-unit), beside the
// Cloud SQL Auth Proxy. One instance at most, since electric is one; none while
// nobody plays.
#Release: R={
	// The app's compose project name, which names its database, secrets and images.
	name: =~"^[a-z]([-a-z0-9]{0,28}[a-z0-9])?$"
	// The Cloud Run service readers reach; the app's name unless it is known by
	// another.
	service: *name | =~"^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$"
	project: =~"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"
	region:  *"us-central1" | =~"^[a-z]+-[a-z]+[0-9]$"
	// The Artifact Registry repository, in the region.
	repository: *"pronto" | =~"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"
	// The address readers reach, mapped onto the service; absent, its run.app
	// one, which the release fills from the project's number.
	domain?: =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"
	runHost: *"" | =~"^[a-z0-9-]+\\.[a-z0-9-]+\\.run\\.app$"
	// Other names mapped onto the service, each sent on to the domain by the
	// door (www, say): a passkey's relying party is the domain alone.
	aliases: *[] | [...=~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"]
	sqlTier:  *"db-f1-micro" | string
	// A pull request's own copy of the app, beside the released one: its own
	// service, Cloud SQL instance, jobs and secrets, each named for the app and
	// the preview, at the service's run.app address with no domain or alias
	// mapped. The release sets it (`sayt release@gcp --preview=pr-32`), and
	// `--delete` removes all of it when the pull request closes.
	preview?: =~"^[a-z0-9]([-a-z0-9]{0,14}[a-z0-9])?$"
	// The project previews run in, apart from the release's: everything a
	// preview makes, its images and its account are there, so whoever deploys
	// previews holds no role in the released app's project. Absent, previews
	// run beside the release.
	previewProject?: =~"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"

	// Filled by the release from what it pushed: a revision resolves a tag once,
	// so every image is named by digest (mecha's docs/deployment.md, what bites).
	image: {
		tag: *"latest" | string
		pushed: [string]: {tag: string, digest: =~"^sha256:[0-9a-f]{64}$"}
	}

	// Present where the app's compose project runs the cluster's migrate step: the
	// environment compose gives it beside its DATABASE_URL, filled by the release.
	migrate?: env: [string]: string

	// The roles the app's schema grants PostgREST's login, as generate wrote them
	// (.pronto/cluster.json, the k8s release's source too): what the job grants
	// Cloud SQL's postgres SET on, since which of them exist is the program's.
	// Filled by the release.
	database: tokenRoles: [...string]

	auth: {
		// The providers compose gives the auth service, filled by the release;
		// overrides here win, as a deployment's environment does in compose.
		oidc: *{} | {[=~"^OIDC_[A-Z0-9_]+$"]: string}
		// What the program must not hold (a provider's client secret), by the
		// Secret Manager secret that holds it.
		oidcSecrets: *{} | {[=~"^OIDC_[A-Z0-9_]+$"]: string}
		// The providers the program offers, whose ways in the terminal draws
		// (compose's OIDC_PROVIDERS), filled by the release.
		programProviders: *"" | string
	}

	// Where this release's resources are: a preview's project when it has one.
	_project:  [if R.preview != _|_ && R.previewProject != _|_ {R.previewProject}, R.project][0]
	_registry: "\(R.region)-docker.pkg.dev/\(R._project)/\(R.repository)"
	// What a preview's resources are named for: the app, and the preview.
	_id:      [if R.preview != _|_ {"\(R.name)-\(R.preview)"}, R.name][0]
	_service: [if R.preview != _|_ {"\(R.service)-\(R.preview)"}, R.service][0]
	_domain:  [if R.domain != _|_ && R.preview == _|_ {R.domain}, ""][0]
	_aliases: [if R.preview != _|_ {[]}, R.aliases][0]
	// Where readers are, which the door and a passkey's relying party are told
	// (ORIGIN and WEBAUTHN_* in compose).
	_host: [if _domain != "" {_domain}, R.runHost][0]
	_origin: [if _host != "" {"https://\(_host)"}, ""][0]
	_rpId:   _host

	names: {
		instance:       "\(R._id)-db"
		connection:     "\(R._project):\(R.region):\(instance)"
		database:       R.name
		// Previews share one, made once by the project's owner with only what
		// a revision needs (docs/release-targets.md#previews), so the release
		// that makes a preview needs no say over the project's IAM.
		serviceAccount: [if R.preview != _|_ {"\(R.name)-preview"}, "\(R.name)-run"][0] + "@\(R._project).iam.gserviceaccount.com"
		job:            "\(R._id)-initdb"
		migrateJob:     "\(R._id)-migrate"
		// Generated once by the release, never a literal in what it renders;
		// the URLs are composed from the passwords, since Cloud Run expands no
		// $(VAR) inside a value.
		secrets: {
			POSTGRES_PASSWORD: "\(R._id)-postgres-password"
			// The roles' passwords the image's initdb step sets (899_role_passwords.sh).
			ELECTRIC_PASSWORD:      "\(R._id)-electric-password"
			AUTHENTICATOR_PASSWORD: "\(R._id)-authenticator-password"
			PGRST_JWT_SECRET:  "\(R._id)-pgrst-jwt-secret"
			ELECTRIC_SECRET:   "\(R._id)-electric-secret"
			CRUD_DB_URI:       "\(R._id)-crud-db-uri"
			AUTH_DATABASE_URL: "\(R._id)-auth-database-url"
			ELECTRIC_DB_URL:   "\(R._id)-electric-database-url"
			// pgroll's runner, over the socket Cloud Run mounts for a job.
			MIGRATE_DATABASE_URL: "\(R._id)-migrate-database-url"
		}
	}
}

// Ports inside the shared instance: compose's own, but for electric, whose 3000
// is crud's.
#Ports: {caddy: 8080, crud: 3000, crudAdmin: 3001, auth: 9999, electric: 3002, database: 5432, proxyHealth: 9090}

// The smallest tier admits about 25 connections, fewer than the pools'
// defaults together; the instance is raised to 50 and the pools capped.
#Pools: {crud: 5, electric: 5}
#SqlFlags: "cloudsql.logical_decoding=on,max_connections=50"

// The Cloud SQL Auth Proxy, pinned.
#Proxy: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.18.2@sha256:fc224915ef435afeb5b2a9421260a0d31986d5c8b7c7f5783c7f5d5885700cd2"

#Build: B={
	release: #Release
	let R = release
	let P = #Ports
	let imageOf = {
		svc: string
		out: [
			if R.image.pushed[svc] != _|_ {"\(R._registry)/\(R.name)-\(svc)@\(R.image.pushed[svc].digest)"},
			"\(R._registry)/\(R.name)-\(svc):\(R.image.tag)",
		][0]
	}
	let secretOf = {
		env:    string
		secret: string
		out: {name: env, valueFrom: secretKeyRef: {name: secret, key: "latest"}}
	}
	let sq = R.names.secrets
	let bounds = resilience.resilience.timeouts

	service: {
		apiVersion: "serving.knative.dev/v1"
		kind:       "Service"
		metadata: {
			name: R._service
			labels: "cloud.googleapis.com/location": R.region
			annotations: "run.googleapis.com/ingress": "all"
		}
		spec: template: {
			metadata: annotations: {
				"autoscaling.knative.dev/minScale": "0"
				// electric is one instance (mecha's docs/deployment.md#clouds-as-built).
				"autoscaling.knative.dev/maxScale":       "1"
				"run.googleapis.com/execution-environment": "gen2"
				"run.googleapis.com/startup-cpu-boost":     "true"
				"run.googleapis.com/container-dependencies": json.Marshal({
					caddy: ["crud", "auth", "electric"]
					crud: ["cloud-sql-proxy"]
					auth: ["cloud-sql-proxy"]
					electric: ["cloud-sql-proxy"]
				})
			}
			spec: {
				serviceAccountName: R.names.serviceAccount
				// electric's live requests hold for its long-poll.
				timeoutSeconds: 300
				// A page load asks for every hatch file at once while electric's
				// live requests hold theirs, and this one instance is all there is.
				containerConcurrency: 1000
				containers: [{
					name:  "caddy"
					image: (imageOf & {svc: "caddy"}).out
					ports: [{name: "http1", containerPort: P.caddy}]
					env: list.Concat([[
						if R._origin != "" {{name: "ORIGIN", value: R._origin}},
						if len(R._aliases) > 0 {{name: "PRONTO_ALIASES", value: strings.Join(R._aliases, " ")}},
						{name: "PRONTO_UPSTREAM_CRUD", value: "127.0.0.1:\(P.crud)"},
						{name: "PRONTO_UPSTREAM_AUTH", value: "127.0.0.1:\(P.auth)"},
						{name: "PRONTO_UPSTREAM_ELECTRIC", value: "127.0.0.1:\(P.electric)"},
						(secretOf & {env: "ELECTRIC_SECRET", secret: sq.ELECTRIC_SECRET}).out,
					]])
					startupProbe: {httpGet: {path: "/health", port: P.caddy}, periodSeconds: 2, failureThreshold: 60}
				}, {
					name:  "crud"
					image: (imageOf & {svc: "crud"}).out
					env: [
						(secretOf & {env: "PGRST_DB_URI", secret: sq.CRUD_DB_URI}).out,
						(secretOf & {env: "PGRST_JWT_SECRET", secret: sq.PGRST_JWT_SECRET}).out,
						{name: "PGRST_DB_SCHEMA", value: "public"},
						{name: "PGRST_DB_ANON_ROLE", value: "anon"},
						{name: "PGRST_DB_PRE_REQUEST", value: "public.app_pre_request"},
						// Cloud Run probes the instance's address, not loopback.
						{name: "PGRST_SERVER_HOST", value: "*"},
						{name: "PGRST_DB_POOL", value: "\(#Pools.crud)"},
						{name: "PGRST_SERVER_PORT", value: "\(P.crud)"},
						{name: "PGRST_ADMIN_SERVER_PORT", value: "\(P.crudAdmin)"},
					]
					startupProbe: {httpGet: {path: "/ready", port: P.crudAdmin}, periodSeconds: 2, failureThreshold: 60}
				}, {
					name:  "auth"
					image: (imageOf & {svc: "auth"}).out
					env: list.Concat([[
						(secretOf & {env: "DATABASE_URL", secret: sq.AUTH_DATABASE_URL}).out,
						// The service refuses to start without its statement bound.
						{name: "AUTH_STATEMENT_TIMEOUT_MS", value: "\(bounds.statement.client*1000)"},
						(secretOf & {env: "PGRST_JWT_SECRET", secret: sq.PGRST_JWT_SECRET}).out,
						if R._rpId != "" {{name: "WEBAUTHN_RP_ID", value: R._rpId}},
						if R._origin != "" {{name: "WEBAUTHN_ORIGIN", value: R._origin}},
					], [for k, v in R.auth.oidc {name: k, value: v}], [for k, v in R.auth.oidcSecrets {(secretOf & {env: k, secret: v}).out}]])
					startupProbe: {tcpSocket: port: P.auth, periodSeconds: 2, failureThreshold: 60}
				}, {
					name:  "electric"
					image: (imageOf & {svc: "electric"}).out
					env: [
						(secretOf & {env: "DATABASE_URL", secret: sq.ELECTRIC_DB_URL}).out,
						(secretOf & {env: "ELECTRIC_SECRET", secret: sq.ELECTRIC_SECRET}).out,
						{name: "ELECTRIC_PORT", value: "\(P.electric)"},
						{name: "ELECTRIC_MANUAL_TABLE_PUBLISHING", value: "true"},
						{name: "ELECTRIC_DB_POOL_SIZE", value: "\(#Pools.electric)"},
						// The instance's own: electric's shape metadata is SQLite,
						// which a bucket mounted over FUSE cannot lock. A new
						// instance rebuilds its shapes from Postgres.
						{name: "ELECTRIC_STORAGE_DIR", value: "/tmp/electric"},
					]
					startupProbe: {httpGet: {path: "/v1/health", port: P.electric}, periodSeconds: 2, failureThreshold: 90}
				}, {
					name:  "cloud-sql-proxy"
					image: #Proxy
					args: ["--port=\(P.database)", "--health-check", "--http-port=\(P.proxyHealth)", "--http-address=0.0.0.0", R.names.connection]
					startupProbe: {httpGet: {path: "/startup", port: P.proxyHealth}, periodSeconds: 2, failureThreshold: 60}
				}]
			}
		}
	}

	// The schema, as compose's database builds it on a fresh volume: the app's
	// database image runs its initdb directory once against Cloud SQL, over the
	// socket Cloud Run mounts, and a database comment marks it done (as the k8s
	// release's initdb Job does). The roles' grant runs every release.
	job: {
		apiVersion: "run.googleapis.com/v1"
		kind:       "Job"
		metadata: {
			name: R.names.job
			labels: "cloud.googleapis.com/location": R.region
		}
		spec: template: {
			metadata: annotations: "run.googleapis.com/cloudsql-instances": R.names.connection
			spec: {
				taskCount: 1
				template: spec: {
					serviceAccountName: R.names.serviceAccount
					maxRetries:         0
					timeoutSeconds:     600
					containers: [{
						name:  "initdb"
						image: (imageOf & {svc: "database"}).out
						command: ["bash", "-c", """
							set -euo pipefail
							marker=$(psql -XtAc "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()")
							if [ "$marker" = "pronto initdb" ]; then echo "initdb: already built"; else
							  source /usr/local/bin/docker-entrypoint.sh
							  docker_process_sql() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password --no-psqlrc --dbname "$POSTGRES_DB" "$@"; }
							  docker_process_init_files /docker-entrypoint-initdb.d/*
							  psql -XqAc "COMMENT ON DATABASE \\"$POSTGRES_DB\\" IS 'pronto initdb'"
							fi
							# Cloud SQL's postgres is no superuser: crud and auth connect as it
							# and switch into these, which it created but holds no SET on.
							psql -v ON_ERROR_STOP=1 -XqAc "GRANT \(strings.Join(R.database.tokenRoles, ", ")) TO postgres WITH INHERIT FALSE, SET TRUE"
							"""]
						env: [
							{name: "PGHOST", value: "/cloudsql/\(R.names.connection)"},
							{name: "PGUSER", value: "postgres"},
							{name: "PGDATABASE", value: R.names.database},
							{name: "POSTGRES_USER", value: "postgres"},
							{name: "POSTGRES_DB", value: R.names.database},
							(secretOf & {env: "PGPASSWORD", secret: sq.POSTGRES_PASSWORD}).out,
							(secretOf & {env: "ELECTRIC_PASSWORD", secret: sq.ELECTRIC_PASSWORD}).out,
							(secretOf & {env: "AUTHENTICATOR_PASSWORD", secret: sq.AUTHENTICATOR_PASSWORD}).out,
						]
					}]
				}
			}
		}
	}

	// A database built before a change is carried forward by the cluster's pgroll runner, the
	// image compose's migrate step runs (mecha's docs/schema.md, carrying a live database
	// forward), after initdb and before the service rolls: the k8s release's migrate Job.
	if R.migrate != _|_ {
		migrateJob: {
			apiVersion: "run.googleapis.com/v1"
			kind:       "Job"
			metadata: {
				name: R.names.migrateJob
				labels: "cloud.googleapis.com/location": R.region
			}
			spec: template: {
				metadata: annotations: "run.googleapis.com/cloudsql-instances": R.names.connection
				spec: {
					taskCount: 1
					template: spec: {
						serviceAccountName: R.names.serviceAccount
						maxRetries:         0
						timeoutSeconds:     600
						containers: [{
							name:  "migrate"
							image: (imageOf & {svc: "migrate"}).out
							env: list.Concat([[(secretOf & {env: "DATABASE_URL", secret: sq.MIGRATE_DATABASE_URL}).out], [for k, v in R.migrate.env {name: k, value: v}]])
						}]
					}
				}
			}
		}
	}

	// A provider the program configures for development, against a broker on the developer's
	// machine, sends every reader to their own machine; one the program offers and production
	// does not serve leaves the terminal's way in answering 404. Either refuses the release.
	let served = [for p in strings.Split([if R.auth.oidc.OIDC_PROVIDERS != _|_ {R.auth.oidc.OIDC_PROVIDERS}, ""][0], ",") if p != "" {p}]
	let atDeveloper = [for p in served for k in ["ISSUER", "INTERNAL"]
		let key = "OIDC_\(strings.ToUpper(p))_\(k)"
		if R.auth.oidc[key] != _|_
		if R.auth.oidc[key] =~ "//(localhost|127\\.0\\.0\\.1|\\[::1\\]|host\\.docker\\.internal)([:/]|$)" {"\(key) is \(R.auth.oidc[key])"}]
	let unserved = [for p in strings.Split(R.auth.programProviders, ",") if p != "" if !list.Contains(served, p) {p}]

	// What the release needs besides the two documents, as JSON.
	plan: {
		project:        R._project
		region:         R.region
		repository:     R.repository
		registry:       R._registry
		service:        R._service
		if R.preview != _|_ {preview: R.preview}
		names:          R.names
		sqlTier:        R.sqlTier
		sqlFlags:       #SqlFlags
		if R._domain != "" {domain: R._domain}
		aliases:        R._aliases
		if len(atDeveloper) > 0 {providers: error("a provider at a developer's address: \(strings.Join(atDeveloper, ", ")); give GCP.auth.oidc the provider's production issuer")}
		if len(unserved) > 0 {providers: error("the terminal offers \(strings.Join(unserved, ", ")), which production does not serve, so its way in would answer 404: give GCP.auth.oidc the provider's production settings")}
		// An alias sends readers on to the domain, so it needs one.
		if len(R._aliases) > 0 {aliasTarget: R.domain}
		hasRpId:        R._rpId != ""
		serviceYaml:    yaml.Marshal(B.service)
		jobYaml:        yaml.Marshal(B.job)
		migrateJobYaml: [if B.migrateJob != _|_ {yaml.Marshal(B.migrateJob)}, ""][0]
		oidcSecretKeys: [for _, v in R.auth.oidcSecrets {v}]
	}
	_noLiteralSecret: true & !strings.Contains(json.Marshal(B.service), "postgres://")
}
