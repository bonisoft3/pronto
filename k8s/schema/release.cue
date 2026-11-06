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
		databaseEnvironment: [..."DATABASE_URL" | "FELDERA_DATABASE_URL"]
		serviceToken: bool
		jwtSecret:    *false | bool
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
