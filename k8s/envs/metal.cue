package envs

import "github.com/bonisoft3/pronto/k8s/schema"

// A cluster the operator runs on their own machines, k3s on one node say,
// reached through a Cloudflare Tunnel, its images built in Cloud Build and
// pulled from Artifact Registry with a reader's key the node holds (k3s's
// registries.yaml). The app's release.cue gives what is the operator's:
// the context, the registry, the build project, the tunnel and the domain.
Metal: schema.#Environment & {
	name:             "metal"
	context:          string
	registry:         string
	build: {by: "cloudbuild", project: string}
	ingress: {by: "tunnel", id: string}
	gatewayClassName: "eg"
	// k3s's own: a directory on the node. CloudNativePG keeps its copies, and
	// its backups, itself.
	storageClass: *"local-path" | string
	// Every image is named by digest, so a node that has it runs it without
	// asking a registry that may be out of reach.
	imagePullPolicy: "IfNotPresent"
	platform:        *"linux/amd64" | "linux/arm64"
	domainSuffix:    string
}
