# Edge hatch routes

An app may give a declared container hatch a Cloudflare Worker implementation.
The edge bundler imports that implementation into the app's Durable Object and
routes one public path prefix to it. This is trusted application code with direct
access to the cluster database and Worker bindings. It is separate from the
[[activepieces-hatches|Activepieces subprocess action runner]].

```cue
code: capabilities: hatches: commerce: {
    kind: "container"
    note: "Trusted payment verification and private order persistence"
    edge: {
        src: "commerce/dist/edge.js"
        route: "/commerce"
        environment: ["PAYMENT_CURRENCY"]
        secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
        publicAttributes: "data-commerce-mode": "live"
        email: {name: "SNAPCARDS_MAIL", recipients: ["davi@davi.eng.br"]}
    }
}
```

`src` is a prebuilt app-relative JavaScript module. It must resolve inside the app;
source paths with traversal or escaping symlinks are refused. Build dependencies
before packaging and pin them in the app's lockfile. The declaration does not build
TypeScript or install runtime dependencies itself.

The module exports this factory:

```ts
export function createHatch({ database, env }) {
  return {
    async fetch(request) {
      return Response.json({ ready: true });
    },
  };
}
```

The factory receives the existing PGlite database, not a separate database:
`database.query(sql, params?)` returns `{rows}`, and
`database.transaction(async tx => ...)` supplies `tx.query`. Both are serialized
through the cluster. Use the transaction query object inside its callback rather
than entering the outer serialized database again. Keep provider calls outside
transactions and record their uncertain outcomes explicitly.

Durable state belongs in the database, not factory instances or module memory. The
database must have finished loading before the route is served; requests during
loading receive 503.

The returned object may also have `sweep()`, for what no request will come back
for. The cluster's poke calls it, hourly from the Cron Trigger every release with a
hatch carries, creating the hatch if no request has. A sweep that throws makes the
poke answer 500 with the reason, without stopping another hatch's. A publish's own
poke skips sweeps, since a first deploy's secrets may not exist yet.

**Disk.** PGlite has no autovacuum and no checkpointer. A DELETE frees nothing until
that table is vacuumed, and WAL stays until a checkpoint, which the poke runs: a
hatch that deletes large values must `VACUUM` them from its sweep. Measured on the
object's own store under `wrangler dev`, for cycles of writing and deleting 19 MiB:
neither grows 38 MiB a cycle, `VACUUM` alone 19 MiB a cycle (the WAL), both stays
flat. A checkpoint recycles WAL files rather than shrinking them, so `pg_wal` holds
about the most written between two pokes. `VACUUM` holds the one connection: with
250 MiB to clear it took 2.2 s, and a read arriving then waited 3 s.

## Authority and routing

`route` is a unique top-level prefix such as `/commerce`. Exact matches and paths
starting with that prefix plus `/` reach the hatch, preserving the original request.
`/commerce-other` does not match `/commerce`. Reserved cluster prefixes are refused:
`auth`, `crud`, `electric`, `import`, `poke`, `blobs` and `img`. The edge builder also
rejects duplicate routes and duplicate email-binding names.

A routed request goes directly to the hatch. This is not an authenticated CRUD
endpoint, a scoped Jessie fetch capability, an Airlock effect or a confined handler.
The hatch must validate methods, input, origins, credentials, provider signatures
and access to its own resources. Its database connection and `env` bindings carry
privileged authority; selecting a route does not narrow that authority. Declare
private tables and grants explicitly rather than exposing provider receipts or
PDFs through public CRUD.

A pure reducer called from this hatch remains ordinary imported code. It is useful
for deterministic tests but is not executed in a Jessie compartment and is not
automatically driven through CDC. The
[[decisions/2026-10-28-integrations|integration design]] distinguishes this interim
adapter path from the intended shared trigger host.

## Public settings and email

`publicAttributes` replaces existing double-quoted `data-*` attributes in the
edge release's HTML files. It does not create attributes on elements where they
are absent, and it does not modify the browser-only Pages build. Conflicting values
for the same attribute are rejected. Values are public, must not contain HTML
markup/quote characters, and must never contain credentials. Snapcards uses this to
replace its explicit Pages `mock` mode with `live` in the edge artifact.

`email` generates a Cloudflare `send_email` binding with the declared name and
`allowed_destination_addresses`. The recipient list must be nonempty. It narrows
provider destinations; it does not verify sender domains or recipient addresses,
create an account, or provision a paid plan. The operator configures Cloudflare's
email service separately. Application mail adapters must preserve declared field
semantics and fail if unsupported.

`environment` lists required plain settings, such as origin and price. The build
emits only those names in `edge-environment.json`; values are not included in public
artifacts. The publisher reads each from its process environment, refuses an absent
or empty one before deployment, and sends it through the same secret-file deployment
as the cluster secrets.

The object creates a hatch once and keeps it for its life, so what a hatch holds in
memory between requests, a per-client rate limit say, persists until the object is
evicted or the Worker deployed, and no longer; a limit that must hold belongs in the
database. Its `create` must therefore keep nothing that belongs to one request.

`secrets` lists the names of [production keys](release-targets.md#keys), in
`edge-secrets.json`. The publisher never reads, requires or uploads them, and
wrangler keeps secret bindings a `--secrets-file` omits. Set each on the Worker in
the dashboard (Settings > Variables and Secrets) or with `wrangler secret put`, which
deploys a new version. Publishing to an existing Worker refuses, before deploying, if
`wrangler secret list` lacks a declared name. A first deploy and a `--temporary` one
have nothing to list, and a temporary account can hold no secret set this way, so
there the hatch's own refusal at its route is the failure. Reserved binding names,
email-name conflicts and a name declared in both lists are rejected.

The application still validates formats and provider-specific requirements at
runtime; presence validation does not establish that credentials work.

The full Worker environment is passed to the hatch. The declaration determines
which additional settings the release must provide; it is not an authority filter
on the hatch's `env` object. `publicAttributes` is only for public presentation
settings, and the email declaration creates its provider binding separately.

## The cluster's door

`door` serves the same hatch behind a container cluster's caddy:

```cue
code: capabilities: hatches: commerce: {
    kind: "container"
    note: "Trusted payment verification and private order persistence"
    door: {route: "/commerce", port: 8080, publicAttributes: "data-commerce-mode": "live"}
}
cluster: surface: targets: commerce: { /* the service: image, srcs, compose */ }
```

The program defines the cluster target of the hatch's name beside it, as for any
container hatch, with a `compose` block; generation fails without one. Caddy
proxies `route` and the paths under it, path kept, to
`{$PRONTO_UPSTREAM_<HATCH>:<hatch>:<port>}` with `dapr-app-id <hatch>`, under the
resilience `hatch` hop (`import bounded-hatch`). The route refusals are the
edge's plus the door's own `health`, `omnishell` and `shell`.

The mode belongs to the target, not to a switch. Every launch waits on the
hatch's service, and the tree every container door serves has each
`publicAttributes` entry rewritten (existing double-quoted attributes only,
before the tree is addressed); a rewrite that finds no carrier stops the build.
Pages keeps the authored value.

Settings reach the service at runtime through the target's own compose
`environment` and `env_file`; `environment` names declared for `edge` are not
read here. Values never belong in the program, the generated files or an image.

On Kubernetes, `.pronto/cluster.json` names the door hatches (`doors`): caddy
dials each through its sidecar and the Dapr Resiliency bounds each app id with
the `hatch` timeout, with no circuit breaker. The hatch's own workload is not
deployed by the release yet.

## Packaging boundary

The compiler emits `.pronto/edge-hatches.json`; the edge bundler validates the
manifest, imports each factory, emits routing and optional email bindings, and
enables Node compatibility for the Worker. This does not make native dependencies
or the Deno subprocess API available. SSR edge releases currently reject hatches.

No container, Kubernetes or GCP deployment is implied by this edge specialization.
`door` serves the compose launch only; a container release target still requires
its own implementation and release verification. Pages must provide a browser-compatible implementation,
a simulation or explicit unavailability; it cannot host this privileged route.

The generated Cloudflare GitHub Actions job maps each `environment` name to the
same-named repository secret, and never a `secrets` name. Local publishing reads the
process environment. Neither path stores values in generated release artifacts.
