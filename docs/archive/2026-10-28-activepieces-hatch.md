# Activepieces actions in application container hatches

Status: built for local Docker/Compose. The active contract is
[[../activepieces-hatches|Activepieces hatches]]. This record preserves the
proposal and reasons for the boundary; release distribution still needs a
published runner image pin and target-specific deployment work. The later
[[../decisions/2026-10-28-integrations|integration decision]] extends the intended
boundary to triggers and target-specific live/demo behavior. Statements below
about version one describe the action-host decision, not the limit of that design.

## Decision and ownership

Pronto owns an action runner. Applications opt into standard Activepieces pieces,
actions, configuration and credentials through CUE. A local piece is a private
package exporting `createPiece`, with ordinary `createAction` implementations,
authentication and properties. It imports no Pronto or Mecha internals and requires
no upstream contribution, npm publication or Activepieces private-piece hosting.

Keep `kind: "container"` and add an `activepieces` specialization. This refines the
earlier sketch of `kind: "activepieces"`: deployment and trust remain those of a
container hatch. Each bridge role selects one action alias in that hatch. Pieces
and actions are not separate hatches. Multiple bridges may address one hatch;
separate hatches when trust or operational requirements differ.

| Owner | Responsibility |
| --- | --- |
| Framework | Runner, invocation protocol, compiler/build wiring, context adaptation and process lifecycle |
| Application | Selected packages/actions, admission contracts/tests, configuration and secret references |
| Jessie handler | Business inputs, transformations and interpretation of action results |
| Airlock | Durable effect identity, ledger, outcome recording and reentry |
| Standard piece | Provider protocol, MIME/request construction and provider receipts |

The runner is deployed with each app, not a global multi-tenant service. It adds
no Activepieces workflow engine, database, scheduler or polling loop. Saved effect
results remain replayable without re-running external actions.

## Proposed application declaration

This syntax is not accepted by today's compiler:

```cue
code: capabilities: hatches: integrations: {
    kind: "container"
    note: "Trusted mail integration with outbound SMTP access"
    activepieces: {
        pieces: mail: {local: "./pieces/mail", export: "mail"}
        actions: sendMail: {
            piece: "mail"
            action: "send-mail"
            inputSchema: "./pieces/mail/send.input.schema.json"
            outputSchema: "./pieces/mail/send.output.schema.json"
            auth: {
                jsonSecret: "SMTP_AUTH_JSON"
                schema: "./pieces/mail/mail.auth.schema.json"
            }
            fixedProps: {
                host: "smtp.example.test"
                port: 587
                starttls: true
                messageIdDomain: "mail.example.test"
            }
            idempotencyKeyProp: "requestKey"
        }
        limits: {timeoutMs: 8000, maxConcurrent: 4}
    }
}
code: state: bridges: mail: {
    container: "integrations"
    action: "sendMail"
}
code: state: effects: confirmation: {
    sink: {bridge: "mail", idempotent: false}
    reentry: "unknown"
    note: "SMTP may accept delivery before its acknowledgement is lost"
}
```

The local package/schema paths describe the planned mail migration, not existing
files. A published source replaces `local` with
`npm: {package: "@vendor/piece-example", version: "1.2.3", export: "example"}`
(illustrative package/version). Versions are exact and transitive integrity locked.
Both catalogue and custom selections, exposed actions, credentials, contracts and
configuration belong inside this hatch definition. There is no separately authored
integration registry. Local sources are relative package directories included in
the app's content-addressed build. There is no directory scanning or request-time package resolution.

An action alias is a configured invocation. Two aliases may bind the same exported
action to different credentials or fixed inputs. `auth.jsonSecret` names an operator
JSON secret containing the **complete runtime `context.auth` value** for that
admitted action. This avoids assuming every published action uses the same custom-auth
envelope. Omitting auth supplies `undefined`, legal only for actions admitted without
it. Credentials stay out of CUE, the generated manifest, Jessie input and ledger.
OAuth acquisition/refresh is outside version one.

`fixedProps` are nonsecret configuration, not templates. Caller input cannot name a
fixed property even with the same value. `idempotencyKeyProp` optionally binds the
host's `Idempotency-Key` header to a normal piece property; the caller cannot supply
that property either. It grants no idempotence. A reusable mail action can accept
`requestKey` and derive its stable Message-ID without knowing anything about Pronto.
It can also expose an explicit `messageId` option for other users; this app binding
must prohibit overriding the identity it promises.

The closed CUE prototype
checks positive and negative declarations. It omits outer program wrappers and
does not implement lowering, source existence checks, export discovery, schema
validation or realpath/symlink confinement.

## Scope each bridge to one action

An Activepieces bridge requires `action`; ordinary container bridges remain
unchanged. The compiler generates a Dapr binding rooted at
`http://integrations:8080/actions/sendMail`. Jessie calls
`sink.fetch("/", {method: "POST", body: {props: message}})`. The runner accepts
only that exact `/actions/sendMail/` POST route, rejecting suffixes, other methods
and undeclared aliases. It never accepts package, action or authentication overrides
from the body.

The Dapr experiment verified
base-path joining with Mecha's actual pinned Dapr image. Preserve Airlock's path
validator, which rejects traversal, encoded paths and absolute URLs. This scopes
the Jessie handler's capability; it does not isolate trusted containers on the
bridge network. Existing bridge placement grants no public Caddy route, host port,
database credential or callback token. Network roles do not enforce outbound
destinations. An action still runs trusted code with the hatch's declared authority.

## Invocation and delivery contract

Request: closed JSON `{props: {...}}`, with a required nonempty `Idempotency-Key`.

| Response | Meaning |
| --- | --- |
| `200 {result: ...}` | Action fulfilled and its result passed the declared output contract; Jessie interprets business success or rejection. |
| `400`, `404`, `405`, `413` | Bad input, route, method or size; action not entered. |
| `503 {error: {kind, invocationId}}` | Capacity, deadline, child failure, exception or invalid output; entered actions may already have caused an external effect. |

Error kinds distinguish observed admission rejection from uncertain execution, but
a lost HTTP response destroys that knowledge at the caller. Raw exception strings,
stack traces and provider payloads are not returned. Configuration, package and
capability admission errors fail startup/readiness rather than choosing a fallback.

A fulfilled action may report provider rejection as structured data. The framework
does not infer permanent business failure from arbitrary exceptions. The mail piece
returns actual permanent/temporary SMTP receipts and partial-recipient outcomes;
the application's Jessie handler maps them to existing outcomes. Transport uncertainty
must not become permanent failure merely because it was returned as data.

Preserve current bridge restrictions: non-idempotent sinks, `unknown` or `repeat`
reentry, no reconciliation promise. No runner retries, durable queue, deduplication
or scheduler are added. Disable or explicitly qualify internal library retries;
mail retains one SMTP attempt per invocation. Under today's conservative Airlock
policy even a capacity rejection can later settle `unknown` when the handler throws.
This phase does not change entry accounting to optimize known-not-started retries.

## Validation and supported context

Calling `action.run` bypasses Activepieces engine preparation. Both spikes
demonstrate omitted defaults; the local piece also runs with a
missing required property. The published HTTP action rejects its tested missing
fields through action-specific code, not evidence of general engine validation. Descriptors may
also contain executable callbacks; JSON serialization is not a complete CUE importer.

Version one requires explicit JSON Schema input/output contracts accompanying each
selection. Validate complete `propsValue` after inserting fixed and identity fields,
but reject collisions before merging. Defaults must be explicit in `fixedProps` or
Jessie; no coercion, expression language, dynamic property lookup or implicit defaults.
Reject remote schema references and permit only bundled local references. Validate
resolved auth against the declared `auth.schema` before execution; that schema
is qualified against the pinned action, not inferred from an arbitrary secret.
Static descriptors can generate drafts, not silently replace reviewed contracts.

Initially supply only `propsValue` and `auth`. Other context reads fail explicitly:
no fabricated flow IDs, empty stores, dummy file services or no-op callbacks. Stores,
files, OAuth refresh, platform APIs, flows, triggers, polling and resumable execution
require real service contracts before admission. An unsupported action may remain
exported by a package without being exposed by this app.

The application-owned admission record/tests bind package revision, export, action,
auth shape, schemas, runtime permissions and retry behavior. It is data and tests,
not a Pronto-specific implementation of the action. Unsupported context can be
accessed after external work; runtime refusal alone is not proof of no effect.
Qualification must cover failure branches, and package upgrades rerun those tests.

## Execution boundary

Use a long-lived HTTP supervisor and a **fresh Deno subprocess per invocation**.
The supervisor never imports piece modules. It resolves only the selected alias's
auth, passes auth/props over stdin, and starts the child with `clearEnv: true` plus
explicitly admitted runtime entries. Do not put credentials in argv or inherit the
supervisor's entire environment. Child code receives no subprocess-execution
permission; restrict reads to package assets/configured CA material and writes to
its per-invocation result channel. Dependencies are cached during build; runtime
package downloads are forbidden.

This is a proposed execution arrangement, not an implemented sandbox. Trusted
pieces can transmit credentials through their network authority. The
isolation spike found Worker
environment writes visible to the host and sibling Workers, whereas `clearEnv`
subprocess writes remained separate. The published HTTP helper writes a TLS-related
environment variable, so this matters beyond hypothetical isolation. Fresh processes
also discard module caches. Startup cost and sustained throughput remain implementation
measurements, not established properties of the spike.

Default limits: four concurrent children, no waiting queue, 1 MiB request/result
bounds, eight seconds total including startup. Airlock's binding call budget is
**ten seconds**, although its complete handler budget is sixty. Keep deadline below
the binding budget with response headroom. Bound streamed input and child output
before allocating unbounded buffers. Terminate and reap on disconnect/deadline;
killing local execution cannot undo a request already sent.

Use a bounded result channel separate from stdout/stderr so library logging cannot
corrupt the response. A private per-invocation result file is acceptable only with
an OS-enforced
file/storage size cap as well as bounded reading and cleanup; bounding the reader
alone cannot prevent disk exhaustion. Test an overproducing child. If that cap
cannot be enforced on a target, use bounded IPC with backpressure and terminate
on overflow instead. Do not forward raw piece
logs to ordinary application logs. Emit structured failure kind, alias, package/content
revision, duration and invocation ID; explicit restricted diagnostics may expose raw
logs with their sensitivity understood. The HTTP spike logged request/response fixture
bodies and included them in exceptions. Generic string redaction cannot promise
secrecy, and successful output schemas cannot prove it either. Review result content
and record only intended business receipts in the ledger.

## Build and release

The framework ships the runner/runtime and pinned dependencies. The app build adds
a static registry, admission manifest, selected packages, schemas and lockfiles to
the pinned runner image. Provider dispatch and SMTP knowledge do not belong in the
runner. Local packages use normal `package.json` exports and SDK dependencies.
The portability fixture loads the private built package in Deno and Node without
publishing; it does not test installation in the official Activepieces platform.

Include the complete declared source closure: workspace dependencies, runtime assets,
schemas and explicitly supported native binaries. Resolve realpaths, reject symlink
escapes/undeclared external sources and hash included inputs. Native dependencies
require per-target build/tests. Introspection executes trusted code: after locked
dependency acquisition run it without network or deployment credentials. Do not
execute dynamic descriptor callbacks merely to generate CUE.

Local development and release use the same bundled child entry and lockfile; restart
on content changes, with no runtime hot-install in production. First implement local
Docker/Compose. The packaged Docker release needs its own artifact test proving the
app-specific image and closure are carried. Kubernetes/GCP can host the container,
but release wiring remains separate work. Cloudflare Workers and Pages are unsupported
by this subprocess design; a future Worker host needs a separate tested capability
profile. A browser-only deployment cannot hold provider credentials.

## Mail migration and implementation order

1. **Standard mail package.** Move provider logic out of Mecha's dedicated service
   into a normal first-party piece package, selected locally by the test app.
   First-party reusable pieces may be separately versioned repository packages;
   app ownership means selection/extension, not copying mail into every app.
   Export `createPiece`; use ordinary auth/props, not captured operator configuration.
   Keep SMTP, MIME, stable identity, TLS and receipts in the piece; keep `/send`,
   Dapr, environment names and HTTP mapping out. Run existing protocol fixtures
   directly against the action.
2. **Generic supervisor.** Implement immutable registry, schema/auth checks, input
   precedence, child lifecycle/IPC and safe errors. Test failures before/after
   network entry, timeouts, oversized data, secret inheritance, package logging,
   post-timeout behavior and no internal host retry. Measure startup and throughput
   against the eight-second budget before freezing process topology.
3. **Compiler/build.** Extend [[../../schema.cue|schema.cue]],
   [[../../emit.cue|emit.cue]], [[../../builders/bayt.cue|build closure]] and
   [Mecha runtime](https://github.com/bonisoft3/mecha/blob/v0.20.6/cluster.cue). Generate action-specific
   Dapr bases and app-specific source/image targets. Preserve ordinary bridge tests;
   reject unlisted actions, credential/fixed-prop overrides and escaping sources.
   Ensure changes to any selected asset invalidate the image.
4. **Mail cutover.** Change its Jessie handler to the bridge root and interpret the
   standard result. Remove `#MailContainer`, dedicated mail image and special
   publication/build entries once the generic path replaces them. Preserve exact
   Message-ID derivation and the existing 21 container mail checks and 10-step Airlock
   integration. Test two aliases with different credentials and prove one handler
   cannot route to the other. Verify clean checkout and packaged Docker release.
   The preceding migration is unmerged, so prefer atomic cutover over a permanent
   mail compatibility endpoint in the generic runner.
5. **Catalogue expansion.** Add qualified actions through app packages/configuration,
   without editing runner dispatch. New context services require implementation.
   Async crawling/callbacks, OAuth refresh, persistent protocol consumers and broader
   resilience infrastructure remain separate work, not silently emulated features.

The implementation follows this boundary; the reference describes its supported
package shapes and execution contract. No upstream contribution or paid Activepieces hosting is a prerequisite.

## Evidence and alternatives

Reproducible experiments cover package
loading, limited context, metadata bypass, published HTTP retry counts, sensitive
errors/logs, timeout continuation, environment isolation, closed CUE declarations
and actual Dapr routing. They do not establish a production runner, full catalogue
coverage, complete child sandbox, official-platform installation or cloud deployment.

A dedicated Nodemailer bridge is simpler for mail alone but keeps new integrations
as framework-specific services. Standard pieces give apps a portable extension unit.
The full Activepieces engine brings workflow/storage/scheduling contracts we do not
need. One long-lived process is cheaper but observed environment mutation crosses
invocations. Containers per action isolate more strongly but increase deployment
cost; split hatches when trust requires it. Automatic descriptor-to-CUE translation
is deferred because callbacks and engine preparation are not plain JSON semantics.

Upstream references: [piece structure](https://www.activepieces.com/docs/build-pieces/building-pieces/piece-definition),
[action interface](https://www.activepieces.com/docs/build-pieces/building-pieces/create-action),
[persistent context storage](https://www.activepieces.com/docs/build-pieces/piece-reference/persistent-storage).
