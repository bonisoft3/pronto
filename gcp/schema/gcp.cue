package schema

import (
	"encoding/json"
	"encoding/yaml"
	"list"
	"strconv"
	"strings"
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
	// Which Cloud SQL instance holds the database: raising it starts the app on
	// a new, empty one, the way an initdb set no pgroll migration carries forward
	// reaches production. The earlier instance is left as it was, a backup and
	// the way back, until its owner deletes it.
	sqlGeneration: *1 | int & >=1
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

	// Present where the app's compose project runs mecha's ticker: the
	// environment compose gives it beside CRUD_URL, SERVICE_JWT and PORT, filled
	// by the release. The ticker runs as one more container of the service, and
	// Cloud Scheduler is its clock (mecha's services/ticker, the cloud clock).
	ticker?: env: [string]: string

	// Present where the app turns the blob plane on (capabilities.blobs): the
	// store is the same rclone, serving a Cloud Storage bucket as the S3 bucket
	// every app names (mecha-objects), and imgproxy reads it, both containers of
	// the service. Filled by the release.
	blobs?: {}

	// Containers of the app's own beside the cluster's: each names a service of
	// the app's compose project, built and pushed as the cluster's images are,
	// and reached by the door at PRONTO_UPSTREAM_<NAME> (a plugin's collector,
	// say). One that exports Prometheus metrics is scraped into Google Cloud
	// Managed Service for Prometheus by its sidecar, where the app's PromQL rules
	// and dashboards read them.
	sidecars: [=~"^[a-z][a-z0-9-]*$"]: {
		port!: int & >1024 & <65536
		// Its share of the instance's CPU, in millicpu: Cloud Run gives a
		// container with none a whole one, against a cap of 8 for them all.
		cpu: *250 | int & >=80 & <=8000
		// The environment compose gives the service, filled by the release, as
		// the ticker's is; release.cue may add to it. In the instance, a peer
		// compose names (http://crud:3000, another sidecar) is the loopback
		// port that container holds there (_loopback), a key naming one of the
		// cluster's secrets (SERVICE_JWT, say) is that secret, never compose's
		// development value, and ORIGIN is where readers are.
		env: [=~"^[A-Z_][A-Z0-9_]*$"]: string
		metrics?: {
			port!:    int & >1024 & <65536
			path:     *"/metrics" | =~"^/"
			interval: *"30s" | =~"^[1-9][0-9]*s$"
		}
	}
	// Each peer compose names, as host:port, and where it is in the instance:
	// the cluster's containers, and each sidecar at its own port.
	_loopback: {
		"crud:3000":      "127.0.0.1:\(#Ports.crud)"
		"auth:9999":      "127.0.0.1:\(#Ports.auth)"
		"electric:3000":  "127.0.0.1:\(#Ports.electric)"
		"ticker:9998":    "127.0.0.1:\(#Ports.ticker)"
		"database:5432":  "127.0.0.1:\(#Ports.database)"
		"rclone-s3:3900": "127.0.0.1:\(#Ports.rcloneS3)"
		"imgproxy:8080":  "127.0.0.1:\(#Ports.imgproxy)"
		for n, c in R.sidecars {"\(n):\(c.port)": "127.0.0.1:\(c.port)"}
	}
	_sidecarPorts: [for _, c in R.sidecars for p in [c.port, if c.metrics != _|_ {c.metrics.port}] {p}]
	// A port the cluster's containers hold, or one two sidecars share, would
	// leave one of them unable to listen in the shared instance.
	_sidecarClashes: list.Concat([
		[for _, p in #Ports if list.Contains(R._sidecarPorts, p) {"\(p), which the cluster holds"}],
		[if len(R._sidecarPorts) != len({for p in R._sidecarPorts {"\(p)": true}}) {"one port twice"}],
	])
	// A preview's metrics stay in its instance: its release may not enable
	// Monitoring nor grant its account a role there.
	_scraped: [for n, c in R.sidecars if c.metrics != _|_ if R.preview == _|_ {n}]

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
		// The auth service's own settings compose gives it (mecha's AUTH_*, such as
		// its statement bound), filled by the release.
		env: *{} | {[=~"^AUTH_[A-Z0-9_]+$"]: string}
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
		instance:       "\(R._id)-db" + [if R.sqlGeneration > 1 {"-\(R.sqlGeneration)"}, ""][0]
		connection:     "\(R._project):\(R.region):\(instance)"
		database:       R.name
		// Previews share one, made once by the project's owner with only what
		// a revision needs (docs/release-targets.md#previews), so the release
		// that makes a preview needs no say over the project's IAM.
		serviceAccount: [if R.preview != _|_ {"\(R.name)-preview"}, "\(R.name)-run"][0] + "@\(R._project).iam.gserviceaccount.com"
		job:            "\(R._id)-initdb"
		migrateJob:     "\(R._id)-migrate"
		// The Cloud Scheduler job that pokes the ticker.
		clock: "\(R._id)-clock"
		// The blob plane's bucket, named for the project too: bucket names are
		// global.
		bucket: "\(R._project)-\(R._id)-blobs"
		// What the Managed Prometheus sidecar scrapes, as a secret it mounts.
		scrapeConfig: "\(R._id)-gmp-config"
		// Generated once by the release, never a literal in what it renders;
		// the URLs are composed from the passwords, since Cloud Run expands no
		// $(VAR) inside a value.
		secrets: {
			POSTGRES_PASSWORD: "\(R._id)-postgres-password"
			ELECTRIC_PASSWORD: "\(R._id)-electric-password"
			// mecha's authenticator role, which PostgREST logs in as and switches
			// from into anon, app_user or service; initdb sets its password.
			AUTHENTICATOR_PASSWORD: "\(R._id)-authenticator-password"
			PGRST_JWT_SECRET:  "\(R._id)-pgrst-jwt-secret"
			ELECTRIC_SECRET:   "\(R._id)-electric-secret"
			CRUD_DB_URI:       "\(R._id)-crud-db-uri"
			AUTH_DATABASE_URL: "\(R._id)-auth-database-url"
			ELECTRIC_DB_URL:   "\(R._id)-electric-database-url"
			// pgroll's runner, over the socket Cloud Run mounts for a job.
			MIGRATE_DATABASE_URL: "\(R._id)-migrate-database-url"
			// The service role's token, signed with PGRST_JWT_SECRET: the ticker
			// writes with it, and its clock's poke carries it.
			SERVICE_JWT: "\(R._id)-service-jwt"
		}
	}
}

// Ports inside the shared instance: compose's own, but for electric, whose 3000
// is crud's.
#Ports: {caddy: 8080, crud: 3000, crudAdmin: 3001, auth: 9999, electric: 3002, ticker: 9998, database: 5432, proxyHealth: 9090, rcloneS3: 3900, imgproxy: 8081}

// The smallest tier admits about 25 connections, fewer than the pools'
// defaults together; the instance is raised to 50 and the pools capped.
#Pools: {crud: 5, electric: 5}
#SqlFlags: "cloudsql.logical_decoding=on,max_connections=50"

// Google Cloud Managed Service for Prometheus's collector for Cloud Run, pinned.
#Gmp: "us-docker.pkg.dev/cloud-ops-agents-artifacts/cloud-run-gmp-sidecar/cloud-run-gmp-sidecar:1.9.4@sha256:8f8ac35f4bc82aa9547b1458343acb79b2594b35b56fb4c13dbe62c1f5a64679"

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
					caddy: list.Concat([["crud", "auth", "electric"], [if R.ticker != _|_ {"ticker"}], [if R.blobs != _|_ for c in ["rclone-s3", "imgproxy"] {c}]])
					if R.ticker != _|_ {ticker: ["crud"]}
					if R.blobs != _|_ {imgproxy: ["rclone-s3"]}
					if len(R._scraped) > 0 {"gmp-collector": R._scraped}
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
				if len(R._scraped) > 0 {
					volumes: [{name: "gmp-config", secret: {secretName: R.names.scrapeConfig, items: [{key: "latest", path: "config.yaml"}]}}]
				}
				containers: list.Concat([[{
					name:  "caddy"
					image: (imageOf & {svc: "caddy"}).out
					ports: [{name: "http1", containerPort: P.caddy}]
					env: list.Concat([[
						if R._origin != "" {{name: "ORIGIN", value: R._origin}},
						if len(R._aliases) > 0 {{name: "PRONTO_ALIASES", value: strings.Join(R._aliases, " ")}},
						{name: "PRONTO_UPSTREAM_CRUD", value: "127.0.0.1:\(P.crud)"},
						{name: "PRONTO_UPSTREAM_AUTH", value: "127.0.0.1:\(P.auth)"},
						{name: "PRONTO_UPSTREAM_ELECTRIC", value: "127.0.0.1:\(P.electric)"},
						if R.ticker != _|_ {{name: "PRONTO_UPSTREAM_TICKER", value: "127.0.0.1:\(P.ticker)"}},
						if R.blobs != _|_ {{name: "PRONTO_UPSTREAM_RCLONE_S3", value: "127.0.0.1:\(P.rcloneS3)"}},
						if R.blobs != _|_ {{name: "PRONTO_UPSTREAM_IMGPROXY", value: "127.0.0.1:\(P.imgproxy)"}},
						(secretOf & {env: "ELECTRIC_SECRET", secret: sq.ELECTRIC_SECRET}).out,
					], [for n, c in R.sidecars {name: "PRONTO_UPSTREAM_\(strings.ToUpper(strings.Replace(n, "-", "_", -1)))", value: "127.0.0.1:\(c.port)"}]])
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
						(secretOf & {env: "PGRST_JWT_SECRET", secret: sq.PGRST_JWT_SECRET}).out,
						if R._rpId != "" {{name: "WEBAUTHN_RP_ID", value: R._rpId}},
						if R._origin != "" {{name: "WEBAUTHN_ORIGIN", value: R._origin}},
					], [for k, v in R.auth.env {name: k, value: v}], [for k, v in R.auth.oidc {name: k, value: v}], [for k, v in R.auth.oidcSecrets {(secretOf & {env: k, secret: v}).out}]])
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
				}, if R.ticker != _|_ {
					name:  "ticker"
					image: (imageOf & {svc: "ticker"}).out
					env: list.Concat([[
						{name: "CRUD_URL", value: "http://127.0.0.1:\(P.crud)"},
						{name: "PORT", value: "\(P.ticker)"},
						(secretOf & {env: "SERVICE_JWT", secret: sq.SERVICE_JWT}).out,
					], [for k, v in R.ticker.env {name: k, value: v}]])
					startupProbe: {tcpSocket: port: P.ticker, periodSeconds: 2, failureThreshold: 60}
					resources: limits: cpu: "250m"
				}, if R.blobs != _|_ {
					// mecha's blob plane over the bucket: a combine remote names its root
					// mecha-objects, and the service's account reaches it with no key.
					name:  "rclone-s3"
					image: (imageOf & {svc: "rclone-s3"}).out
					command: ["rclone"]
					args: ["serve", "s3", "--addr=0.0.0.0:\(P.rcloneS3)", "--vfs-cache-mode=off", "objects:"]
					env: [
						{name: "RCLONE_CONFIG_OBJECTS_TYPE", value: "combine"},
						{name: "RCLONE_CONFIG_OBJECTS_UPSTREAMS", value: "mecha-objects=gcs:\(R.names.bucket)"},
						{name: "RCLONE_CONFIG_GCS_TYPE", value: "google cloud storage"},
						{name: "RCLONE_CONFIG_GCS_ENV_AUTH", value: "true"},
						{name: "RCLONE_CONFIG_GCS_BUCKET_POLICY_ONLY", value: "true"},
					]
					startupProbe: {tcpSocket: port: P.rcloneS3, periodSeconds: 2, failureThreshold: 60}
				}, if R.blobs != _|_ {
					name:  "imgproxy"
					image: (imageOf & {svc: "imgproxy"}).out
					env: [
						{name: "IMGPROXY_USE_S3", value: "true"},
						{name: "IMGPROXY_S3_ENDPOINT", value: "http://127.0.0.1:\(P.rcloneS3)"},
						// The store takes any key pair; imgproxy's S3 client insists on one.
						{name: "AWS_ACCESS_KEY_ID", value: "GK000000000000000000000000"},
						{name: "AWS_SECRET_ACCESS_KEY", value: "0000000000000000000000000000000000000000000000000000000000000000"},
						{name: "AWS_REGION", value: "rclone"},
						{name: "IMGPROXY_BIND", value: ":\(P.imgproxy)"},
						{name: "IMGPROXY_MAX_SRC_RESOLUTION", value: "50"},
						// The store and Google's photo host, as mecha's #ImgproxySources.
						{name: "IMGPROXY_ALLOWED_SOURCES", value: "s3://mecha-objects/,https://lh3.googleusercontent.com/"},
						// mecha's presets alone (its #ImgproxyPresets), as compose's imgproxy: no
						// key signs a URL.
						{name: "IMGPROXY_ONLY_PRESETS", value: "true"},
						{name: "IMGPROXY_PRESETS", value: "thumb=rs:fill:128:128/f:webp,avatar=rs:fill:256:256/f:webp,picture=rs:fit:1024:1024/f:webp"},
						{name: "IMGPROXY_MAX_RESULT_DIMENSION", value: "1024"},
						{name: "IMGPROXY_SET_CANONICAL_HEADER", value: "false"},
						{name: "IMGPROXY_CACHE_CONTROL_PASSTHROUGH", value: "true"},
					]
					startupProbe: {tcpSocket: port: P.imgproxy, periodSeconds: 2, failureThreshold: 60}
				}, {
					name:  "cloud-sql-proxy"
					image: #Proxy
					args: ["--port=\(P.database)", "--health-check", "--http-port=\(P.proxyHealth)", "--http-address=0.0.0.0", R.names.connection]
					startupProbe: {httpGet: {path: "/startup", port: P.proxyHealth}, periodSeconds: 2, failureThreshold: 60}
					resources: limits: cpu: "500m"
				}], [for n, c in R.sidecars {
					name:  n
					image: (imageOf & {svc: n}).out
					if len(c.env) > 0 {
						env: [for k, v in c.env {[
							if sq[k] != _|_ {(secretOf & {env: k, secret: sq[k]}).out},
							if k == "ORIGIN" && R._origin != "" {{name: k, value: R._origin}},
							{name: k, value: v},
						][0]}]
					}
					startupProbe: {tcpSocket: port: c.port, periodSeconds: 2, failureThreshold: 60}
					resources: limits: cpu: "\(c.cpu)m"
				}], [if len(R._scraped) > 0 {
					name:  "gmp-collector"
					image: #Gmp
					resources: limits: cpu: "250m"
					volumeMounts: [{name: "gmp-config", mountPath: "/etc/rungmp"}]
				}]])
			}
		}
	}

	// The schema, as compose's database builds it on a fresh volume: the app's
	// database image runs its initdb directory once against Cloud SQL, over the
	// socket Cloud Run mounts, and a database comment marks it done (as the k8s
	// release's initdb Job does). Its re-runnable steps and the roles' grant run
	// every release.
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
							if [ "$marker" = "pronto initdb" ]; then echo "initdb: already built"
							  # Its re-runnable steps are the release's, though (emit.cue's): a new
							  # entity's table, every policy, trigger and publication, and the hybrid
							  # machines' code run again, keeping every row.
							  for step in 005_create_tables 006_policies 007_txid 008_publication 016_mecha_actors; do
							    f=/docker-entrypoint-initdb.d/$step.sql
							    if [ -f "$f" ]; then psql -v ON_ERROR_STOP=1 -Xq -f "$f"; fi
							  done
							else
							  source /usr/local/bin/docker-entrypoint.sh
							  docker_process_sql() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password --no-psqlrc --dbname "$POSTGRES_DB" "$@"; }
							  docker_process_init_files /docker-entrypoint-initdb.d/*
							  psql -XqAc "COMMENT ON DATABASE \\"$POSTGRES_DB\\" IS 'pronto initdb'"
							fi
							# Cloud SQL's postgres is no superuser: crud and auth connect as it
							# and switch into these, which it created but holds no SET on.
							psql -v ON_ERROR_STOP=1 -XqAc "GRANT anon, app_user, service TO postgres WITH INHERIT FALSE, SET TRUE"
							# It also owns the tables under FORCE ROW LEVEL SECURITY and the
							# SECURITY DEFINER functions that write them, which a superuser
							# bypasses; BYPASSRLS gives it that back. Sessions that switch
							# roles still meet every policy.
							psql -v ON_ERROR_STOP=1 -XqAc "ALTER ROLE postgres BYPASSRLS"
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

	// What the Managed Prometheus sidecar scrapes: each sidecar's metrics, on
	// the instance's loopback.
	scrapeConfig: yaml.Marshal({
		apiVersion: "monitoring.googleapis.com/v1beta"
		kind:       "RunMonitoring"
		metadata: name: R._id
		spec: endpoints: [for n in R._scraped let m = R.sidecars[n].metrics {port: m.port, path: m.path, interval: m.interval}]
	})

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
		// The ticker's clock, once a minute, the floor (mecha's services/ticker,
		// the cloud clock): the service's own run.app address, which a domain
		// mapping still provisioning cannot stall.
		if R.ticker != _|_ && R.runHost != "" {clock: {
			name:     R.names.clock
			schedule: "* * * * *"
			uri:      "https://\(R.runHost)/poke?caller=cloud-scheduler"
		}}
		oidcSecretKeys: [for _, v in R.auth.oidcSecrets {v}]
		// The compose services built and run beside the cluster's.
		sidecars: [for n, _ in R.sidecars {n}]
		// Where each peer compose names is in the instance, which the release
		// rewrites a sidecar's compose environment by.
		loopback: R._loopback
		if len(R._sidecarClashes) > 0 {sidecarPorts: error("GCP.sidecars listen on \(strings.Join(R._sidecarClashes, ", "))")}
		if B._millicpu > 8000 {cpu: error("the service's containers ask for \(B._millicpu) millicpu, over Cloud Run's 8000: lower GCP.sidecars' cpu")}
		scrapeConfig: [if len(R._scraped) > 0 {B.scrapeConfig}, ""][0]
	}
	// A container with no limit is given a whole CPU.
	_millicpu: list.Sum([for c in B.service.spec.template.spec.containers {
		[if c.resources.limits.cpu != _|_ {strconv.Atoi(strings.TrimSuffix(c.resources.limits.cpu, "m"))}, 1000][0]
	}])
	_noLiteralSecret: true & !strings.Contains(json.Marshal(B.service), "postgres://")
}
