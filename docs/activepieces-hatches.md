# Activepieces container hatches

An app opts into standard Activepieces pieces inside a container hatch. Both local
custom pieces and pinned catalogue pieces use the same selection and execution path.
The framework owns the runner; the hatch owns packages, exposed actions, contracts,
configuration and credential references. No separate integration registry is authored.
The [[archive/2026-10-28-activepieces-hatch|action-host decision]] records the initial
tradeoffs. The [[decisions/2026-10-28-integrations|integration design]] extends this
boundary to standard triggers and explicit live/demo behavior per target; those
parts are not supplied by this action runner.

## Declare the hatch and action bridge

```cue
code: capabilities: hatches: integrations: {
    kind: "container"
    note: "Trusted integration code with external network access"
    activepieces: {
        lock: "./pieces/integrations.lock"
        pieces: mail: {local: "./pieces/mail", export: "mail"}
        actions: sendMail: {
            piece: "mail"
            action: "send-mail"
            inputSchema: "./pieces/mail/send.input.schema.json"
            outputSchema: "./pieces/mail/send.output.schema.json"
            auth: {jsonSecret: "SMTP_AUTH_JSON", schema: "./pieces/mail/mail.auth.schema.json"}
            fixedProps: {host: "smtp.example.test", port: 587, starttls: true, messageIdDomain: "mail.example.test"}
            idempotencyKeyProp: "requestKey"
        }
    }
}
code: state: bridges: mail: {container: "integrations", action: "sendMail"}
code: state: effects: confirmation: {
    sink: {bridge: "mail", idempotent: false}
    reentry: "unknown"
    note: "SMTP acceptance can precede a lost acknowledgement"
}
```

These paths refer to an app-supplied package and schemas. The optional first-party
[mail package](https://github.com/bonisoft3/mecha/blob/v0.20.6/pieces/mail/README.md) supplies this contract.
It is a normal private package with its own version and standard SDK exports, not a
runner dependency. Applications may vendor its built package or maintain their own.
Each piece export is a standard `createPiece` object; action names are those exported
by that object. Custom code does not import Pronto or Mecha.

A catalogue selection uses `npm: {package: "@activepieces/piece-http", version:
"0.13.0", export: "http"}` instead of `local` and `export`. A package can expose
more actions than this hatch selects. Action aliases can configure the same exported
action differently. All pieces inside a hatch share one trust/deployment boundary;
use separate hatches when isolation or scaling requirements differ.

The bridge selects an alias. The effect handler uses
`sink.fetch("/", {method: "POST", body: {props: {...}}})`. Pronto scopes its Dapr
binding to `/actions/<alias>`; the runner accepts only the exact POST route with a
trailing slash. Existing Airlock path validation prevents traversal or absolute URLs.
Ordinary container bridges remain available without the specialization.

## Properties, identity and credentials

`fixedProps` is nonsecret deployment data. The caller cannot name a fixed property,
even with the same value. `idempotencyKeyProp` inserts Airlock's host-provided key
into one ordinary action property; caller overrides are rejected. This does not
make an action idempotent. The mail action derives its Message-ID from `requestKey`
but never deduplicates SMTP delivery.

`auth.jsonSecret` names an operator environment variable containing the complete
JSON `context.auth` value, validated against `auth.schema` before readiness. It is
not interpolated into the app, generated files or ledger. Only the selected action's
auth is passed to its child. Omit auth for actions qualified without credentials.
The mail piece accepts `{type: "CUSTOM_AUTH", props: {user, password}}`; published
pieces must be qualified for their actual auth representation.

Input/output/auth schemas are explicit JSON Schema files under `./pieces/`, with
only fragment `$ref` references. Bundle cross-file references before selection.
The input schema validates complete props after fixed inputs and identity are added.
Defaults must be explicit in the handler or fixed inputs. The host does not perform
Activepieces expression evaluation, property callbacks, coercion or engine defaults.
Only `propsValue` and `auth` context capabilities are supplied; unsupported context
access fails. Files, stores, OAuth refresh, triggers and resumable workflows are not
emulated. A missing capability accessed after external work leaves an uncertain
outcome, so qualification must cover failure paths as well as successful calls.

## Package, lock and generate

Local directories must be under `./pieces/`. They require a `package.json` with a
string root export (`exports`, `exports["."]` or `main`) pointing to an existing
built entry. Build the piece first. Dependencies must use exact npm versions;
workspace/file dependencies and conditional exports must be packaged into a supported
root export before use. Symlinks are rejected. The complete package tree and binary
assets are copied except `node_modules`, `.git`, `.bayt` and `.task`.

The compiler emits `activepieces/<hatch>/declaration.json`. The writer resolves
schema files, snapshots local packages, generates static imports and scoped dependency
mappings, copies the declared lock, and emits a content revision. These files are
tracked in the generated-file manifest; stale copies are removed without changing
authored sources or the lock. Catalogue modules remain pinned npm imports. Source
and schema contents participate in the image source closure and revision.

Dependency changes are explicit. Before first generation, export the declaration
without running the writer, then update the lock using the compiler tool:

```sh
cue export . -e 'out.files["activepieces/integrations/declaration.json"].data' --out json > /tmp/integrations-declaration.json
deno run --no-config --no-lock --allow-read --allow-write --allow-run \
  /path/to/pronto/activepieces-package.ts . /tmp/integrations-declaration.json \
  /tmp/integrations-context --update-lock
```

The command deliberately permits dependency resolution only for the explicit update.
Review and commit `pieces/integrations.lock`. Normal generation copies it and the
image build runs `deno cache --frozen`; deployment uses `--cached-only` and cannot
fetch missing dependencies. Re-run the ordinary `sayt generate` after updating.
The generated registry is never edited by hand. Lock/schema/source failures are
errors, not fallback selections.

## Runtime and outcomes

The [runner](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/activepieces/README.md) validates its
manifest, secrets and package/action availability before listening. Each invocation
uses a fresh Deno subprocess with a cleared environment and no subprocess/native-FFI
permission. Package code is trusted: it can use network access and transmit the
selected credentials. The process loads the hatch's static registry; selecting an
action is not isolation from other packages included in that registry.

The child receives data over stdin, sends bounded results through a token-authenticated
loopback connection, and has stdout/stderr discarded. Raw library errors or logs
are not returned. Defaults are four concurrent calls, 1 MiB request/result limits
and an eight-second deadline, bounded below Airlock's ten-second binding budget.
There is no waiting queue. Deadline/disconnect cleanup kills and reaps the child;
this cannot undo requests already sent. Structured failures log the alias, package
alias, revision, invocation ID, kind and elapsed time without raw credentials.

A fulfilled action produces `200 {result: ...}` only if its output matches the
schema. A provider rejection can be a valid result; Jessie decides whether to return
`done`, `failed` or throw. Invalid request/route/method/size produces a 4xx. Capacity,
execution and output failures produce safe 503 errors. An entered action may have
already caused an effect; no generic exception classification proves permanent
business failure. Preserve Airlock's non-idempotent `unknown`/`repeat` policies.
Neither the runner nor mail action retries internally. Other catalogue actions
must be qualified for internal retry behavior; invoking them once is not proof
of one external request.

## Delivery and verification

Local Docker/Compose builds the generic `activepieces-image` and an app-specific
layer containing its generated package closure. The source checkout path is tested.
The generic image has no published digest yet: mirror deployment needs a release
that publishes and pins it. Packaged Docker, Kubernetes and GCP release wiring
requires its own implementation and acceptance evidence. The subprocess runner
does not run in Pages or Cloudflare Workers. Mail-specific target configuration and
adapters are work in progress, not a working portable effect executor. The
[[decisions/2026-10-28-integrations|integration design]] defines explicit live,
simulated and unavailable behavior for those targets.

The runner is tested for input/auth boundaries, output size, logging, deadline,
concurrency and cleanup. Compiler/writer tests cover selection, scoped URLs, binary
resources, stable reruns and stale-file removal. Catalogue integration exercises a
published action with a frozen lock. Mail's 21 container checks cover MIME/calendar,
identity, Bcc, SMTP replies, uncertain delivery, no retry and TLS. The generated
Compose Airlock test checks the durable ledger-to-mail path in ten steps.
