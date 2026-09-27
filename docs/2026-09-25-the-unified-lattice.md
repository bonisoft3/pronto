# The Unified Lattice: Cross-Cutting Concerns via CUE Unification

Written on 2026-09-25 from the verification architecture and effect classification
conversations across omnishell and pronto. Grounded in
[`2026-08-31-one-ladder-one-grammar.md`](2026-08-31-one-ladder-one-grammar.md)
(the durability ladder, DOM as bottom rung),
[`2026-09-21-an-entity-is-what-everything-points-at.md`](2026-09-21-an-entity-is-what-everything-points-at.md)
(entity-centric coherence), and
[`../../omnishell/docs/2026-09-24-unbreakable-machines.md`](../../omnishell/docs/2026-09-24-unbreakable-machines.md)
(unbreakable machines and effect safety spectrum).

The claim: **Pronto does not coordinate cross-cutting concerns through procedural
pipelines, middleware stacks, decorators, or multi-pass code generation. Instead,
every architectural concern is an orthogonal dimension of a bounded join-semilattice.
Unification (`&`) is the mathematical Greatest Lower Bound ($\sqcap$), and the
entire application — database schema, interaction lifecycles, offline synchronization,
fuel budgets, and test runners — is the deterministic fixed point of their intersection.**

---

## 1. The Architectural Failure of Procedural Coordination

In conventional application frameworks, cross-cutting concerns are layered into
imperative pipelines:
- An ORM defines persistence models.
- An API middleware chain inspects authentication and RLS headers.
- A client-side store manages optimistic mutation queues.
- A service worker intercepts offline network requests.
- A test harness mocks databases and sets arbitrary wall-clock timeouts.

This procedural composition suffers from three inescapable failure modes:

1. **Ordering Hazards**: Middleware $A$ assumes Middleware $B$ executed, but under
   Materialized SSR, offline flight, or background reconciliation, execution order
   inverts or halts halfway through.
2. **Declaration Drift**: An entity is marked "offline-capable" in a database migration,
   but requires duplicate manual declarations across React hooks, Redux actions,
   outbox tables, and end-to-end tests. If any layer drifts, the application fails at runtime.
3. **The Impossibility of Global Coherence Proofs**: A compiler cannot statically
   verify whether a UI button click could trigger an unhandled server refusal or
   infinite synchronization loop without running the entire distributed stack.

---

## 2. The 5 Orthogonal Dimensions of the Pronto Lattice

Pronto replaces pipeline composition with lattice unification. Every entity, screen,
machine transition, and test suite is evaluated at the intersection of five formal
dimensions:

```
               ┌───────────────────────────────┐
               │    Pronto Unified Lattice     │
               └───────────────┬───────────────┘
                               │
       ┌───────────────┬───────┴───────┬───────────────┐
       ▼               ▼               ▼               ▼
  Durability     Effect Safety     Access/RLS      Interaction     Testing/Fuel
    (Tier)         (Spectrum)       (#Access)      (Lifecycle)       (Budget)
 ─────────────  ───────────────  ─────────────   ───────────────  ──────────────
     tab          projection        public           gesture        LinkeDOM (1)
    device        ephemeral         owner          optimistic       Store Put (10)
    offline      compensable         peer           sync_ack        Outbox Sim (50)
    server        replicated       cluster           refused        Docker WAL (100)
                   exterior                           abort         Saga Task (250)
```

### Dimension 1: Durability ([`#Durability`](../schema.cue#L506))
Monotonic in expense and survival scope:
- `tab`: Survives navigation within the current tab; held in memory.
- `device`: Survives tab and browser restarts; persisted in client SQLite/IndexedDB.
- `offline`: Synced with cluster, operates 0ms local-first during severed network.
- `live`: Synced with cluster reactively; server truth pushed over CDC.
- `server`: Canonical cluster truth in PostgreSQL WAL; queried on demand.

### Dimension 2: Effect Safety Spectrum ([`#EffectLevel`](../../omnishell/machine.cue#L129))
Categorized by algebraic properties:
- `projection` (Level 0): Category $\mathbf{Set}$ morphism. Synchronous, pure DOM binding ($\Delta \text{World} = \emptyset$).
- `ephemeral` (Level 1): Monoid action on row. Local tab/device memory write (`put`, context assign).
- `compensable` (Level 2): Speculative optimistic mutation on TanStack DB with generation token $\tau$. Rollback occurs via outbox eviction and IVM re-fold upon `refused`.
- `replicated` (Level 3): Distributed sync across Postgres/Electric CDC. Bounded semilattice join (CALM theorem convergence).
- `exterior` (Level 4): Exterior world (Stripe, external webhook, email). Non-compensable: requires idempotency tokens $\tau$ and explicit Saga compensation states.

### Dimension 3: Access & Authorization (`#Access`)
Declarative row-level policy:
- `public`: Accessible to any reader.
- `owner`: Restricted to authenticated session subject matching `owner_id`.
- `peer`: Restricted to participants of the session/table (e.g. seated players in `apps/truco`).
- `cluster`: Restricted to backend microservices and internal pipeline workers.

### Dimension 4: Interaction & Transition Lifecycle
Closed statechart grammar (`#Machine`):
- `gesture`: User affordance dispatch (`click`, `input`, `contextmenu`).
- `optimistic`: Instant state transition and local effect dispatch.
- `sync_ack`: Asynchronous confirmation from Electric replication LSN.
- `refused`: Conflict rejection (409 unique violation or RLS refusal) triggering rollback.
- `delayed` / `abort`: Hierarchical timeout (`after:`) and sequence generation advance ($\tau + 1$).

### Dimension 5: Verification & Fuel Budget ([`FuelMeter`](../../omnishell/test/fuel-meter.ts))
Abstract step accounting replacing non-deterministic wall-clock timers:
- Scale: `projection` (1 fuel), `ephemeral` (10 fuel), `compensable` (50 fuel), `replicated` (100 fuel), `exterior` (250 fuel).

---

## 3. The Unification Algebra: Cross-Cutting Fixed Points

Because CUE unification is **associative, commutative, idempotent, and monotonic**,
cross-cutting requirements do not require pipeline glue. They evaluate as greatest
lower bounds:

### 1. Durability $\sqcap$ Effect Safety Level
The entity's durability statically bounds the admissible effect levels on it:
```cue
#DurabilityEffectLevel: {
	tab:     "ephemeral"
	device:  "ephemeral"
	offline: "compensable"
	live:    "compensable"
	server:  "replicated"
}
```
If an interaction attempts to declare an `ephemeral` effect on a `server` entity,
the types collide:
$$\text{"ephemeral"} \sqcap \text{"replicated"} = \bot \ (\_|\_)$$
The build fails at compile time (`cue vet`) before a single line of JavaScript runs.

### 2. Compensable Effects $\sqcap$ Machine Event Completeness
When a transition emits a `compensable` (Level 2) effect:
- The machine's event alphabet unifies with the requirement to handle `refused` and `sync_ack`.
- If the author omitted `refused`, [`machineLint`](../../omnishell/interpreter/lint.ts) fails loudly:
  > `compensable effect on "favorite" requires "refused" transition in machine to handle server conflict/rollback`
- Zombie client states become mathematically impossible.

### 3. Durability $\sqcap$ Authorization
Browser-durability rows (`tab`, `device`) are private by construction. Cluster rows (`server`, `live`, `offline`) require access rules:
```cue
if durability == "tab" || durability == "device" { access?: _|_ }
if durability != "tab" && durability != "device" { access?: #Access }
```
Unifying `access: { scope: "public" }` into a `tab` table produces $\bot$ (`_|_`),
preventing dead security configurations.

### 4. Effect Level $\sqcap$ Read-Only Storybook Posing
Storybook visual regression requires strict read-only execution. In the lattice:
$$\text{Storybook} \sqcap \text{EffectLevel} \le \text{"projection"}$$
[`storybook-injector.ts`](../../omnishell/test/storybook-injector.ts) mounts screens
with `handlers: false` and seeds the fixture row directly (`{ [machine.field]: targetState }`).
Any attempt by a story to dispatch an effect with level $\ge \text{"compensable"}$
is intercepted by the harness store and rejected immediately.

### 5. Effect Level $\sqcap$ Automated Test Runner Selection
The test harness does not guess which environment to invoke:
- Edge emits `projection` $\implies$ Storybook baseline check.
- Edge emits `ephemeral` $\implies$ LinkeDOM unit test (`FuelMeter` limit: 200).
- Edge emits `compensable` $\implies$ [`OutboxSimulator`](../../omnishell/test/outbox-simulator.ts) testing `immediate`, `refused`, and `offline` paths.
- Edge emits `replicated` $\implies$ `sayt integrate` (Docker container tier with PostgreSQL + Electric).

---

## 4. Why the Statement Holds

The claim that **"CUE unification is a superpower allowing Pronto to record the intersection of cross-cutting concerns and derive what is needed in each situation"** holds because:

1. **Zero Translation Layers**: You do not write a schema in SQL, an API type in OpenAPI, an interaction type in TypeScript, and a test fixture in JSON. The single CUE AST is the source of truth for the database DDL, the client state machine, the outbox simulator, and the fuel meter.
2. **Order Independence**: Whether you declare the test check first, the entity durability first, or the screen machine first, the unified result is identical.
3. **Monotonic Verification**: Every layer can add safety constraints without coordinating with the others. If any two constraints disagree, the system fails closed at compile time.
