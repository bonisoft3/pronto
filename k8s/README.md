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

An app's own services, a plugin's (pronto-billing's `billing`, say), are `App.services`, as `GCP.sidecars` are on Cloud Run: `services: billing: {port: 8688, env: BILLING_BROKER: "https://…"}`. Each names a service of the compose project, built and pushed with the cluster's images, and runs as a Deployment of its own in the mesh, which the door reaches at `PRONTO_UPSTREAM_<NAME>`. Its environment is compose's under what release.cue sets, a peer compose names (`http://crud:3000`) is that peer through the mesh, and `SERVICE_JWT` is the release's own: the service role's token signed with the cluster's `PGRST_JWT_SECRET`, kept in `<app>-service-jwt`. Its network policy lets it reach the internet on 443 (a broker), which the cluster's own services cannot.

---

## 9. Timeouts and Load Shedding

Every hop has a bound, and on each path a hop's bound exceeds the one it wraps, so the innermost fails first and every caller still has time to answer. The bounds are one CUE value, `resilience` in `plugins/pronto/resilience`, whose `#Resilience` states each nesting as a constraint: a set that does not nest does not evaluate, so neither the schema, the Caddyfile nor these manifests can be emitted from it. It holds the numbers; what reads them:

| Hop | Bounds | Where |
|---|---|---|
| Gateway, by path prefix | the whole response | HTTPRoute `timeouts.request` |
| Caddy → each upstream | response headers, and a connect; Electric's stream also between reads | `import bounded-<hop>` |
| Render → its door | each read | `DOOR_TIMEOUT_MS` |
| Sidecar → each app | the whole response | Dapr `Resiliency` |
| Postgres, per token role | each statement, lock and idle transaction | the schema's `ALTER ROLE … SET` |

Defaults were measured before they were replaced: Envoy cuts every route at 15s, under Electric's 20s live hold, so every idle live poll 504'd; a 504 cancels nothing, and the query behind it ran on; and PostgREST logged in as `postgres` applied no token role's settings, since it applies only those of roles granted to its login, so it now logs in as `authenticator`.

Load is shed at the gateway, by Envoy's concurrency limits on caddy's pool: past them it answers 503 at once instead of queueing, and an Electric live read holds its slot for its hold. Dapr has no breaker: 1.14 counts any answer outside 200–399 as a failure, so clients' 401s, shapes' 409s and missing rows' 404s would open a target's circuit for every caller. No retry policy is declared, so nothing replays a write; one that timed out may still commit, which only an idempotency key settles. A value more than one emitter reads lives in a package like this one, named for what it guarantees, never in one emitter's file.

---

## 10. Secrets Management Architecture

- **Authoring**: Encrypted via [SOPS](https://github.com/getsops/sops) + Age in Git (`apps/<app>/secrets.enc.yaml`).
- **Operator Bridge**: External Secrets Operator (ESO) bridges encrypted or external secrets into native Kubernetes `v1/Secret` objects. Without a `ClusterSecretStore`, ESO `Password` generators make each secret once in-cluster; no secret is a literal in a spec.
- **Database roles**: CloudNativePG sets `postgres`'s, `electric`'s and `authenticator`'s passwords from basic-auth secrets (`<app>-db-postgres`, `<app>-electric-db`, `<app>-authenticator-db`); the schema never sets a password. Compose sets both from `ELECTRIC_PASSWORD` and `AUTHENTICATOR_PASSWORD`, through mecha's initdb step.
- **Runtime Access**: Workloads and Dapr sidecars consume native Kubernetes secrets (`type: secretstores.kubernetes`).

---

## 11. Unified CLI Workflow: `sayt release@k8s`
 
The entire lifecycle—cluster reconciliation, verified operator bootstrapping, container building, local registry push, TLS secret provisioning, and manifest deployment—is automated via the Sayt `release@k8s` verb dispatched through the application's rulemap:

```bash
# 1. Full release to Kind (targeted via -d or from inside the app directory)
sayt -d /path/to/app release@k8s

# 2. Dry-run (render evaluated CUE manifests for inspection without side effects)
sayt -d /path/to/app release@k8s --dry-run

# 3. Render for cloud environments (AWS EKS, Azure AKS); deploying there is not
#    implemented yet: only Kind and a metal cluster (section 12) provision
#    operators and observability.
sayt -d /path/to/app release@k8s --cluster-env eks --dry-run
sayt -d /path/to/app release@k8s --cluster-env aks --dry-run

# 4. Skip operator reconciliation on repeated dev iterations
sayt -d /path/to/app release@k8s --skip-operators
```

### Direct Script Usage

If invoking the Nushell release engine directly:

```bash
nu k8s/release.nu --app /path/to/app
```

### HTTPS Verification

Each app's Gateway listens on its own hostname, with a certificate from the app's pinned mkcert:

```bash
curl -sI https://my-app.localhost/
# Traces and metrics:
open http://telemetry.localhost/jaeger/
```

### Teardown

```bash
# Delete Kind cluster and local registry
ctlptl delete -f plugins/pronto/k8s/cluster.yaml
```


---

## 12. Metal: a Cluster of Your Own, Behind NAT

`envs.Metal` releases to a cluster the operator runs on their own machines —
k3s on one node at home, say — with no public address. Three things a cloud
gives stand in from elsewhere:

| A cloud's | Metal's |
| :--- | :--- |
| A load balancer with a public address | A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/): `cloudflared` in the cluster dials out, and Cloudflare serves each app's host and terminates its TLS. The gateway listens on HTTP alone. |
| A registry beside the nodes | A registry on the node, which the release runs there and which listens on the node's loopback alone (`build: {by: "node"}`, the default); or Artifact Registry, which the node pulls from with a reader's key (k3s's `registries.yaml`) |
| Building where it deploys | Docker on the machine releasing, which pushes through the release's SSH tunnel to the node's registry; or Cloud Build, as `release@gcp` builds (`gcp/build.nu`), so the machine releasing needs no Docker daemon |

The cluster, its tunnel and its registry are the operator's, made once and
shared by every app released there. An app's `release.cue` names them:

```cue
Metal: envs.Metal & {
	context: "home"                                       // the kube context
	access: ssh: "<user>@<node>"                          // the release's tunnel, to the API and the registry
	ingress: id: "<tunnel id>"
	domainSuffix: "<zone>"                                // <app>.<zone>, or App.gateway.host
	// platform: "linux/arm64"                            // for an ARM node
}
metalManifests: (schema.#BuildManifests & {release: App, env: Metal}).manifests
```

To build in Cloud Build instead, give its project and Artifact Registry
repository (and the node the reader's key below):

```cue
Metal: envs.Metal & {
	registry: "us-central1-docker.pkg.dev/<project>/pronto"
	build: {by: "cloudbuild", project: "<project>"}
}
```

`sayt release@k8s` releases there when the app gives a `Metal` (`-e kind`
still releases to Kind), and installs the operators, observability and
`cloudflared` on the first run.

### Once, for the node

```sh
# k3s, without its own ingress and load balancer: Envoy Gateway is the door.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.34.12+k3s1 sh -s - --disable traefik --disable servicelb
# The node's own registry, which the first release starts: plain HTTP on its loopback.
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<YAML
mirrors:
  "127.0.0.1:5000":
    endpoint: ["http://127.0.0.1:5000"]
YAML
sudo systemctl restart k3s
```

Building in Cloud Build instead, the node reads Artifact Registry with a
reader's key in place of the mirror above:

```sh
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<YAML
configs:
  us-central1-docker.pkg.dev:
    auth:
      username: _json_key
      password: '$(cat reader-key.json | tr -d '\n')'
YAML
sudo systemctl restart k3s
```

Copy `/etc/rancher/k3s/k3s.yaml` to the machine releasing, with `127.0.0.1`
replaced by the node's address, as the context the environment names.

### Once, for the project the images build in (Cloud Build only)

```sh
gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com --project <project>
gcloud artifacts repositories create pronto --repository-format docker --location us-central1 --project <project>
builds=$(gcloud builds get-default-service-account --project <project> --format 'value(serviceAccountEmail)' | sed 's|.*/||')
gcloud artifacts repositories add-iam-policy-binding pronto --location us-central1 --project <project> \
  --member serviceAccount:$builds --role roles/artifactregistry.writer
gcloud iam service-accounts create metal-reader --project <project>
gcloud artifacts repositories add-iam-policy-binding pronto --location us-central1 --project <project> \
  --member serviceAccount:metal-reader@<project>.iam.gserviceaccount.com --role roles/artifactregistry.reader
gcloud iam service-accounts keys create reader-key.json --iam-account metal-reader@<project>.iam.gserviceaccount.com
```

### Once, for the tunnel

```sh
cloudflared tunnel login                 # the zone the apps' hosts are in
cloudflared tunnel create home           # prints the tunnel's id
kubectl --context home create namespace cloudflared
kubectl --context home create secret generic tunnel-credentials -n cloudflared \
  --from-file=credentials.json=$HOME/.cloudflared/<id>.json
```

The tunnel carries every request to the gateway, which routes each by its
host, so a new app needs only its DNS record, which the release prints:
`cloudflared tunnel route dns <id> <host>`. No wildcard record: one would
publish `telemetry.<zone>`, the observability stack's gateway, as well.
