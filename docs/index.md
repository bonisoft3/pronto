# pronto

# Entry points

Writing an app needs these entries; the rest of this index is for when a gate or a lint names a document.

* [Agents](../AGENTS.md) - howto: Start here — time travel, the five languages, the lineage, the stack, the component split, machines, and the loop, in one screen.
* [Idioms](../idioms/README.md) - howto: One small compiled screen per concept — reduce, forms, fold, machine and time — to copy before reading a full app.
* [Bootstrap](../skills/pronto-turn/references/bootstrap.md) - howto: the pinned seed phase that makes a repository a pronto consumer module with its sayt wrappers and toolchain.
* [pronto-turn](../skills/pronto-turn/SKILL.md) - howto: the outer loop an agent drives over a pronto app — scope, sayt verbs, review by consequence, one simplify pass, evidence.
* [One turn](../commands/turn.md) - howto: the Claude Code command that drives one turn of the outer loop over a problem statement.

# Reference

Open one when a gate or a lint names it; the idioms already show what each describes.

* [Pronto](../README.md) - concept: A programming language whose source is markdown and whose compiler is an LLM, targeting an architecture in which whole classes of bugs cannot exist.
* [Writing a pronto app](../GUIDE.md) - howto: The app author's tour — starting an app and running a turn, the layout, the build loop, data modelling, screens, i18n, the capability bar, testing and release.
* [Pronto artifact spec](../SPEC.md) - reference: What a conforming brief.md, ir.html and program.cue contain, and the lints that enforce it.
* [The pronto prelude](../prelude.md) - reference: The component knowledge implicit in every brief-to-ir compilation — entities, durability, pipelines, screens, capability, identity, hatches, the team, the loop, tiers and tests.

# For contributors

How pronto works inside, what it decided and what it superseded.

* [Contributing to pronto](../CONTRIBUTING.md) - howto: Changing pronto itself — the two invariants, the commands, where a compiler check is declared, and where each subsystem is argued.
* [Pending](../PENDING.md) - metric: What pronto argues for and has not built, and what a measurement found that nothing has fixed, each checked against this tree on the date given.

## Subsystems

* [[cortex|Cortex machines]] — the app's screens over its Mecha machines, each a fold that reaches its machine through surface rows or plays it in place.

* [The compiler and its review ladder](compiler.md) - concept: How a brief becomes an app — two model hops above deterministic rungs, what `cue export` emits and where it lands, what the bijection holds a person to sign, and how pronto reaches the parts it configures.
* [Component contracts](component-contracts.md) - concept: What each part of a pronto program — the app, the terminal, the cluster, the loop and the build graph — declares as its state, its capabilities and its surface, how data flows between them as one graph, and the dual-plane kinetic contract for universal time travel.
* [Types and identity](types-and-identity.md) - concept: What a field's value is and what an entity is: fifteen portable types, each equal exactly when its canonical strings are, and a minted type id with ordinals, so a name is a label nothing is keyed on.
* [Schema changes](schema-change-admission.md) - concept: What pronto admits when an entity changes — additions and retirements, never a rename, drop or retype — and the four readers that refuse the rest, each seeing what the others cannot.
* [The lattice](lattice.md) - concept: The durability ladder and the dimensions declared beside it — visibility, effect level, validation, fuel — how one writer per fact keeps the ladder free of merges, and which combinations the code refuses today.
* [Access](access.md) - concept: How an entity's declared access becomes the scope column, the tenancy-floor call and the policies at the cluster and the same rule in the browser, who stamps a row's owner, and how a reader inside an aggregate they cannot see gets an exact count.
* [Pipelines and schedules](pipelines-and-schedules.md) - concept: How a derived entity is kept from another's changes — a pure transform over an absolute read, delivered at least once into an idempotent sink — the shapes a program declares, when a value earns one, how a database function is called when its tables change, and how periodic work becomes rows.
* [Localization](localization.md) - concept: How an app's declared locales become catalogues, addresses, door redirects and crawlable documents, where locale-dependent code may run, and how text sorts — each gap a refusal before release, never a fallback that ships.
* [The design scale](design-scale.md) - concept: The value vocabulary beneath an app's design roles: rungs quoted byte for byte from vendored Open Props and Primer, a lint that refuses a literal wherever a rung exists, and a hatch with two checkable reasons.
* [Screens](screens.md) - concept: How pronto compiles a screen — what it derives from the markup, what it checks the markup against, and how each route's first document is rendered and cached.
* [Identity](identity.md) - concept: Social sign-in beside the passkey through one operator's broker on Ory Hydra — the app embeds `identity.#Signin`, each app a tenant with pairwise subjects, the broker brought up by the app's own launch.
* [Release targets](release-targets.md) - concept: Where a program is released: each target in meta.targets becomes a sayt release@<target> rule carrying the whole app on one tier of mecha's ladder; pages, cloudflare, and docker are built, and the clouds and k8s are designed.

## Decisions

* [Review by consequence](decisions/2026-08-27-review-by-consequence.md) - decision, partially built: Levies ir coverage by what a write reaches — an update to a `tab` entity machine-checked only, one reaching `device` or above owing an ir element — with handler reach derived from the charts naming it, and an explicit write capability deferred.
* [Owner stamping](decisions/2026-08-31-owner-stamping.md) - decision, unbuilt: Moves a row's owner stamp from the apps' `default: "auth_uid()"` column defaults to an emitted per-table BEFORE INSERT trigger beside the policies, and narrows `#Field.default` to what a bare Postgres has, so the data-holding steps need nothing from the rules.
* [The next vocabulary](decisions/2026-09-08-the-next-vocabulary.md) - decision, accepted: Chooses the platform's next token layer — DTCG as the format, Tailwind's namespaces as the grammar, shadcn's names as the roles — for the names a model will write, of which only the contrast grading is built.
* [Pronto written in pronto](decisions/2026-09-27-pronto-written-in-pronto.md) - decision, unbuilt: The whole development loop in a browser tab — authoring, compilation, running and version control, with sayt's verbs run by an in-tab executor, inside an IDE that is itself a pronto app — none of which exists yet.
* [Hybrid machines](decisions/2026-09-29-hybrid-machines.md) - decision, partially built: Extending unbreakable statecharts to the backend — splitting client UI, relational transactions, streaming IVM / lake compute, and durable Level 4 orchestration into four pure-to-external tiers.
* [External effects](decisions/2026-10-03-external-effects.md) - decision, partially built: How a machine reaches outside the cluster — a state invokes an external effect, the interpreter claims a ledger row and enqueues a Graphile job in the transition's commit, mecha's airlock runs the effect's Jessie handler against one declared sink through its Dapr binding, and the outcome returns through the interpreter as the machine's next event.
* [Agent onboarding](decisions/2026-10-14-agent-onboarding.md) - decision, partially built: What a cold agent needs to write its first pronto app inside a 128k context — an idioms package shipped and gated with the module, a first generate that compiles a hand-authored program, an author's card under 8k tokens, links that resolve in the mirror, and gates that refuse an app nobody can play.
* [Machine contracts](decisions/2026-10-15-machine-contracts.md) - decision, partially built: Rules out the races and stalls Truco's review found by construction — serializable steps, recorded time and randomness, rules declaring the inputs they read and the fields they write, and an app-independent lint that every event carries what its rules read, no reachable state is stuck, and every projected value fits its column — instead of simulating backends; Z3 deferred until a property needs it.
* [Releases by content](decisions/2026-10-16-releases-by-content.md) - decision, proposed: Replaces per-file revalidation, verified live-update releases and the edge's content addresses with the third for every target, so a page cannot run files from two deployments, a first visit never restarts, and a tab left open takes each deployment at the least disruptive level its changes allow.
* [Endowed Babylon](decisions/2026-10-22-endowed-babylon.md) - decision, accepted, partially built: The kinetic plane paints with raw Babylon in a worker whose globals are pruned to an allow-list and whose CSP forbids connections and stray code, while the simulation whose events reach a machine stays in the realm lockdown seals, since Babylon 9.31 cannot run sealed; a tamed facade and a name deny-list are rejected.
* [The kinetic machine](decisions/2026-10-23-kinetic-machine.md) - decision, accepted, partially built: the DOM plane (IVM, one to many) composes the kinetic plane (GGPO, few to few) through a `via kinetic` Cortex child that lifts app milestones at confirmed frames with their inputs; the HUD split by refresh rate, audio as a Jessie sound role, initials as a DOM-plane form, and 1v1 racing over GGRS on a data channel, its duel engine and netcode built.

## Archive

* [Design: Pronto — AI App Builder With Constraint-Cascade Architecture](archive/2026-06-12-design-constraint-cascade.md) - decision, superseded: The startup-mode design — constraint-cascade generation and a scale-to-zero runtime against the prompt-to-app category — whose business analysis still stands.
* [A numeric stage](archive/2026-09-30-numeric-stage.md) - decision, built: A pronto rung for computation bloblang and Jessie cannot carry — a compute service fed by the lake, writing back through CRUD; proposed on JAX, revised to Jessie planning Wasm jobs on Deno.
* [DuckStream tempo and derivation invariants](archive/2026-10-01-duckstream-tempo-and-derivation.md) - decision, built: Replaces physical pipeline flags with application-level tempo (hot vs cold) and operator endowments, proving screen-mutation feedback loops statically in CUE and verifying SQL algebra via DuckDB AST serialization. Contract moved to [pipelines and schedules](pipelines-and-schedules.md#the-shapes).
* [Held seeds](archive/2026-10-02-held-seeds.md) - decision, built: Moves an archive of seed rows out of the program's CUE package into a JSON file judged by `cue vet` against the entities only when it or they change, after golaberto's 18,782-line seed made every evaluation of the program over ten times slower. Contract moved to [the guide](../GUIDE.md#seed-rows).
* [Web platform envelope](archive/2026-10-03-web-platform-envelope.md) - decision, built: Coordinates the shell metadata, HTTP door routing, and single-file bundling for browser chrome, crawlers, and LLMs — favicons, manifest, social cards, llms.txt, well-knowns, and preconnects. Contract moved to [component contracts](component-contracts.md#web-platform-envelope).
* [Jessie import](archive/2026-10-23-jessie-import.md) - decision, built: A Jessie module graph for kinetic engines, each module precompiled at build time by Endo's ModuleSource and imported by the terminal's SES Compartment; against a runtime parser, a linker of pronto's own and inlining by hand. Contract moved to [the kinetic host](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/kinetic.md#a-jessie-engine).

* [[archive/2026-10-10-hatches|Hatches]] — built decision: derive effect levels and delivery, declare escape hatches, and review entities and machines by consequence. Contracts live in [[../SPEC|the artifact spec]], [[../GUIDE|the guide]] and [the terminal](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/terminal.md).
* [[archive/2026-10-12-lifecycle-guards|Predicates belong to lifecycle transitions]] — built decision: guarded writes share the machine interpreter; access remains RLS.
* [[archive/2026-10-22-edge-drains|Drains where no stream runs]] — built decision: the page's and the edge's clusters call the drains and sweep the schedules themselves, bloblang left to the release's snapshot. Contract moved to [pipelines and schedules](pipelines-and-schedules.md#drains) and mecha's [drains and the clock](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/browser.md#drains-and-the-clock).
