# Camel routes as container bridges

Status: superseded as the default integration design by
[[../decisions/2026-10-28-integrations|standard Activepieces pieces with Pronto state]].
That decision records the deployment/authoring tradeoff and mixed responsibilities.
The built mail contract is
[Activepieces mail](https://github.com/bonisoft3/mecha/blob/v0.22.0/pieces/mail/README.md).
The proposal below is historical; it does not describe the current mail runtime.

## Boundary

Use [[../container-bridges|container bridges]] to host integrations composed from
Apache Camel's existing components. Applications author YAML routes, properties,
and optionally reusable YAML Kamelets. No application-authored Java, custom
Quarkus extensions, inline scripts, or custom Java beans are part of this design.
Dependencies may contain Java; a pinned Quarkus build compiles the integration
into a native executable for releases.

Airlock still owns effect identity, attempts, outcomes and reentry. Its Jessie
handler calls the declared HTTP bridge through Dapr. The container does protocol
I/O. Business decisions, complex transformations, parsing and durable scheduling
stay in Pronto's existing Jessie, state machines and relational computations.
A container bridge remains an escape hatch: YAML does not confer SES confinement.
Existing component configuration and expression evaluation are privileged code.

A bridge can acknowledge a short synchronous operation directly. Long operations
acknowledge durable acceptance and callback through explicitly authorized CRUD;
the callback carries assignment identity and CDC drives further processing.
Neither Camel nor this migration grants database credentials automatically.

Kamelets package a reusable source, sink or action together with its parameters.
They are a standard Camel facility, not a Pronto DSL and not a Kubernetes-only
resource. Extract a mail Kamelet after the concrete route's contract is proven;
do not manufacture a generic wrapper before there are reusable semantics.

## Build and development

The maintained inputs are route YAML, schemas, resources, configuration and an
explicit dependency/version manifest. Pin Camel CLI, Camel core, the compatible
Camel Quarkus platform, JDK/native-image toolchain, Maven and builder images.
The build may generate a Maven project; generated Java/framework scaffolding is
not application logic. Dependency resolution must reject snapshots and drifting
versions before this becomes a release recipe.

Use native JBang installed through mise's GitHub backend as a development/build
launcher. It can invoke the Camel CLI directly; installing a separate `camel`
command is optional. A native JBang launcher does **not** make the Camel process
native. `camel run` executes routes on a JVM. It is a useful fast local feedback
loop and does not require manually exporting a project first.

Release and acceptance use one pinned Quarkus project and native compilation.
Cache the native artifact by resources, dependencies, build toolchain and target
OS/architecture. YAML loads from a runtime file against the fixed native extension
and reflection closure; route-only changes reuse the binary. Normal launch reuses
the built image.
A local JVM run is explicitly a development shortcut, not evidence that native
reflection, resources, TLS or startup work. Native acceptance must run the same
mail contract suite against the built executable.

Native Windows is a local build/test/integration target only. Windows releases
and Windows containers are outside scope. Linux release binaries must be built
for their actual architecture; an executable compiled on macOS or Windows is not
a Linux release artifact. Cloudflare Workers do not host this native container.
Docker is the initial deployment path; Kubernetes/GCP wiring and resilience are
separate work, not claims made by this migration.

## Mail decision

The HTTP and MIME contract lives in [Activepieces mail](https://github.com/bonisoft3/mecha/blob/v0.22.0/pieces/mail/README.md).
The migration retains the ledger-derived Message-ID, validated message fields,
plain/HTML/calendar alternatives and calendar attachment, actual SMTP receipts,
partial-recipient outcomes and required STARTTLS. A fixed FreeMarker template
and Camel's Base64 data format compose MIME; no Deno adapter, authored Java or
new compute RPC is needed.

The connected-address guard is deliberately dropped with the owner's approval.
The declared SMTP destination is trusted operator configuration. Container
networks do not replace the old peer-address check, and Camel does not promise
Deno's per-process network permissions. Certificate and hostname verification
remain required when STARTTLS is selected. Resilience is separate follow-up work.

## Alternatives

A bespoke Deno SMTP adapter retains a smaller runtime, but leaves each further
integration requiring another protocol implementation. Keeping it behind Camel
would add a hop without transferring SMTP ownership.

Custom Java processors and socket factories could reproduce the old guard but
violate the agreed authoring boundary. The explicit policy change avoids hiding
that implementation in YAML method calls or claiming an equivalent network guard.

An Airlock Jessie handler can prepare the message before calling the bridge if an
application needs pure business transformations. Compute currently has no
synchronous transformation RPC; adding one only for MIME would introduce another
service contract. The existing Camel components suffice for this fixed format.

Moving business logic into Camel abandons the Jessie execution boundary and
replayable application computations. Camel supplies integration components;
application decisions and durable scheduling remain in Pronto.

## Upstream evidence

* [Camel CLI](https://camel.apache.org/manual/camel-jbang.html) — local route runs and project export.
* [Kamelet authoring](https://camel.apache.org/components/4.22.x/others/kamelet-custom.html) — reusable parameterized YAML.
* [Camel Quarkus mail](https://camel.apache.org/camel-quarkus/3.40.x/reference/extensions/mail.html) — native-capable existing extension.
* [Camel 4.22.1 sender](https://github.com/apache/camel/blob/camel-4.22.1/components/camel-mail/src/main/java/org/apache/camel/component/mail/DefaultJavaMailSender.java) — connection and Message-ID preservation.
* [Camel 4.22.1 binding](https://github.com/apache/camel/blob/camel-4.22.1/components/camel-mail/src/main/java/org/apache/camel/component/mail/MailBinding.java) — MIME construction.
* [Angus SMTP properties](https://eclipse-ee4j.github.io/angus-mail/docs/api/org.eclipse.angus.mail/org/eclipse/angus/mail/smtp/package-summary.html) — TLS, success reporting and socket customization.
