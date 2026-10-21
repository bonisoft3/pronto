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
