# Native runtime releases

`release.nu` reads the generated Compose project and deploys the same application images for compute, Feldera, Conduit, Redis, transform, ticker, clock and blob services. A native computation must select `DUCKSTREAM_ENGINE=feldera`; the adapter refuses snapshot execution and unsupported airlock services. PostgreSQL, CRUD, authentication, Electric, Caddy and optional rendering remain the shared application stack.

Compute state and publication transactions remain in PostgreSQL. The database enables durable WAL writes and provisions 128 replication slots and senders for per-table CDC. Feldera's embedded catalog, compiler and runner directories share a persistent volume at `/home/ubuntu/.feldera`. Compute's lake and blob storage receive volumes too. Redis uses AOF with synchronous fsync. Conduit stores connector positions in PostgreSQL instead of memory. Every added runtime deployment has one replica and a Recreate strategy: release replacement must not overlap CDC writers. This trades release availability for a single writer; node fencing and backups remain cluster responsibilities.

`App.runtimeStorage` sets each runtime volume's size (default `10Gi`). `App.runtimeResources` sets runtime requests and limits (default request `500m`/`1Gi`, limit `4`/`8Gi`); compiler-heavy applications need capacity planned from their real workloads. Stateful volumes survive a deployment replacement. Deleting the namespace or its claims destroys that protection.

The adapter replaces Compose database credentials and internal service tokens with Kubernetes Secret references. It signs the internal service JWT from the deployed PostgREST key through stdin and stores it in an application Secret. Compose database passwords and internal JWTs never enter rendered manifests. HTTP services needed by Caddy join Dapr; native CDC and data-plane connections use namespaced Service DNS. Network policies restrict pipeline ingress to the app and permit its database, DNS, mesh and telemetry connections.

Kind provisions the existing operator stack and local certificate. `--dry-run` prints manifests and `--snapshot` validates rendering without applying resources. These checks do not build images or prove a live cluster rollout. The release builds and pushes every selected runtime image, applies schema jobs before services, and waits up to fifteen minutes for native startup.

GCP deployment uses [[../../gcp/docs/index]]. The existing EKS and AKS profiles still only render manifests.
