# Integrations through standard pieces and Pronto state

Status: partially built. The container action host and standard SMTP mail piece are
implemented and tested locally. Standard trigger hosting has a completed spike;
the general production trigger host and lifecycle reconciliation remain implementation
work. Snapcards adds an application-specific edge payment adapter; it is an
explicit exception described below, not the shared trigger host. The
[[../activepieces-hatches|action reference]] describes the built generic contract;
this decision describes its intended extension.

## Decision

Use standard Activepieces pieces for provider operations, selected explicitly in
an application's hatch declaration. Pronto supplies the host and owns durable
application processing. A piece is an action/trigger library, not the application's
business workflow. Do not introduce a separately authored integration registry or
require every application to implement the provider's protocol again.

Both pinned catalogue packages and local packages exporting normal Activepieces
pieces are supported extension units. A local piece needs no upstream contribution
or publication. A first-party piece follows the same contract and opt-in path as an
application-authored piece. Package selection, exposed operations, contracts,
configuration and credential references belong to the hatch.

A bridge is the addressing role through which an effect calls a hatch. It does not
add trust, database authority or a callback permission. The generic container
mechanism remains available for acquisition code such as Crawlee or a native TLS
helper whose runtime cannot be expressed by a standard piece. See
[[../container-bridges|container bridges]].

## Why Activepieces replaced Camel

Camel's route DSL and mature component catalogue made it a credible integration
runtime, especially for SMTP, FTP and legacy protocols. The rejected
[[../archive/2026-10-28-camel-bridges|Camel design]] could compose integrations without
application-authored Java. Its weakness here was deployment and extension cost:

- A native JBang launcher still launches JVM Camel routes. Native release execution
  instead required the Camel CLI, a generated Quarkus project, Maven, GraalVM/native
  compilation, and a target-specific extension/resource closure.
- That Linux/native container path did not provide a browser or Cloudflare Worker
  implementation. Local JVM success did not prove the native artifact worked.
- New custom behavior would lead toward Java processors/extensions or an additional
  external adapter, while Pronto already uses JavaScript and Deno for trusted hatches.
- The intended value was the catalogue and provider lifecycle. We did not want a
  second route language to take over application decisions, scheduling and state.

Activepieces gives us a standard TypeScript/JavaScript package boundary and a SaaS
catalogue, including custom pieces authored with its public SDK. This is a better
fit for the existing build and authoring environment. It does not mean every piece
runs in browsers or Workers: dependency and runtime capabilities still need to be
qualified. Camel remains a possible implementation of a specific container hatch;
it is no longer the default integration framework.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Application CUE | Select packages, action/trigger aliases, schemas, target behavior, configuration and secret references |
| Activepieces piece | Provider request construction, protocol calls, registration hooks, polling/filtering and provider result interpretation |
| Pronto host | Context capabilities, credential delivery, limits, lifecycle execution, deployment and operation admission |
| Verified ingress | Preserve raw callback data, authenticate its origin, constrain destination and record durable acceptance |
| Durable store/outbox | Commit trigger checkpoints with emitted events, serialize each trigger and retain pending delivery |
| Airlock | Outbound effect identity, attempts, outcomes and explicit reentry policy |
| Jessie and machines | Pure transformations, business validation, state transitions and the decision to request another effect |
| CDC / relational computations | Drive application processing from accepted rows; no application polling for bridge completion |

An integration result is external evidence, not authority to change arbitrary
application state. A valid payment callback must still match the intended order,
amount, currency and environment. The application decides whether fulfillment is
permitted. A piece may return a provider rejection as structured data; the handler
interprets it without turning transport uncertainty into permanent business failure.

Package code is a trusted hatch, not Jessie-confined code. It can use its granted
network authority and supplied credentials. Selecting an alias restricts exposure
but does not isolate package code from other code in the same execution boundary.

## Inbound and outbound paths

```text
Provider webhook or scheduled acquisition
  → verified ingress / selected standard trigger
  → durable event acceptance and checkpoint/outbox commit
  → CDC → Jessie / application machine
  → Airlock effect → selected standard action → provider
```

The exact ordering of raw ingress persistence and trigger processing must preserve
authentication and durable acceptance: no success acknowledgement before work has a
durable owner. Store raw bodies and relevant headers where verification/replay needs
them, with explicit access and retention. Acknowledgement is acceptance, not proof
that the application has completed its processing.

Standard trigger hooks include enable, disable and execution, with a webhook URL,
properties, auth and persistent store. Polling triggers are legitimate acquisition
adapters when the provider lacks callbacks. Their schedule stays on the acquisition
side; they deliver accepted events into Pronto rather than making the application
poll a remote job status. Renewal and handshake capabilities require real host
services before a trigger using them is admitted.

Buffer checkpoint writes during a trigger run and commit them atomically with its
emitted event outbox. A fresh run must not skip events because the previous run
advanced a cursor before its results were recorded. Serialize invocations of the
same trigger. This transaction cannot undo webhook registration at a provider;
registration needs reconciliation after failures between the external side effect
and local persistence.

Durable receipt identity and business identity are separate. Deduplicating a webhook
delivery does not guarantee that two different provider events cannot refer to the
same payment. Application transitions and effect identities must prevent repeated
fulfillment. Delivery is at least once where retries are used; do not promise
exactly-once external effects.

## Why not host the entire Activepieces workflow service

The full service supplies queues, workers, polling schedules, connection management
and execution of JSON flows. That is useful, but duplicates durable orchestration
Pronto already owns and adds its own PostgreSQL/Redis/worker deployment. Importing
its engine package alone does not bring those surrounding services.

The trigger spike ran unchanged pinned
Stripe, GitHub and RSS triggers through one provider-independent host. It supports
implementing common context capabilities once rather than adapting every provider.
It also exposed limits the full engine does not automatically repair:

- The inspected Stripe and GitHub webhook triggers do not verify provider signatures;
  the generic engine verification path applies to a different trigger strategy.
- Stripe's Checkout trigger emits an unpaid session as well as a paid one.
- RSS eagerly persists its checkpoint before returning events. Separate checkpoint
  and event-admission operations expose a lost-event failure window.
- A successful external registration followed by failed local persistence can leave
  an orphan registration and create another on retry.

The spike's six tests use real npm packages and mocked HTTP. Its snapshot store
models a transaction boundary; it is not a production database, killed-process or
power-loss test. The full upstream runtime was source-audited, not deployed. These
results justify a bounded host, not a claim of complete catalogue coverage.

## Admission is per operation and target

Most of the reuse should come from a shared host: supporting persistent store or
webhook lifecycle once should unlock multiple pieces. The unit of qualification is
the selected pinned action/trigger and its dependency closure. One piece can contain
both a simple HTTP action and an operation requiring files, OAuth refresh or native
libraries. An unsupported exported operation need not prevent selecting a supported
one.

Admission covers inputs/defaults, output/auth shape, runtime dependencies, external
retries, secret handling, signature verification, event identity and failure paths.
An unknown context capability fails explicitly. Do not fabricate an empty store,
pretend a webhook was registered, or admit code solely because a happy-path call
returned JSON. A local standard piece or verified-ingress adapter may close a
provider-specific gap; that is an exception, not a new runner per provider.

OAuth login identifies the user to whom a connection belongs. Calling a provider on
that user's behalf additionally requires consent/scopes, token storage and refresh.
Reuse the identity infrastructure where applicable; a Kratos session alone is not
an integration token service. Those context capabilities remain outside the current
action-only host.

## Explicit behavior on each target

Each declared integration/target combination selects live, simulated or unavailable
behavior. This is a design contract; it is not yet a generic compiler feature.

| Selection | Required configuration and behavior |
| --- | --- |
| Live | Compatible implementation, credentials/public identifiers and provider constraints; missing required declarations fail CUE unification |
| Simulated | Explicit mock/scenario; outcomes and callbacks exercise the application's ordinary state path and are visibly marked simulated |
| Unavailable/degraded | Explicit reason and visible failure or defined limited behavior; never report an external success that did not happen |

Pages is a demo target. It can simulate checkout, payment callbacks and messaging,
or fail clearly when a capability is unavailable. MSW can intercept browser requests
and simulate provider responses/events; it does not expose a publicly reachable
webhook server. A browser service worker cannot hide a merchant secret or become an
authoritative source for real payment confirmation. Cloudflare Workers can own
server-side credentials and callbacks; container-only dependencies still need a
compatible host or an explicitly selected remote service.

Mail illustrates conditional requirements:

- Live Pages EmailJS requires public key, service ID and template ID. Private SMTP
  credentials never enter browser artifacts. A simulated/unavailable Pages choice
  does not require an EmailJS account.
- Live Cloudflare mail requires either an explicit Workers Paid assertion in target
  configuration or a nonempty recipient allowlist in mail configuration. The
  implementation must enforce that list across To, Cc and Bcc. The operator must
  configure the required sender and verified recipients with Cloudflare.
- CUE validates the declaration; it cannot prove the account is paid or the remote
  addresses are verified. Incorrect assertions fail explicitly at the provider.
- Live container mail uses the standard SMTP piece. MIME/attachment compatibility
  must be checked for each alternative; unsupported fields must not be dropped.

The paid bit is an operator assertion, not a billing API dependency or an automatic
upgrade. Target selection must never silently switch a named provider or substitute
browser-local data for an external system. Native blobs remain Pronto's file store;
provider storage integrations are selected only for actual external interoperability.

## Snapcards proves the payment and fulfillment boundary

Snapcards' initial paid product is one print order, with Davi handling fulfillment.
The intended flow is: freeze the selected cards and print settings into a PDF, store
that immutable artifact privately, obtain an authoritative quote, create a
one-time Stripe Checkout, accept a verified payment event, and request an email to
`davi@davi.eng.br` containing the PDF, order and shipping details.

The application owns order identity, frozen content, price/currency, shipping
eligibility and fulfillment state. It must not trust a browser-supplied total or a
successful return-page URL as evidence of payment. A paid order whose email fails
remains paid and awaiting fulfillment; it must not ask the customer to pay again.
Duplicate or reordered callbacks must not create another order or fulfillment.

Use the standard piece path for admitted Stripe operations. Where existing trigger
verification is insufficient, use a corrected standard piece or verified ingress
before its output reaches the order machine. The colleague's billing implementation
is useful evidence for Checkout, signature verification and a fake provider, but its
subscription entitlements, central broker and Stripe Connect author payouts are not
needed for this single-seller, one-time purchase.

Pages demonstrates a local simulated order experience, not the privileged server
lifecycle: approval/decline do not charge a card, admit a provider webhook or send
mail. Live checkout is enabled only with merchant configuration and actual
prices/shipping countries. No test should send a real email or take payment merely
to establish local integration behavior.

### Current Snapcards exception

The first implementation uses an [[../edge-hatches|edge hatch route]] at
`/commerce`. It invokes a local standard Activepieces Stripe piece for Checkout
creation/retrieval and directly verifies raw Stripe webhooks. A trusted service
calls the pure app reducer and commits private order/event tables in the existing
PGlite database. It does not run the reducer through Jessie confinement or CDC,
and does not use the generic Activepieces subprocess runner or a production shared
trigger host. Its explicit hatch authority makes this boundary reviewable.

The frozen PDFs are immutable, content-addressed private `bytea` records in that
same database. The current edge blob plane packages static seed assets; it does
not provide a private dynamic-upload API suitable for these paid-order documents.
The injected blob interface leaves a later migration to native private blob storage
possible without claiming that capability exists now.

Fulfillment uses the native Cloudflare email binding, restricted to
`davi@davi.eng.br`, rather than the generic SMTP action runner. The reducer separates
payment from mail state, and uncertain mail delivery requires reconciliation instead
of an automatic repeat. This implementation exercises the order/provider boundary and
target demo behavior; it does not complete the intended generalized integration
runtime. Configuration and recovery are documented in Snapcards' own commerce
README.

## Implementation evidence and remaining work

The [[../activepieces-hatches|built action contract]] and its acceptance suites cover
local Docker/Compose. The runner image still needs publication/pinning for external
app distribution. A container build is not proof of packaged Docker, Kubernetes or
GCP release wiring. The trigger spike is evidence for the intended host, not a
released service. Target mail adapters/configuration work does not by itself provide
a portable Airlock effect executor.

Deliver each new operation with a real provider-contract test, replay/failure cases
and its selected target behavior. Broader payments beyond Snapcards, messaging and FTP/SFTP remain
qualification families; the decision does not claim that their production hosts or
all target implementations already exist. Move built contracts into references as
they land, and archive this record once the intended boundary is implemented.
