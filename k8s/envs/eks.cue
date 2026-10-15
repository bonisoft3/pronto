package envs

import "github.com/bonisoft3/pronto/k8s/schema"

// EKS environment definition targeting AWS Elastic Kubernetes Service and ECR.
EKS: schema.#Environment & {
	name:             "eks"
	registry:         *"123456789012.dkr.ecr.us-east-1.amazonaws.com" | string
	gatewayClassName: *"amazon-vpc-lattice" | string
	storageClass:     "gp3"
	imagePullPolicy: "Always"
	platform:        "linux/amd64"
	domainSuffix:    *"eks.internal.net" | string
}
