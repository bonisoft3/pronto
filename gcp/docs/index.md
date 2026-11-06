# GCP releases

A release with a `GKE` field uses the [[../../k8s/docs/index|native Kubernetes runtime]]. A release without that field retains the Cloud Run and Cloud SQL path. Feldera pipelines require GKE because their embedded catalog, compiled binaries and running pipeline state need a durable filesystem and a continuously running single writer. GKE uses CloudNativePG for application PostgreSQL; it does not provision Cloud SQL.

Declare the target in the application's `release.cue` alongside `App`:

```cue
import k8s "github.com/bonisoft3/pronto/k8s/schema"

GKE: k8s.#GKE & {
    context: "gke_PROJECT_REGION_CLUSTER"
    environment: {
        registry: "REGION-docker.pkg.dev/PROJECT/pronto"
        domainSuffix: "example.com"
    }
}
gkeManifests: (k8s.#BuildManifests & {
    release: App
    env: GKE.environment
}).manifests
```

Replace the context, registry and domain with the provisioned deployment's values. The defaults select `linux/amd64`, the `standard-rwo` storage class and an Envoy Gateway class named `eg`. The release pins a temporary kubeconfig to the named context; it never chooses whatever cluster happens to be current.

The operator must provision the GKE cluster, an Artifact Registry repository with push credentials and node pull access, CloudNativePG, External Secrets, Dapr, Gateway API and Envoy Gateway. Provision the application's namespace and TLS Secret (`<app>-tls` unless overridden), a matching GatewayClass, storage and DNS. Telemetry uses the existing `observability` namespace endpoints. The release checks CRDs, GatewayClass and TLS Secret before applying resources. Its pinned operators can be installed by the infrastructure owner; the Kind-specific host-port proxy bootstrap is not a GKE load balancer configuration.

`release@gcp --dry-run` renders the Kubernetes manifest stream without gcloud, kubectl or cloud mutations. `--snapshot` also only renders. An actual release builds and pushes immutable images and applies the declared stack to the supplied cluster. GKE has no Cloud Run preview/delete lifecycle; those flags fail. Rendering proves the manifest contract, not cloud readiness, failover, backup restoration or an executed production deployment.
