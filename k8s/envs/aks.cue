package envs

import "github.com/bonisoft3/pronto/k8s/schema"

// AKS environment definition targeting Azure Kubernetes Service and ACR.
AKS: schema.#Environment & {
	name:            "aks"
	registry:        *"myacr.azurecr.io" | string
	gatewayClassName: *"azure-alb-external" | string
	storageClass:     "managed-csi"
	imagePullPolicy:  "Always"
	platform:         "linux/amd64"
	domainSuffix:     *"aks.internal.net" | string
}
