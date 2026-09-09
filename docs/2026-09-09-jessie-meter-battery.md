# Jessie fuel metering and the property test battery

Built on this branch; PR #1709. The ground:
`2026-08-31-one-ladder-one-grammar.md` (one writer per fact; handlers as
pure reducers), `2026-09-07-validation-is-a-rung.md` (validation predicates
as the fifth rung running in SES Compartment and Postgres plv8), and
`apps/chess/shell/handlers/referee.js` (complex evaluators and state machines
authored in Jessie).

The claim: **Jessie handlers and validations are pure reductions over frozen
state, but language purity cannot guarantee computational boundedness. Production
wants non-intrusive wall-clock cutoffs; property-based chaos testing wants
deterministic fuel budgeting, boundary-biased input generation by construction,
and deep immutability enforcement before any handler or validation merges.**

## Facts not to re-derive

- **Jessie is pure and unendowed.** Handlers and validations evaluate inside a
  hardened SES `Compartment({})` with zero ambient authority — no `Date.now()`,
  no `Math.random()`, no network, no timers.
- **The halting problem precludes general static analysis.** Whether a Jessie
  handler (such as a minimax game tree search or recursive pathfinder)
  terminates within acceptable interactive frame budgets depends on input state
  and recursion depth.
- **Handlers emit updates; validations emit booleans.** A handler returns
  `{ updates: [{ op, entity, id, row }] }` where `op` is `put`, `patch`,
  `delete`, or `insert`. A validation predicate returns a strict `boolean`. Both
  must never mutate their input `state` or `event`.

## Alternatives the code cannot argue

### 1. Test-time AST fuel instrumentation vs. Production runtime transforms

Code cannot show why AST metering lives strictly in test harnesses and not
production runtimes:

- **Production runtimes (`screen.js`, plv8) must run pristine code.** Injecting
  `--__fuel <= 0` at every loop head and function entry inflates code size,
  disrupts JIT compiler inline caches and loop unrolling, and complicates source
  maps.
- **Production failure modes differ from test failure modes.** In production,
  wall-clock timeouts (e.g. 50ms) prevent unresponsive UI frames or PostgREST
  statement timeouts without penalizing fast paths.
- **Test harnesses require strict determinism.** A 50ms wall-clock timer in CI
  fails intermittently under CPU contention. Fuel instrumentation counts logical
  execution steps (loop iterations and function entries), guaranteeing that a
  fuzz run consumes the identical number of steps on an M3 Max as on a slow CI
  worker.

### 2. In-process SES Compartment vs. External Moddable XS (`xst`) binary

- Moddable XS (`xst`) was evaluated as an alternative execution environment.
  While XS offers native C-level bytecode interpretation and tiny memory
  footprints on embedded microcontrollers, requiring an external C-compiled
  binary in the platform toolchain adds substantial build and distribution
  overhead across macOS, Linux, and Windows.
- Running thousands of property iterations through an external runner introduces
  heavy process-fork latency, while batching executions in uninstrumented XS
  risks hanging the runner on any non-terminating input.
- Using an in-process SES `Compartment` paired with Acorn AST fuel injection
  runs directly in Deno with zero native toolchain dependencies, executing
  hundreds of batched property runs per handler in milliseconds.

### 3. Boundary generation by construction vs. Rejection sampling

- Naive fuzzers generate random strings/integers and discard values that violate
  schema constraints (rejection sampling). When an entity field specifies
  `this in ["house", "hotseat"]` or `this.size() == 64`, rejection sampling
  wastes 99.9% of generator iterations.
- `plugins/pronto/arbitrary.ts` parses the CEL AST directly into `FieldBounds`,
  synthesizing exact `fc.constantFrom(...)`, `fc.integer({ min, max })`, or
  `fc.string({ minLength, maxLength })` generators. Seeds from `program.cue`
  are blended with point mutations, ensuring realistic structured data meets
  hostile boundary values without sampling waste.

### 4. Deep-freeze immutability vs. Proxy interceptors

- Handlers receive `(state, event)`. A rogue handler doing `state.rows.items.push(x)`
  violates the outbox and IVM contract by leaking local mutations outside
  declared `updates`.
- Wrapping inputs in read-only Proxies introduces observable identity divergence
  and runtime performance costs.
- Calling `deepFreeze` recursively freezes the plain input objects in-place. Any
  illegal write raises an immediate `TypeError` in the test harness, pinning the
  immutability invariant before deployment.

### 5. Integration into sayt `test` verb vs. `lint` verb

- `lint` is reserved for fast, pure static verification (`cue vet`, `caddy adapt`,
  `deno check`, `check-facts`, and `derive.ts --self-test`).
- In accordance with `plugins/sayt/loop.cue` doctrine ("a battery cannot land at
  lint however cheap it looks"), execution batteries belong in `test`. Fuel
  metering executes hundreds of randomized property iterations inside SES
  Compartments.
- `plugins/pronto/emit.cue` declares `fuel` under `#DefaultLoop.checks` with
  `verb: "test"`, automatically emitting the check into every app's `.say.yaml`.
- `plugins/pronto/.say.yaml` wires `just sayt -d plugins/pronto test` to run
  `battery.ts --self-test` directly.

