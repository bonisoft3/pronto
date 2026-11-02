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

