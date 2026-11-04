# Activepieces declaration prototype

Run `./test.sh` with CUE 0.16.1. This standalone package explores a closed
contract; it does not extend Pronto or produce a runner. The local mail example
and npm fixture illustrate the shape, not a working package or export.

An app opts into a `container` hatch with an `activepieces` specialization,
listing local pieces under `./pieces/` or npm pieces with exact versions. It
assigns action aliases to pieces, fixed properties and an optional operator
environment name for authentication. The named variable supplies the whole JSON
object passed as standard `context.auth`; omission supplies `undefined`. The runner
must validate the object against the declared `auth.schema`, qualified for the
pinned action.
Every action also names input and output JSON Schema files; they describe plain
JSON data, not SDK callbacks. The fixture paths are illustrative and do not exist. A bridge selects an alias; an effect uses the existing
`sink.bridge` field. Generic container bridges remain unchanged and are outside
this prototype. Fixed properties are configuration, not a place for secrets;
CUE cannot identify secret values in arbitrary strings.

A production compiler would build a static registry and a pinned, locked source
closure, including local piece trees, package resources and workspace dependencies.
It would reject unsupported piece exports, action names, authentication shapes,
and references, and ensure credentials come only from fixed operator bindings.
The lexical local-path check must be supplemented with realpath and symlink checks
to keep each source within the app-owned pieces tree.
An optional `idempotencyKeyProp` binds the host-supplied `Idempotency-Key` header
to an action property and cannot collide with a fixed property. For example, a
local mail action may use `requestKey` to derive a stable Message-ID without a
Pronto dependency. The runner must validate request data and refuse authentication
fields, fixed properties, identity, package and action overrides; it must not dynamically import from a
request. The schema only checks declaration structure, not these runtime rules.

The proposed effect binding selects the action through a scoped base URL such as
`/actions/sendMail`, with the handler posting to `/`; the [[../routing/README|Dapr experiment]]
verifies base-path joining. Existing Airlock path validation and exact runner
route matching remain necessary. The
runner must also enforce route and payload boundaries. The effect handler maps
frozen input to request data and responses to `done` or `failed`; a lost response
can mean the action happened. Existing bridge rules allow only `unknown` or
`repeat` reentry and do not promise idempotence.

The prototype defaults to an 8-second action timeout, four concurrent calls, and
1 MiB each for request and result; it caps the deadline at eight seconds to leave headroom within Airlock's ten-second call budget. These
are proposed runner limits, not guarantees of the current bridge.

Piece code and dependencies are trusted integration code. A bridge's dedicated
egress network is not a destination firewall. The image base, packages and
transitive dependencies must be pinned; package code, credentials and outputs
need review. Compose placement does not establish Cloudflare, Kubernetes, Docker
appliance or Cloud Run release support.
