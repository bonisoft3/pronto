package fixture

import (
	"github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
)

App: schema.#ReleaseSpec & {name: "unreached"}
kindManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
