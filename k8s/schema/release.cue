package schema

// #Environment defines the infrastructure profile for target clusters.
#Environment: {
	name:             "kind" | "eks" | "aks" | "gke"
	registry:         string
	gatewayClassName: string
	storageClass:     string
	imagePullPolicy:  "Always" | "IfNotPresent"
	domainSuffix:     string
	// Build platform for every image in a release's FROM chain; absent builds
	// for the builder's own, which is what a local Kind node runs.
	platform?: string
	// Whether the network plugin is known to hold a new pod to the
	// NetworkPolicies it has handled only after the pod starts, where
	// Kubernetes asks it to before: the release's check of the airlock's
	// wall refuses a cluster seen doing so unless this says it does, and the
	// wall there is a development one.
	policiesLate: *false | bool
	// The addresses the kubelets hand pods as their resolver, where the
	// release cannot read them from the nodes' kubelet configuration.
	resolvers?: [...=~"^[0-9a-fA-F.:]+$"]
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
		// Those the program declares for another issuer's tokens, which crud
		// tells the floor at every request; empty where none.
		declaredRoles: *[] | [...string]
	}

	// Set where the release trusts an issuer's keys (TRUSTED_JWKS): their
	// digest, which rolls crud when they change; crud then verifies by the
	// key set the release composed into <name>-trusted-keys.
	trustedKeysDigest: *"" | =~"^[0-9a-f]{64}$"
	// crud's audience, TRUSTED_AUDIENCE; empty, the origin's /crud.
	trustedAudience: *"" | string

	// The container hatches caddy's door routes to, by app id (the app's
	// .pronto/cluster.json; the release fills it). Their own workloads are not
	// deployed here.
	doors: *[] | [...=~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"]

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

	runtime: [string]: {
		env: [string]: string
		databaseEnvironment: [..."DATABASE_URL"]
		serviceToken: bool
		jwtSecret:    *false | bool
	}
	// Present where the app's compose project runs the airlock, filled by the
	// release from that project and the app's .pronto/cluster.json.
	airlock?: {
		// What compose hands the airlock beyond its database, origin, target
		// and secrets (AIRLOCK_DIR, MESH_URL, BLOB_URL, PORT).
		env: [string]: string
		// The variables an effect declares, read from the Secret
		// `<name>-airlock`, which the release writes from the release's own
		// environment and never into a manifest; the digest of their values
		// rolls the airlock when one changes.
		secrets:      *[] | [...=~"^[A-Z][A-Z0-9_]*$"]
		secretDigest: *"" | =~"^[0-9a-f]{64}$"
		// An effect reads a secret field: the airlock opens it with
		// AIRLOCK_SEAL_KEY, and AIRLOCK_SEAL_KEY_PREVIOUS through a rotation,
		// which the release writes to the same Secret from its environment
		// (mecha's services/airlock/seal.ts), and their digest is among the
		// secrets'.
		seal: *false | bool
		// Each effect's endpoint on k8s, by effect: a base URL, or null where
		// the effect names no sink this target reaches.
		endpoints: [=~"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"]: string | null
		// What compose hands the airlock's daprd that its resources read: the
		// blob plane's address, where there is one.
		meshEnv: [string]: string
		// The bridge containers deployed here, by container: the port its
		// bridges are served on, the bayt target that builds its image, and the
		// digest of the environment compose gives it, which the release writes
		// to the Secret `<name>-<container>`.
		bridges: [=~"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"]: {
			port:      int & >=1 & <=65535
			build:     string
			envDigest: *"" | =~"^[0-9a-f]{64}$"
		}
		// The cluster's own addresses as CIDRs, which the release reads from
		// the cluster: its nodes', their pod ranges and the API server's. The
		// world the daprd and the bridges reach excludes them, as it does the
		// private ranges, since any may be public.
		clusterAddresses: *[] | [...=~"^[0-9a-fA-F.:]+/[0-9]{1,3}$"]
		// The resolvers the kubelets hand pods, as CIDRs, which the release
		// reads from them: DNS goes to these and to the resolver's pods.
		resolvers: *[] | [...=~"^[0-9a-fA-F.:]+/[0-9]{1,3}$"]
	}
	// The airlock's and each bridge's: a handler or a bridge holds a call's
	// body and answer, an isolate up to 128 MiB of old space besides.
	airlockResources: {
		requests: {cpu: *"50m" | string, memory: *"128Mi" | string}
		limits:   {cpu: *"1" | string, memory: *"1Gi" | string}
	}

	runtimeStorage: *"10Gi" | string
	runtimeResources: {
		requests: {cpu: *"500m" | string, memory: *"1Gi" | string}
		limits: {cpu: *"4" | string, memory: *"8Gi" | string}
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

#GKE: {
	context: string & !=""
	environment: #Environment & {
		name:             "gke"
		registry:         string & !=""
		gatewayClassName: *"eg" | string
		storageClass:     *"standard-rwo" | string
		imagePullPolicy:  "Always"
		domainSuffix:     string & !=""
		platform:         "linux/amd64"
	}
}
