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
	// What builds the images: Docker on the machine releasing, or Cloud Build
	// in a project of the operator's, which pushes them to `registry` (an
	// Artifact Registry repository the cluster pulls from), so the machine
	// releasing needs no Docker daemon.
	build: *{by: "docker"} | {by: "cloudbuild", project: string}
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

