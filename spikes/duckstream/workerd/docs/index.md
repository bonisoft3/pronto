# DuckDB in a Durable Object

Status: validated spike; adopted by the Cloudflare release packager through
[duckdb-workerd](https://github.com/bonisoft3/mecha/blob/v0.20.6/packages/duckdb-workerd/docs/index.md).
This standalone fixture remains a synthetic capacity experiment. Start from the [[../../docs/index|Duckstream experiments]].

DuckDB can execute inside a Durable Object without a Container. The earlier
failure came from the stock Emscripten loader generating WASM callback modules,
not from an inherent incompatibility between DuckDB and workerd. A small,
version-specific loader adaptation runs the pinned engine and its JSON and ICU
extensions using statically imported WASM modules.

## Mechanism

[[../prepare.ts]] downloads DuckDB-Wasm `1.33.1-dev57.0` and the matching engine
`v1.5.4` extensions. SHA-256 checks cover every upstream file used by the runtime;
patch occurrence checks reject changes to the expected loader structure.

- [[../thunks.json]] contains the 28 callback modules observed during startup of
  this pinned build. They become static WASM imports. An unknown signature fails;
  there is no dynamic compilation fallback.
- JSON and ICU are also static WASM imports. Their original signed bytes are
  packaged as Worker Assets and supplied to the existing extension loading path.
  The loader links the matching precompiled module. Unknown extensions fail.
- The browser loader gets a local `process` shadow and a synthetic script URL;
  this avoids selecting Node-only or browser-location-dependent initialization.
- The synchronous blocking DuckDB API runs directly inside the object. No Web
  Worker, Container, native process, remote SQL service, or unsafe-eval binding
  participates in execution. Upstream unused eval paths remain in the package;
  this proves the exercised paths, not universal compatibility with every API.

This is **not** a custom rebuild or a statically linked DuckDB distribution.
The core WASM is unchanged. Build-time module selection replaces runtime code
compilation while retaining Emscripten's dynamic linking of precompiled modules.

[[../worker.js]] exposes one named object and a bounded synthetic fixture.
Its durable storage holds only a run counter. DuckDB tables are scratch data,
regenerated from the fixture after restart. The counter is not a publication
receipt and does not establish end-to-end exactly-once semantics.

## Evidence

[[../results.json]] records two complete local runs separated by killing and
restarting workerd. [[../remote.json]] records the same query assertions against
the deployed Worker. For 1,200, 100,000 and 1,000,000 rows, an independent JavaScript
oracle checks all 100 grouped rows both before and after an update, deletion and
insertion. The fixture exercises a join, `count`, `count(distinct)`, `sum`, JSON
extraction, and ICU timezone conversion. A subsequent small run checks reuse;
an unsupported fixture size is rejected. Local restart retains the counter and
reconstructs identical query results.

| Fixture | Observed WASM linear memory |
| --- | --- |
| 1,200 / 100,000 rows | 34,930,688 bytes (33.3 MiB) |
| 1,000,000 rows | 60,424,192 bytes (57.6 MiB) |
| Small run after large run | 60,424,192 bytes; memory does not shrink |

This is not total isolate memory. JavaScript, Arrow buffers, extension bytes and
other runtime allocations also consume memory. The input has four narrow integer
columns and only 100 groups; wide rows or high-cardinality aggregates can have
very different costs. The actual cloud run passed, but these figures do not
establish a safe production capacity.

Client `requestMs` includes request/response transfer and JSON decoding, excludes
oracle validation, and is not CPU time. No engine timing is inferred from
`Date.now()` inside a synchronous Worker turn: the cloud clock did not advance
there. Cold initialization and asset loading make the first request different
from subsequent requests.

The isolated deployment is
https://duckstream-do-static-spike.davi-d2c.workers.dev . It contains synthetic
fixtures only and no application data. It was deployed on the existing **paid**
account, not a free account. No existing app Worker or Container was modified.

The packaged executable upload is about 42.6 MiB uncompressed, plus 6.9 MiB of
extension assets. Cloudflare's current [Worker limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)
allow 64 MiB uncompressed on both plans and specify no compressed-size limit.
The former 3/10 MiB comparison does not apply. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
permit SQLite-backed objects on Free and default to 30 seconds of CPU per request.
A container-free architecture therefore does not inherently require Workers Paid;
free-tier quotas and the full application's execution still need testing.

## Reproduce

The build needs Deno, tar, network access and the repository Sayt runner. The
local integration harness additionally uses Unix process inspection and the
pinned Node/Wrangler tools. It is not a Windows portability test.

From `plugins/pronto/spikes/duckstream/workerd`, install the pinned dependencies:

```sh
mise trust mise.toml
mise install
deno install --frozen
```

From the repository root:

```sh
just sayt -d plugins/pronto doctor
just sayt -d plugins/pronto/spikes/duckstream/workerd build
just sayt -d plugins/pronto/spikes/duckstream/workerd lint
just sayt -d plugins/pronto/spikes/duckstream/workerd test
just sayt -d plugins/pronto/spikes/duckstream/workerd integrate
```

`build` prepares ignored `.build/` files; `test` type-checks the harness;
`integrate` runs the actual assertions in workerd and writes `.build/results.json`.
[[../run.ts]] uses the repository's existing Wrangler restart harness. It creates
isolated temporary state and stops its own processes. The checked-in evidence is
an observed run, never substituted for a fresh gate result.

To inspect packaging or explicitly deploy, from the same `workerd` directory:

```sh
mise exec -- wrangler deploy --dry-run --config .build/wrangler.json
mise exec -- wrangler deploy --config .build/wrangler.json
deno run -A verify.ts https://YOUR-WORKER.workers.dev .build/remote.json
```

Select the intended account through Wrangler's existing login/environment.
Neither deployment nor account selection is part of the integration gate.

## Adoption boundary

Keep the current Container-backed apps until the real snapshot executor is
integrated and tested. This spike does not run PGlite, Cortex, Jessie/SES, the
Golaberto WASM algorithm, CDC, or Feldera. It does not change snapshot computation
into incremental computation.

The next integration should put this executor in a separate compute Durable
Object, reached through a binding, while the existing object retains PGlite and
the durable coordinator. Separate classes alone do not guarantee separate
isolates; use a separate Worker/service if memory isolation is required. Measure
capture transport, total memory, repeated large jobs, cancellation/retry, and
publication against the existing app acceptance tests.

The upstream browser runtime uses `globalThis.DUCKDB_RUNTIME`. This fixture has
one object identity; it does not prove safe multiplexing of multiple DuckDB
instances in one isolate. An adopted adapter must route synchronous runtime
calls to the correct instance and test interleaving during initialization.
The 28 observed callback signatures also need broader coverage or deterministic
extraction from the build before general-purpose SQL support can be claimed.

A custom minimal static build could reduce size and upstream-loader patching,
but it is an optimization and maintenance choice, not a prerequisite demonstrated
by this experiment. The remaining performance tradeoff is bounded per-object
compute and memory; adding objects does not make one oversized query fit.

Pronto doctor and the spike build/lint/test/integrate gates passed. Independent
QA review found no actionable issue within this bounded fixture's claims.
Review used Sol/high because the skill's Terra route was unavailable; the lead
retained its current model. No UI contract changed, so no visual oracle or app
journal is claimed.
