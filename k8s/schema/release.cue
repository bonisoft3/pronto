package schema

import (
	"regexp"
	"strconv"
	"strings"
)

// #Environment defines the infrastructure profile for target clusters.
#Environment: {
	name:             "kind" | "eks" | "aks" | "metal" | "gke"
	registry:         string
	gatewayClassName: string
	storageClass:     string
	imagePullPolicy:  "Always" | "IfNotPresent"
	domainSuffix:     string
	// Build platform for every image in a release's FROM chain; absent builds
	// for the builder's own, which is what a local Kind node runs.
	platform?: string
	// The kube context a release applies to; absent, Kind's own (cluster.yaml).
	context?: string
	// How the release reaches the context's API when it listens only on the
	// node: an SSH tunnel the release opens for its own run, to the node's
	// 6443, on a free local port its kubeconfig then names. A tunnel kept open
	// for hours was seen to stall large applies; one per release does not
	// outlive it, and is opened again if an apply through it fails.
	access?: {ssh: =~"^[^@\\s]+@[^@\\s]+$"}
	// What builds the images: Docker on the machine releasing, or Cloud Build
	// in a project of the operator's, which pushes them to `registry` (an
	// Artifact Registry repository the cluster pulls from), so the machine
	// releasing needs no Docker daemon. `node` builds with Docker on the machine
	// releasing too, but pushes through the release's SSH tunnel (`access`) to a
	// registry on the node itself, listening on its loopback alone, which the
	// node pulls from: no cloud between the build and the cluster. `buildkit`
	// needs no Docker daemon and no SSH: the node's own buildkitd builds, on its
	// loopback alone, reached through the cluster's API (a port-forward), and
	// pushes to the same registry. Studio's builder, which has neither, builds so.
	build: *{by: "docker"} | {by: "cloudbuild", project: string} | {by: "node"} | {by: "buildkit"}
	if build.by == "node" {
		access: ssh: _
		registry: "127.0.0.1:5000"
	}
	if build.by == "buildkit" {
		registry: "127.0.0.1:5000"
	}
	// How requests reach the gateway: the node's host ports 80 and 443 (Kind),
	// or a Cloudflare Tunnel the cluster dials out through, for a cluster
	// behind NAT. Cloudflare terminates TLS there, so the gateway listens on
	// HTTP alone, and each app's host is a DNS record onto the tunnel.
	ingress: *{by: "hostPort"} | {by: "tunnel", id: =~"^[0-9a-f-]{36}$"}
	// Dapr's control plane in HA mode (global.ha.enabled): operator, sentry and injector at 3 with
	// their PodDisruptionBudgets, placement at 3 on volumes of the cluster's default class (raft
	// needs 3), the scheduler at 3 as always. While the injector or sentry is down new pods start
	// without their sidecar and every app's release refuses them, so on a cluster that runs the
	// apps' production one Dapr pod must not be all there is (PRONTO-360): on by default on metal,
	// off elsewhere unless set. Dapr is the cluster's,
	// shared by every app: once a release finds it in HA, it keeps it so, whatever its own says.
	dapr: ha: bool | *(name == "metal")
	// The replicas of each operator's controllers (Envoy Gateway, CloudNativePG, the barman-cloud
	// plugin, External Secrets, cert-manager), set by the release after each install: leader-elected,
	// so two is n+1. On by default on metal, which runs the apps' production (PRONTO-361).
	controllers: int & >=1 | *[if name == "metal" {2}, 1][0]
}

// #ReleaseSpec defines a Pronto application workload intent independent of the target cluster.
#ReleaseSpec: {
	name:      =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
	namespace: string | *name

	// A preview (`release@k8s --preview=<name>`): the release's whole stack in a namespace of its own beside
	// the released one, to prove its images, migrations and config on the cluster before traffic moves. It is
	// the same release under another name: `id` is what every object on the cluster is called (the release's
	// name, a preview's `<name>-<preview>`) and `ns` the namespace it lives in (the release's, a preview's `id`).
	// A preview claims no public name (no tunnel route or DNS: it is reached through `kubectl port-forward`)
	// and takes no backups.
	preview: *"" | =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
	id:      [if preview != "" {"\(name)-\(preview)"}, name][0]
	// A tenant's release (`release@k8s --tenant=<namespace>`): the release, under its own name, in a
	// namespace someone else made and gave a publisher's rights to (Studio's owners, PRONTO-130). It
	// makes no namespace and nothing outside that one, so it is never a preview too.
	tenant: *"" | =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
	if tenant != "" {preview: ""}
	// The one address the tenant's namespace was given (`--host`), over the app's own gateway.host, which
	// names where its author releases it: a tenant's gateway may answer only for what it was given.
	tenantHost: *"" | =~"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$"
	ns: [if preview != "" {id}, if tenant != "" {tenant}, namespace][0]
	// Where a preview is reached and says it is: the door's port-forwarded port on the machine releasing
	// (the services' ORIGIN, and a passkey's relying party, localhost); or https, when a local TLS front
	// (Caddy's `tls internal`) stands before that forward, so a browser speaks HTTP/2 to it and its
	// live sync requests do not take all six of HTTP/1.1's connections to one host.
	previewOrigin: *"http://localhost:18080" | =~"^https?://localhost:[0-9]+$"

	type: "pronto" | *"pronto"

	image: {
		tag:        string | *"latest"
		// Filled by the release from what it pushed, so a deployment names the
		// exact image. CloudNativePG refuses `latest` and a bare digest: it reads
		// the database's tag as the Postgres major version.
		pushed: [string]: {tag: string, digest: =~"^sha256:[0-9a-f]{64}$"}
	}

	// How many pods of each workload run: `replicas` of every one, a workload's own in `scale` by its
	// name (crud, electric, auth, caddy, render, rclone-s3, imgproxy, or one of the app's services), as
	// containerResources is. A preview (the rc, the release under another name) runs `previewReplicas`,
	// or a workload's own `preview`, never more than the release runs of it: n+1 for one, so it
	// rehearses losing a pod and both stacks fit the node (PRONTO-359). A workload over one pod gets a
	// PodDisruptionBudget of all but one, and spreads over the nodes by hostname where it can
	// (ScheduleAnyway): on one node it schedules as before, and spreads the day more exist.
	replicas:        int & >=1 | *1
	previewReplicas: int & >=1 | *replicas
	scale: [=~"^[a-z][a-z0-9-]*$"]: {
		replicas?: int & >=1
		preview?:  int & >=1
	}

	// Electric's connection pool per pod (ELECTRIC_DB_POOL_SIZE; Electric's own default is 20): each of
	// `replicas` pods holds that many Postgres connections, and a rollout runs old and new pods side by
	// side, so 3 pods at 20 held 63 of CloudNativePG's 97 usable and a rollout's surge ran the database
	// out ("too many clients already", PRONTO-475).
	electric: pool: int & >=2 & <=40 | *8

	env:     *{} | {[string]: string}
	externalSecrets: {
		enabled:        bool | *false
		secretStoreRef: string | *"cluster-secrets"
	}

	database: {
		// The database's volume. An app states it (PRONTO-363): every slot's WAL cap is a share of it.
		storage: *"1Gi" | =~"^[1-9][0-9]*(Mi|Gi|Ti)$"
		let sizeOf = regexp.FindSubmatch("^([0-9]+)(Mi|Gi|Ti)$", storage)
		// The most WAL a replication slot may hold, in MB (Postgres's max_slot_wal_keep_size): a
		// replica that hangs while still connected (an Electric, a standby) keeps its slot and the WAL
		// behind it, and past this the slot is given up rather than the disk filled. A quarter of the
		// volume.
		slotWalKeepMB: int & >=64 | *div(strconv.Atoi(sizeOf[1])*{Mi: 1, Gi: 1024, Ti: 1048576}[sizeOf[2]], 4)
		// CloudNativePG's instances: one primary and instances-1 standbys, for which the operator
		// keeps a PodDisruptionBudget itself. A preview runs as many.
		instances: int & >=1 | *1
		// With standbys (instances over one), CloudNativePG's quorum-based synchronous replication:
		// a commit waits for `number` standbys (`method` any of them, or the first in order), and a
		// primary that has lost them keeps accepting writes under `dataDurability` "preferred"
		// rather than stalling ("required"). One instance renders none of it, as before (PRONTO-365).
		synchronous: {
			method:         *"any" | "first"
			number:         int & >=1 | *1
			dataDurability: *"preferred" | "required"
		}
		// Replication slots for the standbys, kept on every instance, so a standby promoted to
		// primary still holds the others' (CloudNativePG's replicationSlots.highAvailability).
		haSlots: bool | *(instances > 1)
		// CloudNativePG's own PodDisruptionBudgets (its default, on). With one instance a budget
		// blocks a drain: docs/move-to-contabo.md's drains pass --disable-eviction.
		enablePDB: bool | *true
		// Postgres parameters of the app's own over CloudNativePG's (max_slot_wal_keep_size, say).
		parameters: [string]: string
		// The roles a token may name, which the schema grants PostgREST's login
		// (the app's .pronto/cluster.json; the release fills it).
		tokenRoles: [...string]
		// Roles of its own a service connects as (a service's `database.login`), each a LOGIN role
		// whose password the cluster generates in its namespace and no file ever holds.
		logins: [=~"^[a-z][a-z0-9_]*$"]: {
			// Roles the operator keeps it a member of (it revokes any it is not told of): the app's
			// own migrations create them, so the login reads what they grant.
			inRoles: [...string]
		}
		// The app's own migrations (services/database/migrations' raw SQL, each idempotent),
		// replayed over a database initdb already built, as on Cloud Run (.pronto/cluster.json;
		// the release fills it).
		replays: *[] | [...=~"^[0-9A-Za-z_.-]+\\.sql$"]
		// Where its base backups and WAL go, through CloudNativePG's barman-cloud plugin: WAL as
		// each segment fills, a base backup on `schedule` (six fields, UTC) and once when the
		// Cluster first gets it, kept `retention` (CloudNativePG's form, 30d say). One of two stores:
		// - An S3-compatible bucket at `endpoint`, whose keys are a Secret the operator keeps in the
		//   app's namespace, ACCESS_KEY_ID and ACCESS_SECRET_KEY: the release refuses to start without it.
		// - A Cloud Storage bucket, `provider` set, no key: the database pod's projected token
		//   (audience `audience`) is traded at that workload identity provider for `serviceAccount`'s,
		//   as blobs' and the metrics export's are; the provider admits the subject
		//   system:serviceaccount:<namespace>:<name>-db, and the account may write the bucket.
		backup?: {
			bucket!:   =~"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$"
			path:      =~"^[a-z0-9][a-z0-9/_.-]*$" | *name
			retention: =~"^[1-9][0-9]*[dwm]$" | *"30d"
			schedule:  string | *"0 0 6 * * *"
			endpoint?: =~"^https://"
			provider?: =~"^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$"
			// Never both: k8s.cue's ObjectStore then has no destination, which the export refuses.
			if endpoint != _|_ {
				secret:    =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" | *"\(name)-backup-s3"
			}
			if endpoint == _|_ {
				provider!:       _
				serviceAccount!: =~"^[a-z0-9-]+@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com$"
				audience:        string | *"https://iam.googleapis.com/\(provider)"
			}
		}
	}

	// The container hatches caddy's door routes to, by app id (the app's
	// .pronto/cluster.json; the release fills it). Their own workloads are not
	// deployed here.
	doors: *[] | [...=~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"]

	// Present where the app's compose project has a migrate service: the
	// environment compose gives it beyond its DATABASE_URL (REQUIRED_TABLES),
	// filled by the release from that project.
	migrate?: env: [string]: string

	auth: {
		rpId?:   string
		origin?: string
		// The providers the auth service signs in through, and each one's
		// client, as the app's compose project gives them: filled by the
		// release, which fails there when a provider's client is unset.
		oidc: *{} | {[=~"^OIDC_[A-Z0-9_]+$" & !~"_CLIENT_SECRET$"]: string}
		oidcSecrets: *[] | [...=~"^OIDC_[A-Z0-9_]+_CLIENT_SECRET$"]
		oidcSecretDigest: *"" | =~"^[0-9a-f]{64}$"
		// The SHA-256 fingerprints of the app's Android release certificates,
		// comma-separated, as compose gives auth WEBAUTHN_ANDROID_ORIGINS.
		android: *"" | string
		// The app's gate over its API keys (capabilities.auth.apiKeysGate), as
		// compose gives auth AUTH_API_KEYS_GATE: named, keys are on and the
		// gate answers for each request, so its flag decides.
		apiKeysGate: *"" | =~"^[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*$"
		// The app's hook on a key's exchange (capabilities.auth.keyExchanged), as
		// compose gives auth AUTH_KEY_EXCHANGED_HOOK: auth calls it with the key's
		// owner before it signs the token. It does not turn keys on.
		keyExchanged: *"" | =~"^[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*$"
	}

	runtime: [string]: {
		env: [string]: string
		databaseEnvironment: [..."DATABASE_URL" | "FELDERA_DATABASE_URL"]
		serviceToken: bool
		jwtSecret:    *false | bool
		// The airlock's: the variables an effect reads as a secret, each from airlock.secrets.
		secrets: *[] | [...=~"^[A-Z][A-Z0-9_]*$"]
	}
	// Where the airlock's secrets live (the app's effects' `secrets`), by variable: a Secret the
	// operator keeps in the app's namespace, holding it under the variable's name. A variable the
	// effects read and this does not name fails the release; a Secret not there fails it too, before
	// anything rolls (check-airlock-secrets).
	airlock: secrets: [=~"^[A-Z][A-Z0-9_]*$"]: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
	// Each effect's sink on this target, by effect (the app's .pronto/cluster.json k8sSinks; the
	// release fills it): an https origin (mecha's #Origin), or a Service of this cluster over plain
	// HTTP (pronto's #InClusterSink). They become the airlock's daprd's HTTPEndpoints and its only
	// egress past DNS (runtime.cue).
	airlock: sinks: [=~"^[a-z][a-z0-9-]*$"]: {
		origin?: =~"^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:[0-9]{1,5})?$"
		service?: {
			name:       =~"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"
			namespace:  =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
			port:       int & >=1 & <=65535
			targetPort: int & >=1 & <=65535
			path?:      =~"^(/[A-Za-z0-9._~-]+)+$"
			podSelector?: [string]: string
		}
		_one: (len([if origin != _|_ {1}]) + len([if service != _|_ {1}])) & 1
	}
	// An in-cluster sink is called over plain HTTP: the credential header and the body cross the
	// network in cleartext unless a service mesh's sidecars encrypt them (networkPolicy.
	// meshControlPlane). Without one, the release states it knows (`plaintext: true`).
	airlock: plaintext: *false | bool
	_inCluster: [for n, s in airlock.sinks if s.service != _|_ {n}]
	_encrypted: [
		if len(_inCluster) == 0 || networkPolicy.meshControlPlane != _|_ || airlock.plaintext {true},
		"effects \(strings.Join(_inCluster, ", ")) reach in-cluster services over plain HTTP, their credential and body in cleartext: set networkPolicy.meshControlPlane where a service mesh's sidecars encrypt them, or airlock.plaintext: true",
	][0] & true
	// The egress to an in-cluster sink admits its namespace, or its podSelector's pods there. Never
	// kube-system's nor the service mesh's control plane's; the app's own only through a podSelector.
	_insiders: [for n, s in airlock.sinks if s.service != _|_
		let pods = *s.service.podSelector | {}
		if s.service.namespace == "kube-system" ||
			(networkPolicy.meshControlPlane != _|_ && s.service.namespace == networkPolicy.meshControlPlane.namespace) ||
			(s.service.namespace == ns && len(pods) == 0) {"\(n) (\(s.service.namespace))"}]
	_outside: [
		if len(_insiders) == 0 {true},
		"effects \(strings.Join(_insiders, ", ")) reach a service in kube-system, the service mesh's control plane or, without a podSelector, the app's own namespace, which the airlock's daprd may not reach whole",
	][0] & true
	_unsecured: [for _, r in runtime for k in r.secrets if airlock.secrets[k] == _|_ {k}]
	_secured: [
		if len(_unsecured) == 0 {true},
		"the app's effects read \(strings.Join(_unsecured, ", ")), which airlock.secrets does not name: name the Secret holding each",
	][0] & true
	// The airlock's network policies are its walls (runtime.cue): without them nothing keeps it to its
	// daprd, nor its daprd to the declared sinks.
	_walled: [
		if runtime.airlock == _|_ || networkPolicy.enabled {true},
		"the app declares effects and networkPolicy.enabled is false: the airlock runs only behind its network policies",
	][0] & true
	runtimeStorage: *"10Gi" | string
	runtimeResources: {
		requests: {cpu: *"500m" | string, memory: *"1Gi" | string}
		limits: {cpu: *"4" | string, memory: *"8Gi" | string}
	}

	render: {
		enabled: bool | *false
		port:    int | *8090
		// The path render's readiness probe asks (PRONTO-452). Render's own /ready (omnishell 0.23.0-fork.13 and
		// after: tables synced and the door answering, PRONTO-451) is what a release is rolled out on; a render
		// built on an older omnishell serves /health alone, answers /ready 404 and is never Ready, so the rollout
		// waits for ever. An app whose render runtime is older says "/health", the probe a release made before
		// PRONTO-451 had.
		ready: string & =~"^/" | *"/ready"
	}

	// Services of the app's own beside the cluster's, a plugin's (pronto-billing's
	// billing, say), as GCP.sidecars are on Cloud Run: each names a service of the
	// app's compose project, built and pushed as the cluster's images are, a
	// Deployment of its own in the mesh, reached by the door at
	// PRONTO_UPSTREAM_<NAME>. Its environment is compose's, filled by the release,
	// under what release.cue sets (a broker's production address, where compose
	// names a developer's machine); a peer compose names (http://crud:3000) is that
	// peer through the mesh, SERVICE_JWT the release's own (<name>-service-jwt),
	// and ORIGIN where readers are. It may reach the internet on 443 (a broker).
	let declared = database.logins
	services: [=~"^[a-z][a-z0-9-]*$"]: {
		port!: int & >1024 & <65536
		// Its health route on `port`, which its readiness probe asks (PRONTO-367): ready then means
		// serving. Without one, ready means its port accepts connections.
		health?: =~"^/"
		env: [=~"^[A-Z_][A-Z0-9_]*$"]: string
		// Variables read from a Secret the operator keeps in the app's namespace, each under its
		// variable's name (a sender's VAPID key): the pod does not start until it is there.
		secrets: [=~"^[A-Z_][A-Z0-9_]*$"]: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
		// Files read from a ConfigMap in the app's namespace, mounted read-only at each directory,
		// its keys the file names (flagd's live flags, which pronto-flags push writes): the pod does
		// not start until it is there, and a change reaches the files in about a minute.
		files: [=~"^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$"]: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
		// What a ConfigMap of files is made from when it is not there yet, by name: a file of the app,
		// its key the file's name (flagd's flags as generate wrote them). Once, on the release that
		// finds it missing; a release never writes over one that exists (pronto-flags push owns it).
		seed: [=~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"]: =~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$"
		// A public hostname of the service's own, answered by it straight from the gateway, not through
		// the door: an operator's broker (billing.example.com, id.example.com), which the open internet
		// and Stripe's webhook call by that name. The gateway listens for it on HTTP, as behind a tunnel,
		// where Cloudflare holds the certificate and the name is a DNS record onto the tunnel.
		host?: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$"
		// Connect to the app's own database as one of database.logins, its URL in the variable `env`
		// (an exporter's SQLEXPORTER_TARGET_DSN): read from the login's Secret, over compose's value.
		// A login the app does not declare fails the release.
		database?: {
			login!: or([for l, _ in declared {l}])
			env:    =~"^[A-Z_][A-Z0-9_]*$" | *"DATABASE_URL"
		}
		// Where the service exports Prometheus metrics (a collector's journey_runs_total, which the
		// alerting rules read), scraped by the cluster's VictoriaMetrics as gcp's gmp-collector does.
		metrics?: {
			port!: int & >1024 & <65536
			path:  *"/metrics" | =~"^/"
		}
		// A clock that pokes the service: a CronJob POSTing to `path` on its port each `schedule`
		// (five fields, UTC), with the service role's token as its bearer, as Cloud Scheduler pokes
		// mecha's ticker on Cloud Run (gcp.cue's clock). A missed minute is the next one's: no retry.
		clock?: {
			schedule: string | *"* * * * *"
			path:     =~"^/" | *"/poke"
		}
		// A service that runs others' code in a bubblewrap jail of its own (Studio's builder): its pod
		// in a user namespace of its own (hostUsers: false, its root no one on the node), a /proc the
		// jail can mount afresh (procMount Unmasked), and AppArmor and seccomp unconfined, since a node
		// that restricts unprivileged user namespaces (Ubuntu's apparmor_restrict_unprivileged_userns)
		// and the runtime's default seccomp refuse the jail's own namespaces. Each less fails bwrap
		// (measured on the Contabo node, 2026-11-09).
		jail: bool | *false
		// A Google identity of the service's own, with no key, as blobs and metricsExport have: its pod
		// runs as the service account <name>-<service>, whose projected token (`audience`) is at
		// /var/run/secrets/gcp/token, for the service to trade at the workload identity `provider` for
		// `serviceAccount`'s. The token's subject is system:serviceaccount:<namespace>:<name>-<service>.
		google?: {
			provider!:       =~"^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$"
			serviceAccount!: =~"^[a-z0-9-]+@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com$"
			audience:        string | *"https://iam.googleapis.com/\(provider)"
		}
		// Where the service may connect beyond the services' own policy (the mesh, and the internet on
		// 443 while networkPolicy.internet is "open"): each an address block, what it leaves out, and a
		// port (the node's API server for a service that provisions namespaces, the internet on 80 for a
		// proxy). Under networkPolicy.internet "airlock", an entry past the private ranges is a direct
		// call around the airlock and says why it is one (`why`), or the release does not vet.
		egress: [...{
			cidr!:  =~"^[0-9.]+/[0-9]+$"
			except: [...=~"^[0-9.]+/[0-9]+$"]
			port!:  int & >0 & <65536
			why?:   string & !=""
		}]
		// Folders of the pod's own, empty at each start, by path, with the most each may hold (a
		// builder's workspace: clones, toolchains, a game's checks).
		scratch: [=~"^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$"]: =~"^[0-9]+(Mi|Gi)$"
	}


	// The app's alerting rules, each a file of the app in vmalert's (Prometheus's) format: pronto-journeys'
	// burn rates, pronto-perf's. A vmalert of the app's own evaluates them against the cluster's
	// VictoriaMetrics, as Cloud Monitoring does on gcp. A firing alert goes to `notifier` (an
	// Alertmanager) where one is named; without one it is kept as the ALERTS series in VictoriaMetrics,
	// which a probe or a dashboard reads. The release writes the files to <name>-alert-rules each run,
	// and vmalert reads a change within a minute.
	alerting: {
		rules: [...=~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*\\.ya?ml$"]
		notifier?: =~"^https?://[^ ]+$"
	}

	// The services' metrics (services.<n>.metrics) sent on to Google Cloud Monitoring's Managed Service
	// for Prometheus, where Cloud Run's sidecars send theirs, so one set of burn-rate policies reads both:
	// an OpenTelemetry collector of the app's own scrapes them and writes them as `project`'s
	// prometheus.googleapis.com series, under `location` and `cluster`. It signs in with no key: its
	// service account's token, which this cluster signs, is traded at a workload identity `provider`
	// that trusts the cluster's issuer (its JWKS uploaded) for `serviceAccount`'s, which may write
	// metrics. The token's subject is system:serviceaccount:<namespace>:<name>-metrics-export.
	metricsExport?: {
		project!:        =~"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"
		provider!:       =~"^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$"
		serviceAccount!: =~"^[a-z0-9-]+@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com$"
		audience:        string | *"https://iam.googleapis.com/\(provider)"
		location:        string | *"europe-west3"
		cluster:         string | *"metal"
		interval:        =~"^[0-9]+s$" | *"30s"
	}

	// The blob plane mecha's profile pictures live on (the door's /blobs and /img): rclone serving the
	// Cloud Storage `bucket` as the S3 bucket every app names, and imgproxy over it, in the mesh as
	// the app-ids rclone-s3 and imgproxy, built from the app's compose services of those names. rclone
	// signs in with no key, as the metrics export does: the token of the service account
	// <name>-blobs, whose subject is system:serviceaccount:<namespace>:<name>-blobs, is traded at the
	// workload identity `provider` for `serviceAccount`'s, which may read and write the bucket.
	blobs?: {
		bucket!:         =~"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$"
		provider!:       =~"^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$"
		serviceAccount!: =~"^[a-z0-9-]+@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com$"
		audience:        string | *"https://iam.googleapis.com/\(provider)"
	}

	// A container's own requests and limits over `resources`, by its name: crud, electric, auth,
	// caddy, render, or one of the app's services. An Electric holding a shape per player and
	// table needs more memory than a door (Bonk Chess's was OOMKilled at 256Mi, 2026-11-06).
	containerResources: [string]: {
		requests?: {cpu?: string, memory?: string}
		limits?: {cpu?: string, memory?: string}
	}

	resources: {
		requests: {
			cpu:    string | *"50m"
			memory: string | *"64Mi"
		}
		limits: {
			cpu:    string | *"500m"
			memory: string | *"256Mi"
		}
	}

	gateway: {
		enabled: bool | *true
		host?:   string
		tls: {
			enabled:    bool | *true
			secretName?: string
		}
	}

	networkPolicy: {
		enabled: bool | *true
		// What the app's services reach on the internet (PRONTO-220, PRONTO-135: every external call
		// goes through the airlock). "open", the default, lets each of them out on 443, as before.
		// "airlock" lets none of them out: an external call is the airlock's, a declared effect it
		// performs and records, and a new direct call is refused on the node. What stays: auth's
		// provider sign-in (auth.oidc), the blob plane's storage (blobs), the door's upstreams (declared
		// in the program's caddy blocks), and a service's egress entry that says `why`; an entry past
		// the private ranges without one fails the release's vet, so a pull request adding one fails
		// its gate.
		internet: *"open" | "airlock"
		// A service mesh whose sidecars run in the airlock's two pods (Istio's, say) needs its control
		// plane, which the airlock's walls otherwise shut: each pod then also reaches `ports` in
		// `namespace`. Absent, they reach no mesh. Sidecar mode with STRICT mTLS: an ambient mesh's node
		// proxies would need other rules, and PERMISSIVE leaves an in-cluster sink's traffic in cleartext.
		meshControlPlane?: {
			namespace: =~"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" | *"istio-system"
			ports: [int & >=1 & <=65535, ...int & >=1 & <=65535] | *[15012]
		}
	}

	// Each egress entry that reaches past the private ranges with no `why`, under "airlock".
	_directCalls: [
		for n, s in services for e in s.egress
		if networkPolicy.internet == "airlock"
		if e.why == _|_
		if e.cidr !~ "^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)" {
			"services.\(n).egress \(e.cidr) port \(e.port)"
		},
	]
	_noDirectCalls: [
		if len(_directCalls) == 0 {true},
		"networkPolicy.internet is airlock, and these reach the internet around it without a why: \(strings.Join(_directCalls, ", "))",
	][0] & true
}

#GKE: {
	context: string & !=""
	environment: #Environment & {
		name:             "gke"
		registry:         string & !=""
		gatewayClassName: *"eg" | string
		storageClass:     *"standard-rwo" | string
		imagePullPolicy:  "Always"
		domainSuffix:     string & !=""
		platform:         "linux/amd64"
	}
}
