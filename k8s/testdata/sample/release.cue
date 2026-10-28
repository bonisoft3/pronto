package fixture

import (
	"github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
)

App: schema.#ReleaseSpec & {
	name: "sample"
	render: enabled: true
}

kindManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
eksManifests: (schema.#BuildManifests & {release: App, env: envs.EKS}).manifests
aksManifests: (schema.#BuildManifests & {release: App, env: envs.AKS}).manifests

// A cluster the operator runs, behind a Cloudflare Tunnel.
Metal: envs.Metal & {
	context:      "home"
	registry:     "us-central1-docker.pkg.dev/ops/pronto"
	build: project: "ops"
	ingress: id: "6ff42ae2-765d-4adf-8112-31c55c1551ef"
	domainSuffix: "apps.example.com"
}
metalManifests: (schema.#BuildManifests & {release: App, env: Metal}).manifests
