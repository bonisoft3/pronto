package fixture

import (
	"github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
)

App: schema.#ReleaseSpec & {name: "effects"}
kindManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
