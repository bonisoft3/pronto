package envs

import "github.com/bonisoft3/pronto/k8s/schema"

// Kind environment definition for local development and CI testing.
Kind: schema.#Environment & {
	name:             "kind"
	registry:         "localhost:5001"
	gatewayClassName: "eg"
	storageClass:     "standard"
	imagePullPolicy: "Always"
	// Browsers and curl resolve every *.localhost name to loopback.
	domainSuffix:    "localhost"
	// kindnet lets a new pod's first connections through before its
	// policies hold it.
	policiesLate: true
}
