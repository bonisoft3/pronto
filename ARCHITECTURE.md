# Architectural Summary: The Pronto Constrained-Execution Engine

Pronto shifts AI-driven software development from **probabilistic generation** to **architecture-constrained compilation**. Instead of generating arbitrary code across unconstrained runtimes, an LLM compiles high-level product intent into a formally verifiable, symmetric, local-first target architecture.

## 1. The Core Paradigm & The Review Ladder

Pronto divides the application lifecycle into three distinct artifacts, assigning clear ownership and review boundaries to Humans, AI, and deterministic machines.

*   **`brief.md` (Product Altitude):** Ranging from a single tweet to an AWS 6-pager. This defines the business case and intent. 
    *   *Ownership:* Human-authored, human-reviewed.
*   **`ir.html` (Engineering Altitude):** A loose specification mixing free-form prose with strictly validated invariants (XState charts, Mermaid flows, Lean expressions). 
    *   *Ownership:* LLM-authored, mixed (Human/LLM) reviewed.
*   **`program.cue` & Generated Code (Machine Altitude):** The final CUE configurations, Jessie handlers, and SQL schemas. 
    *   *Ownership:* LLM-generated, Machine-reviewed (via `cue vet`, strict grammars, and test cascades). No human reviews below this rung.

### Unison-Style Evolution (The Diffing Engine)
Similar to the Unison programming language, every asset, component, and invariant in `ir.html` is pinned with a machine-readable ID. As the application evolves, the LLM does not regenerate the codebase from scratch. It reads the pinned IDs, understands the semantic diffs, and updates only the altered sub-graphs. This ensures IR ↔ CUE drift is a checkable mathematical property, not a hope.

---

## 2. The Seven Algebraic Pillars

Pronto models its execution surface as a composition of well-defined algebraic structures. This enables the platform’s operational semantics to be formally verified in **Lean 4** via a one-time meta-proof:

| Component | Technology | Formal Algebraic Model | Role in the System |
| :--- | :--- | :--- | :--- |
| **1. Schemas** | CUE | Bounded Join-Semilattice | Structural typing, monotonic constraint unification. |
| **2. State Machines** | XState | Finite State Transducer | Discrete lifecycle and transition topology. |
| **3. Core Storage** | Postgres / PGlite | Monotone Relational Store | Durable persistence, transaction serialization. |
| **4. Handlers** | Jessie + Fuel | Total Pure Function | Pure business reducers; fuel bounds loops to enforce termination. |
| **5. UI Effects** | Omnishell (TEA) | State-Action-Effect Monad | Enforces single data path, forms-only mutations. |
| **6. Read Sync** | ElectricSQL / TanStack | Lattice Homomorphism | Incremental View Maintenance (IVM); projects base tables to client views. |
| **7. Partition Clock** | Postgres Sequence | Monotonic Sequencer ($\mathbb{N}$) | Establishes a Newtonian timeline per aggregate root. |

---

## 3. Dataflow: Partitioned Newtonian Writes + IVM Reads

By abandoning coordination-free CRDTs for relational state and adopting **Figma’s partitioned sequencer model**, Pronto avoids distributed convergence paradoxes while retaining 0ms optimistic UI reactivity.

1.  **Optimistic UI:** Client runs Jessie/XState reducers instantly, mutating the TanStack DB view.
2.  **The Sequencer:** Mutation is pushed to the Postgres backend, which assigns an authoritative, monotonic sequence ID and evaluates the Jessie reducer.
3.  **IVM Derivation:** ElectricSQL streams the declarative shape deltas down to the client.
4.  **Rebase / Rollback:** The client applies the authoritative base delta, rolls back unconfirmed optimistic mutations, and re-applies them on top of the new baseline.

---

## 4. Headless IVM Sinks: Eliminating Heavy Infrastructure

The symmetry between frontend reactivity and backend execution allows headless TanStack DB/Jessie processes to replace external orchestrators.

*   **Replacing Temporal:** Asynchronous processes run as reactive IVM sinks subscribing to `PENDING` states. If a worker crashes, IVM instantly repopulates the pending task queue on reboot.
*   **Replacing Flink (Streaming SQL via `d2ts`):** The LLM authors standard streaming SQL in `ir.html`. A deterministic WASM parser (`sqlglot-rust`) converts the query into a logical relational plan, transpiling it directly to `@electric-sql/d2ts` (Differential Dataflow in TypeScript) operator pipelines running safely inside SES Compartments.

---

## 5. Future Direction: Fractal Statecharts & Relational Model Checking

Pronto aims to extend XState from UI components to **Macro-Statecharts**, orchestrating the entire distributed lifecycle (Client → Network → Sequencer → Sync) as a single, fractal state machine. This formally models the **Saga Pattern** for long-running, cross-boundary transactions.

By encoding this end-to-end topology in `ir.html`, Pronto uses **DuckDB as a Relational Model Checker**. Before compiling a single line of runtime code, recursive DuckDB CTEs traverse the distributed state graph to mathematically prove:

1.  **Saga Compensation Guarantees:** Ensuring every path that encounters a failure network event strictly transitions to a compensating state (e.g., refunding a ledger), preventing stranded assets.
2.  **Liveness & Timeout Enforcement:** Querying the graph to ensure no outbound network state lacks a defined transition for `TIMEOUT` or `ERROR`, guaranteeing the UI never hangs indefinitely.
3.  **Optimistic Rollback Completeness:** Verifying that a server rejection strictly forces the local client macro-machine into a deterministic `Rebase` state.

This transforms Pronto from a robust full-stack framework into a rigorous protocol verifier—forcing the LLM to architect a flawless distributed topology before execution begins.
