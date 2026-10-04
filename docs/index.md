# pronto

# Entry points

* [Pronto](../README.md) - concept: A programming language whose source is markdown and whose compiler is an LLM, targeting an architecture in which whole classes of bugs cannot exist.
* [Writing a pronto app](../GUIDE.md) - howto: The app author's tour — starting an app and running a turn, the layout, the build loop, data modelling, screens, i18n, the capability bar, testing and release.
* [Pronto artifact spec](../SPEC.md) - reference: What a conforming brief.md, ir.html and program.cue contain, and the lints that enforce it.
* [The pronto prelude](../prelude.md) - reference: The component knowledge implicit in every brief-to-ir compilation — entities, durability, pipelines, screens, capability, identity, hatches, the team, the loop, tiers and tests.
* [Contributing to pronto](../CONTRIBUTING.md) - howto: Changing pronto itself — the two invariants, the commands, where a compiler check is declared, and where each subsystem is argued.
* [Pending](../PENDING.md) - metric: What pronto argues for and has not built, and what a measurement found that nothing has fixed, each checked against this tree on the date given.
* [pronto-turn](../skills/pronto-turn/SKILL.md) - howto: the outer loop an agent drives over a pronto app — scope, sayt verbs, review by consequence, one simplify pass, evidence.
* [Bootstrap](../skills/pronto-turn/references/bootstrap.md) - howto: the pinned seed phase that makes a repository a pronto consumer module with its sayt wrappers and toolchain.
* [One turn](../commands/turn.md) - howto: the Claude Code command that drives one turn of the outer loop over a problem statement.

# Subsystems

* [The compiler and its review ladder](compiler.md) - concept: How a brief becomes an app — two model hops above deterministic rungs, what `cue export` emits and where it lands, what the bijection holds a person to sign, and how pronto reaches the parts it configures.
* [Component contracts](component-contracts.md) - concept: What each part of a pronto program — the app, the terminal, the cluster, the loop and the build graph — declares as its state, its capabilities and its surface, how data flows between them as one graph, and the dual-plane kinetic contract for universal time travel.
* [Types and identity](types-and-identity.md) - concept: What a field's value is and what an entity is: fifteen portable types, each equal exactly when its canonical strings are, and a minted type id with ordinals, so a name is a label nothing is keyed on.
* [Schema changes](schema-change-admission.md) - concept: What pronto admits when an entity changes — additions and retirements, never a rename, drop or retype — and the four readers that refuse the rest, each seeing what the others cannot.
* [The lattice](lattice.md) - concept: The durability ladder and the dimensions declared beside it — visibility, effect level, validation, fuel — how one writer per fact keeps the ladder free of merges, and which combinations the code refuses today.
* [Access](access.md) - concept: How an entity's declared access becomes the scope column, the tenancy-floor call and the policies at the cluster and the same rule in the browser, who stamps a row's owner, and how a reader inside an aggregate they cannot see gets an exact count.
* [Pipelines and schedules](pipelines-and-schedules.md) - concept: How a derived entity is kept from another's changes — a pure transform over an absolute read, delivered at least once into an idempotent sink — the shapes a program declares, when a value earns one, and how periodic work becomes rows.
* [Localization](localization.md) - concept: How an app's declared locales become catalogues, addresses, door redirects and crawlable documents, where locale-dependent code may run, and how text sorts — each gap a refusal before release, never a fallback that ships.
* [The design scale](design-scale.md) - concept: The value vocabulary beneath an app's design roles: rungs quoted byte for byte from vendored Open Props and Primer, a lint that refuses a literal wherever a rung exists, and a hatch with two checkable reasons.
* [Screens](screens.md) - concept: How pronto compiles a screen — what it derives from the markup, what it checks the markup against, and how each route's first document is rendered and cached.
* [Release targets](release-targets.md) - concept: Where a program is released: each target in meta.targets becomes a sayt release@<target> rule carrying the whole app on one tier of mecha's ladder; pages is built, and cloudflare, the clouds and k8s are designed.

# Decisions

* [Review by consequence](decisions/2026-08-27-review-by-consequence.md) - decision, unbuilt: Levies ir coverage by what a write reaches — an update to a `tab` entity machine-checked only, one reaching `device` or above owing an ir element — with each handler declaring what it may write, where today every program object owes one.
* [Owner stamping](decisions/2026-08-31-owner-stamping.md) - decision, unbuilt: Moves a row's owner stamp from the apps' `default: "auth_uid()"` column defaults to an emitted per-table BEFORE INSERT trigger beside the policies, and narrows `#Field.default` to what a bare Postgres has, so the data-holding steps need nothing from the rules.
* [The next vocabulary](decisions/2026-09-08-the-next-vocabulary.md) - decision, accepted: Chooses the platform's next token layer — DTCG as the format, Tailwind's namespaces as the grammar, shadcn's names as the roles — for the names a model will write, of which only the contrast grading is built.
* [Pronto written in pronto](decisions/2026-09-27-pronto-written-in-pronto.md) - decision, unbuilt: The whole development loop in a browser tab — authoring, compilation, running and version control, with sayt's verbs run by an in-tab executor, inside an IDE that is itself a pronto app — none of which exists yet.
* [Hybrid machines](decisions/2026-09-29-hybrid-machines.md) - decision, unbuilt: Extending unbreakable statecharts to the backend — splitting client UI, relational transactions, streaming IVM / lake compute, and durable Level 4 orchestration into four pure-to-exterior tiers.

# Archive

* [Design: Pronto — AI App Builder With Constraint-Cascade Architecture](archive/2026-06-12-design-constraint-cascade.md) - decision, superseded: The startup-mode design — constraint-cascade generation and a scale-to-zero runtime against the prompt-to-app category — whose business analysis still stands.
* [A numeric stage](archive/2026-09-30-numeric-stage.md) - decision, built: A pronto rung for computation bloblang and Jessie cannot carry — a compute service fed by the lake, writing back through CRUD; proposed on JAX, revised to Jessie planning Wasm jobs on Deno.
* [DuckStream tempo and derivation invariants](archive/2026-10-01-duckstream-tempo-and-derivation.md) - decision, built: Replaces physical pipeline flags with application-level tempo (hot vs cold) and operator endowments, proving screen-mutation feedback loops statically in CUE and verifying SQL algebra via DuckDB AST serialization. Contract moved to [pipelines and schedules](pipelines-and-schedules.md#the-shapes).
* [Held seeds](archive/2026-10-02-held-seeds.md) - decision, built: Moves an archive of seed rows out of the program's CUE package into a JSON file judged by `cue vet` against the entities only when it or they change, after golaberto's 18,782-line seed made every evaluation of the program over ten times slower. Contract moved to [the guide](../GUIDE.md#seed-rows).
* [Web platform envelope](archive/2026-10-03-web-platform-envelope.md) - decision, built: Coordinates the shell metadata, HTTP door routing, and single-file bundling for browser chrome, crawlers, and LLMs — favicons, manifest, social cards, llms.txt, well-knowns, and preconnects. Contract moved to [component contracts](component-contracts.md#web-platform-envelope).
