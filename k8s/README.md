# Kubernetes Release Architecture & Cloud Parity with Kind

This directory defines the Kubernetes release pipeline for applications and services in this repository, providing high-fidelity local development via [kind](https://kind.sigs.k8s.io/) and direct parity with managed cloud clusters (**AWS EKS** and **Azure AKS**).

---

## 1. Architectural Principles & Kind Standardization

1. **Strict Cloud Parity**: A deployment on local `kind` is structurally identical to an EKS or AKS deployment. Manifests reference full OCI registry image paths, routes go through the Gateway API, and workloads pull images over the network via standard container runtime hooks.
2. **Registry-Driven Delivery**: No out-of-band side-loading (`kind load`). Images are built, tagged, and pushed to an OCI registry (`localhost:5001` locally; AWS ECR or Azure ACR in cloud), and pulled by cluster worker nodes using `imagePullPolicy: Always`.
3. **Single Local Engine Standard (Kind)**: Rather than fragmenting local validation across multiple cluster engines (K3s, Talos, Minikube), this repository standardizes strictly on upstream `kind`. Kind runs vanilla upstream Kubernetes (`kube-apiserver`, `etcd`, `kubelet`, `containerd`), eliminating artificial runtime drift while running with zero VM overhead on developer machines and headless CI runners.
4. **Hermetic, Typed Manifests via CUE**: Manifests are authored using [CUE](https://cuelang.org/) (`github.com/bonisoft3/pronto/k8s/schema`). An application defines its workload intent once (`#ReleaseSpec`). Environment bindings (`Kind`, `EKS`, `AKS`) project this intent into concrete, strictly validated Kubernetes API manifests.
5. **Declarative Cluster Lifecycle via `ctlptl`**: Local cluster and registry lifecycles are declared in [`plugins/pronto/k8s/cluster.yaml`](./cluster.yaml) and managed via [ctlptl](https://github.com/tilt-dev/ctlptl) (by Tilt / Docker). `ctlptl apply -f plugins/pronto/k8s/cluster.yaml` automatically creates or reuses the local cluster and registry without bespoke scripts.

---

## 2. Cluster Orchestration & The Containerd `certs.d` Standard

### Why `ctlptl` with Kind

Managing a local registry with Kind requires:
- Running a Docker registry container (`registry:2` on port 5001).
- Connecting the registry to the Docker bridge network shared with Kind nodes.
- Configuring containerd inside the nodes to resolve `localhost:5001` over HTTP to the registry container.
- Publishing the **KEP-1755** `local-registry-hosting` ConfigMap in `kube-public`.

**`ctlptl`** automates this entire lifecycle declaratively via [`plugins/pronto/k8s/cluster.yaml`](./cluster.yaml):
- **Create or Reuse**: `ctlptl apply -f plugins/pronto/k8s/cluster.yaml` is fully idempotent. If the cluster and registry are already running, it switches to the context and reuses them instantly (< 0.5s) without destroying existing workloads or images. If they do not exist, it creates and wires them.
- **Containerd `certs.d` Routing**: `ctlptl` uses containerd's modern directory-based registry configuration:
  ```toml
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"
  ```
  Inside every node, `/etc/containerd/certs.d/localhost:5001/hosts.toml` points to `http://kind-registry:5000`. Both host developers (`docker push localhost:5001/...`) and node kubelets (`image: localhost:5001/...`) use the **exact same image URI**.

---

## 3. Local Registry Workflow vs. Side-Loading

| Dimension | Out-of-Band Side-Loading (`kind load`) | Local Registry (`localhost:5001`) |
| :--- | :--- | :--- |
| **EKS/AKS Parity** | ❌ **Low**: Real clouds never side-load tarballs into node root filesystems. | ✅ **High**: Matches cloud CI/CD where images are pushed to a registry and pulled by kubelet. |
| **Image Pull Policy** | ❌ Requires `Never` or `IfNotPresent`. `Always` triggers `ErrImagePull`. | ✅ Supports `imagePullPolicy: Always` identically to production canary/rolling deployments. |
| **Multi-Node Clusters**| ❌ Slow: Copies the entire uncompressed docker tarball to each node container sequentially. | ✅ Fast: Nodes pull layers concurrently on demand over HTTP; shared Docker cache. |
| **Layer Caching** | ❌ Re-exports full tarballs on every load. | ✅ Standard OCI layer caching; only modified layers are pushed. |
| **Manifest Consistency** | ❌ Manifests must omit registry hosts or use artificial mock domains. | ✅ Manifests use parameterized OCI registry URIs (`\(env.registry)/\(image)`). |

---

## 4. Multi-Environment Parity Matrix

Environments project a single application `#ReleaseSpec` into platform-specific configurations:

| Dimension | Kind (`envs.Kind`) | AWS EKS (`envs.EKS`) | Azure AKS (`envs.AKS`) |
| :--- | :--- | :--- | :--- |
| **Registry URI** | `localhost:5001/<repo>:<tag>` | `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` | `<registry>.azurecr.io/<repo>:<tag>` |
| **Gateway Class** | `eg` (Envoy Gateway) | `amazon-vpc-lattice` | `azure-alb-external` |
| **Build Platform** | the builder's own | `linux/amd64` | `linux/amd64` |
| **Storage Class** | `standard` (`rancher.io/local-path`) | `gp3` (EBS CSI) | `managed-csi` (Azure Disk CSI) |
| **Image Pull Policy** | `Always` | `Always` | `Always` |
| **Domain Suffix** | `localhost` (`<app>.localhost` resolves to loopback) | `eks.internal.net` | `aks.internal.net` |

---

## 5. Directory Structure & CUE Layout

```
plugins/pronto/k8s/
├── README.md                 # Architecture, evaluation, and user reference
├── cluster.yaml              # Declarative ctlptl cluster & registry specification (Kind)
├── release.nu                # Kubernetes release engine
├── release_test.nu           # Test suite
├── schema/
│   ├── release.cue           # #ReleaseSpec and #Environment schema definitions
│   └── k8s.cue               # Manifest generator (translates spec into K8s YAML stream)
├── envs/
│   ├── kind.cue              # Kind environment configuration (local & CI)
│   ├── eks.cue               # AWS EKS environment configuration
│   └── aks.cue               # Azure AKS environment configuration
└── observability/
    └── observability.cue     # VictoriaMetrics, Jaeger, and Vector manifests

apps/<app>/
└── release.cue               # Co-located app release specification
```

---

## 6. Zero-Vendoring Operator Architecture

To maintain repo hygiene without committing megabytes of upstream CRDs and operator YAMLs, operator manifests are fetched dynamically from immutable upstream releases with **mandatory SHA256 checksum verification** (matching the Dockerfile `ADD --checksum=sha256:...` pattern).

Manifests are cached in `~/.cache/sayt/k8s/operators` and applied via `kubectl apply --server-side --force-conflicts`:

| Component | Upstream Version | Checksum (SHA256) | Role |
| :--- | :--- | :--- | :--- |
| **Gateway API CRDs** | `v1.2.1` | `97598bf6...` | Standardized Kubernetes Gateway API interfaces |
| **Envoy Gateway** | `v1.2.4` | `5554f170...` | Next-generation API Gateway with OpenTelemetry tracing |
| **CloudNativePG (CNPG)** | `v1.25.0` | `54032561...` | Declarative cloud-native PostgreSQL clusters |
| **External Secrets (ESO)** | `v0.10.5` (Helm chart) | `5cf78ad9...` | Syncs SOPS / external stores into native Kubernetes Secrets |
| **Dapr** | `v1.14.4` (Helm chart) | `97f64b80...` | Distributed application runtime with native Kubernetes secret store |

---

## 7. Observability Architecture (Option B)

Observability is implemented with zero architectural dispersion and an idle footprint under **20 MB RAM**:

- **Metrics**: VictoriaMetrics Single (`docker.io/victoriametrics/victoria-metrics:v1.106.1`, ~8 MB RAM) scrapes `/ready` and `/metrics` endpoints. Built-in web UI served at `/vmui`.
- **Distributed Tracing**: Jaeger All-in-One (`docker.io/jaegertracing/all-in-one:1.64.0`, ~9 MB RAM) receives traces over OTLP (`:4317` gRPC / `:4318` HTTP) and Zipkin (`:9411`). Built-in web UI served at `/jaeger`.
- **Logs & Agent**: Vector (`docker.io/timberio/vector:0.43.0-alpine`, ~3 MB RAM) collects internal metrics and pipeline logs.
- **Gateway Integration**: Envoy Gateway routes `/vmui` and `/jaeger` via `HTTPRoute` in the `observability` namespace.
- **Zero-Trust NetworkPolicies**: Network isolation restricts pod traffic to only explicitly declared ingress and egress routes.

---

## 8. Images and Schema

Every service runs the image the app's own compose project builds (database, migrate, crud, electric, auth, caddy, render), baked reproducibly (`SOURCE_DATE_EPOCH=0`, no provenance) so an unchanged source pushes the same digest and rolls nothing, and referenced by the tag and digest pushed. The database is mecha's database image; CloudNativePG reads its tag as the Postgres major.

The schema is built as compose builds it, by two Jobs on the app's images: `<app>-initdb` runs the database image's `/docker-entrypoint-initdb.d` once, on a fresh database (a database comment marks it built), and `<app>-migrate`, where the app has pgroll migrations, carries the schema forward on every release. The services are applied after both, so none starts on a missing schema.

---

## 9. Secrets Management Architecture

- **Authoring**: Encrypted via [SOPS](https://github.com/getsops/sops) + Age in Git (`apps/<app>/secrets.enc.yaml`).
- **Operator Bridge**: External Secrets Operator (ESO) bridges encrypted or external secrets into native Kubernetes `v1/Secret` objects. Without a `ClusterSecretStore`, ESO `Password` generators make each secret once in-cluster; no secret is a literal in a spec.
- **Database roles**: CloudNativePG sets `postgres`'s and `electric`'s passwords from basic-auth secrets (`<app>-db-postgres`, `<app>-electric-db`); the schema never sets a password.
- **Runtime Access**: Workloads and Dapr sidecars consume native Kubernetes secrets (`type: secretstores.kubernetes`).

---

## 10. Unified CLI Workflow: `sayt release@k8s`
 
The entire lifecycle—cluster reconciliation, verified operator bootstrapping, container building, local registry push, TLS secret provisioning, and manifest deployment—is automated via the Sayt `release@k8s` verb dispatched through the application's rulemap:

```bash
# 1. Full release to Kind (targeted via -d or from inside the app directory)
sayt -d apps/golaberto release@k8s

# 2. Dry-run (render evaluated CUE manifests for inspection without side effects)
sayt -d apps/golaberto release@k8s --dry-run

# 3. Render for cloud environments (AWS EKS, Azure AKS); deploying there is not
#    implemented yet: only Kind provisions operators, observability and TLS.
sayt -d apps/golaberto release@k8s --cluster-env eks --dry-run
sayt -d apps/golaberto release@k8s --cluster-env aks --dry-run

# 4. Skip operator reconciliation on repeated dev iterations
sayt -d apps/golaberto release@k8s --skip-operators
```

### Direct Script Usage

If invoking the Nushell release engine directly:

```bash
nu plugins/pronto/k8s/release.nu --app golaberto
```

### HTTPS Verification

Each app's Gateway listens on its own hostname, with a certificate from the app's pinned mkcert:

```bash
curl -sI https://golaberto.localhost/
# Traces and metrics:
open http://telemetry.localhost/jaeger/
```

### Teardown

```bash
# Delete Kind cluster and local registry
ctlptl delete -f plugins/pronto/k8s/cluster.yaml
```

