package schema

// #Environment defines the infrastructure profile for target clusters.
#Environment: {
	name:             "kind" | "eks" | "aks" | "metal"
	registry:         string
	gatewayClassName: string
	storageClass:     string
	imagePullPolicy:  "Always" | "IfNotPresent"
	domainSuffix:     string
	// Build platform for every image in a release's FROM chain; absent builds
	// for the builder's own, which is what a local Kind node runs.
	platform?: string
	// The kube context a release applies to; absent, Kind's own (cluster.yaml).
	context?: string
	// How the release reaches the context's API when it listens only on the
	// node: an SSH tunnel the release opens for its own run, to the node's
	// 6443, on a free local port its kubeconfig then names. A tunnel kept open
	// for hours was seen to stall large applies; one per release does not
	// outlive it, and is opened again if an apply through it fails.
	access?: {ssh: =~"^[^@\\s]+@[^@\\s]+$"}
	// What builds the images: Docker on the machine releasing, or Cloud Build
	// in a project of the operator's, which pushes them to `registry` (an
	// Artifact Registry repository the cluster pulls from), so the machine
	// releasing needs no Docker daemon. `node` builds with Docker on the machine
	// releasing too, but pushes through the release's SSH tunnel (`access`) to a
	// registry on the node itself, listening on its loopback alone, which the
	// node pulls from: no cloud between the build and the cluster.
	build: *{by: "docker"} | {by: "cloudbuild", project: string} | {by: "node"}
	if build.by == "node" {
		access: ssh: _
		registry: "127.0.0.1:5000"
	}
	// How requests reach the gateway: the node's host ports 80 and 443 (Kind),
	// or a Cloudflare Tunnel the cluster dials out through, for a cluster
	// behind NAT. Cloudflare terminates TLS there, so the gateway listens on
	// HTTP alone, and each app's host is a DNS record onto the tunnel.
	ingress: *{by: "hostPort"} | {by: "tunnel", id: =~"^[0-9a-f-]{36}$"}
}

// #ReleaseSpec defines a Pronto application workload intent independent of the target cluster.
#ReleaseSpec: {
	name:      =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
	namespace: string | *name

	type: "pronto" | *"pronto"

	image: {
		tag:        string | *"latest"
		// Filled by the release from what it pushed, so a deployment names the
		// exact image. CloudNativePG refuses `latest` and a bare digest: it reads
		// the database's tag as the Postgres major version.
		pushed: [string]: {tag: string, digest: =~"^sha256:[0-9a-f]{64}$"}
	}

	replicas:   int | *1

	env:     *{} | {[string]: string}
	externalSecrets: {
		enabled:        bool | *false
		secretStoreRef: string | *"cluster-secrets"
	}

	database: {
		storage: string | *"1Gi"
		// The roles a token may name, which the schema grants PostgREST's login
		// (the app's .pronto/cluster.json; the release fills it).
		tokenRoles: [...string]
		// Where its base backups and WAL go, an S3-compatible bucket, through CloudNativePG's
		// barman-cloud plugin: WAL as each segment fills, a base backup on `schedule` (six
		// fields, UTC) and once when the Cluster first gets it, kept `retention` (CloudNativePG's
		// form, 30d say). Its keys are a Secret the operator keeps in the app's namespace,
		// ACCESS_KEY_ID and ACCESS_SECRET_KEY: the release refuses to start without it.
		// barman-cloud makes the bucket on its first backup where the keys may.
		backup?: {
			endpoint!:  =~"^https://"
			bucket!:    =~"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$"
			path:       =~"^[a-z0-9][a-z0-9/_.-]*$" | *name
			secret:     =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" | *"\(name)-backup-s3"
			retention:  =~"^[1-9][0-9]*[dwm]$" | *"30d"
			schedule:   string | *"0 0 6 * * *"
		}
	}

	// Present where the app's compose project has a migrate service: the
	// environment compose gives it beyond its DATABASE_URL (REQUIRED_TABLES),
	// filled by the release from that project.
	migrate?: env: [string]: string

	auth: {
		rpId?:   string
		origin?: string
		// The providers the auth service signs in through, and each one's
		// client, as the app's compose project gives them: filled by the
		// release, which fails there when a provider's client is unset.
		oidc: *{} | {[=~"^OIDC_[A-Z0-9_]+$" & !~"_CLIENT_SECRET$"]: string}
		oidcSecrets: *[] | [...=~"^OIDC_[A-Z0-9_]+_CLIENT_SECRET$"]
		oidcSecretDigest: *"" | =~"^[0-9a-f]{64}$"
	}

	render: {
		enabled: bool | *false
		port:    int | *8090
	}

	// Services of the app's own beside the cluster's, a plugin's (pronto-billing's
	// billing, say), as GCP.sidecars are on Cloud Run: each names a service of the
	// app's compose project, built and pushed as the cluster's images are, a
	// Deployment of its own in the mesh, reached by the door at
	// PRONTO_UPSTREAM_<NAME>. Its environment is compose's, filled by the release,
	// under what release.cue sets (a broker's production address, where compose
	// names a developer's machine); a peer compose names (http://crud:3000) is that
	// peer through the mesh, SERVICE_JWT the release's own (<name>-service-jwt),
	// and ORIGIN where readers are. It may reach the internet on 443 (a broker).
	services: [=~"^[a-z][a-z0-9-]*$"]: {
		port!: int & >1024 & <65536
		env: [=~"^[A-Z_][A-Z0-9_]*$"]: string
		// Variables read from a Secret the operator keeps in the app's namespace, each under its
		// variable's name (a sender's VAPID key): the pod does not start until it is there.
		secrets: [=~"^[A-Z_][A-Z0-9_]*$"]: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
		// Files read from a ConfigMap in the app's namespace, mounted read-only at each directory,
		// its keys the file names (flagd's live flags, which pronto-flags push writes): the pod does
		// not start until it is there, and a change reaches the files in about a minute.
		files: [=~"^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$"]: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
		// What a ConfigMap of files is made from when it is not there yet, by name: a file of the app,
		// its key the file's name (flagd's flags as generate wrote them). Once, on the release that
		// finds it missing; a release never writes over one that exists (pronto-flags push owns it).
		seed: [=~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"]: =~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$"
		// Where the service exports Prometheus metrics (a collector's journey_runs_total, which the
		// alerting rules read), scraped by the cluster's VictoriaMetrics as gcp's gmp-collector does.
		metrics?: {
			port!: int & >1024 & <65536
			path:  *"/metrics" | =~"^/"
		}
	}


	// The app's alerting rules, each a file of the app in vmalert's (Prometheus's) format: pronto-journeys'
	// burn rates, pronto-perf's. A vmalert of the app's own evaluates them against the cluster's
	// VictoriaMetrics, as Cloud Monitoring does on gcp. A firing alert goes to `notifier` (an
	// Alertmanager) where one is named; without one it is kept as the ALERTS series in VictoriaMetrics,
	// which a probe or a dashboard reads. The release writes the files to <name>-alert-rules each run,
	// and vmalert reads a change within a minute.
	alerting: {
		rules: [...=~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*\\.ya?ml$"]
		notifier?: =~"^https?://[^ ]+$"
	}

	// A container's own requests and limits over `resources`, by its name: crud, electric, auth,
	// caddy, render, or one of the app's services. An Electric holding a shape per player and
	// table needs more memory than a door (Bonk Chess's was OOMKilled at 256Mi, 2026-11-06).
	containerResources: [string]: {
		requests?: {cpu?: string, memory?: string}
		limits?: {cpu?: string, memory?: string}
	}

	resources: {
		requests: {
			cpu:    string | *"50m"
			memory: string | *"64Mi"
		}
		limits: {
			cpu:    string | *"500m"
			memory: string | *"256Mi"
		}
	}

	gateway: {
		enabled: bool | *true
		host?:   string
		tls: {
			enabled:    bool | *true
			secretName?: string
		}
	}

	networkPolicy: {
		enabled: bool | *true
	}
}

