---
type: design
title: Automatic application verification
status: implemented bounded inventory, ARIA and workflow checks; opaque semantics and exploration limits remain explicit
---

# Automatic application verification

Pronto should derive useful application checks from the program it already
compiles, reducing dependence on LLM-authored scenarios. The target is an
application whose declarations are individually valid but collectively omit,
contradict or misconnect behavior. A correct framework can faithfully execute
such a broken application.

Prioritize unhappy paths: errors, refusals, cancellation, timeouts, exhausted
retries and stale completions. Their producers and consumers should be as
inspectable as the successful path. The author supplies the program and, when
needed, a domain invariant; the framework derives obligations, inputs and
execution traces. It must not require a second handwritten application model.

This is a proposed verification architecture. The inventory below distinguishes
existing checks from experiments and unimplemented capabilities. No current
check establishes whole-application correctness or race freedom.

## Oracle provenance

An oracle decides whether behavior is acceptable; an input generator or graph
walk decides which behavior to examine. Generating more traces cannot compensate
for an absent oracle. Moving an authored assertion from a test into CEL improves
its reuse and scope of checking, but does not make the author remember a missing
requirement.

Barr, Harman, McMinn, Shahbaz and Yoo's
[The Oracle Problem in Software Testing: A Survey](https://philmcminn.com/publications/barr2015.pdf)
(IEEE TSE, 2015) distinguishes specified, derived and implicit oracles, alongside
approaches to the absence of an automated oracle. Specified oracles use explicit
specifications; derived oracles draw expectations from other artifacts; implicit
oracles recognize broadly unacceptable behavior without a domain specification.
The survey explicitly notes that implicit oracles are contextual, not universal.

Pronto uses four working names to distinguish the authority behind a rule.
These refine our strategy; they are not Barr's taxonomy under new names.

| Oracle class | Authority | Example | Application-specific decision |
| --- | --- | --- | --- |
| Consistency checks | Logic and declared semantics | Required constraints cannot simultaneously hold | None beyond the declarations being checked |
| Completeness checks | A framework contract defining what must be specified | A published failure outcome has no disposition | Supply the missing disposition or explicitly declare intentional ignoring |
| Policy checks | An adopted quality policy | Contrast or obstruction of interactive controls | Normally none; scoped exceptions need a reason |
| Domain contracts | Application requirements | An account balance must remain nonnegative | Decide and express the requirement |

An impossible guard alone is not a contradiction: disabling that transition may
be intentional. It conflicts with a declaration requiring that transition to be
feasible. A state without a handler is not inherently incomplete: terminal states
and ignored events can be valid. Completeness requires an explicit definition of
what must be covered. Visual overlap is not universally wrong either; the visual
battery's policies define which obstruction is unacceptable and where they apply.

Oracle class, coverage route and verification layer are independent dimensions.
An exclusivity obligation derived from a single-selection contract can be checked
by graph analysis, Z3 or execution. Calling a test generated does not identify
where its expectation came from. Contradictions are relative to trusted semantics;
a contradiction in the specification does not identify which declaration is wrong.

## Three routes to coverage

Use these routes in order when adding a check. Route numbers do not identify the
four oracle classes above.

1. **Apply reusable default checks without additional application authoring.**
   Always first look for a consistency, completeness or quality rule that can
   apply to existing declarations across apps. The visual battery demonstrates
   this route: an author need not remember to write a contrast or obstruction
   assertion for every screen. Its power comes from reusable oracles, not merely
   from generating screenshots. Expand this route to unhappy paths as well.
2. **Derive obligations from semantic contracts needed to build the app.**
   This is the underdeveloped route. Selection cardinality, resource ownership,
   invocation lifetime, operation identity and source/sink guarantees should
   create obligations automatically. Declare the semantics once; do not require
   a separately authored test that repeats their consequences. A navigation
   binding may establish exclusivity and agreement with the authoritative
   destination, but latest-request-wins must come from a declared contract or an
   explicit navigation policy, not from the verifier's guess.
3. **Author domain contracts and acceptance examples for the remaining intent.**
   Prefer invariants adjacent to their machines or composition over bespoke
   procedural tests for properties that the supported checker can enforce.
   Preserve acceptance examples for concrete business outcomes and independent
   evidence that the contract itself captures the requirement. The framework
   supplies supported inputs and schedules; the author supplies domain meaning.

The aim is fewer independent correctness decisions for an LLM to remember.
Turning every existing test into an LLM-authored CEL expression achieves only
part of that aim. When a recurring domain contract can be expressed by a reusable
semantic role, promote it to route 2; promote broadly applicable checks to route 1.
Do not promote an application preference into an unqualified universal rule.

## Implemented checks

The existing type, CUE and DuckDB checks establish supported structural facts.
The new obligation inventory reuses these declarations; it does not inspect SQL
or Jessie implementations to manufacture application contracts.

| Surface | Checker | Claim |
| --- | --- | --- |
| ARIA declarations | [omnishell/check-aria.ts](https://github.com/bonisoft3/omnishell/blob/v0.23.0/check-aria.ts) | Supported cardinality, required roles and references; dynamic ownership, fragment boundaries and ARIA inside mounted item templates remain explicitly unchecked. |
| Presentation dependencies | [omnishell/check-presentation.ts](https://github.com/bonisoft3/omnishell/blob/v0.23.0/check-presentation.ts) | A supported reachable UI state has a declared presentation consumer or interaction. Declared CSS use does not prove computed visibility. |
| Source/outcome wiring | [[../check-outcomes.ts]] | Declared outcomes have dispositions, names/types agree, and attachment references match their declared hosts. |
| Finite workflows | [[../check-workflows.ts]] | Completion and reachability in the supported projected host graph. Opaque guards branch nondeterministically; this is not data feasibility or eventual delivery. |

[[../check-verification.ts]] combines declaration obligations without presenting
satisfied counts as a correctness percentage. Each diagnostic names its property,
status, evidence, assumptions and oracle authority. Supported violations fail the
gate; unchecked results identify work the checker cannot establish.

Workflow projection uses [[../workflow-control.ts|XState]] for ordinary charts and
[[../workflow-omnishell-control.ts|the actual terminal machine engine]] for row
charts. Those hosts differ in persisted-state restoration and event handling;
using one as an oracle for the other would confuse framework semantics with
application errors. Persistent services are not required to terminate. Finite
invocations inside them still carry completion and lifetime obligations.

Invocation metadata identifies which adapter can produce completion/error events
and who owns attachment cleanup. Source disposal does not cancel accepted durable
work. A query source publishes facts, while an effect's sink owns execution and
delivery guarantees. No checker silently imposes at-least-once delivery.

## Input and trace coverage

The existing mounted chart walker executes the terminal against a simulated seed
store. Its local transition checks do not establish database authorization,
defaults, triggers or delivery. A full-screen mount can execute unrelated backend
handlers before reaching a local chart. Treating their writes as successful would
be an assumption about the application, not proof of those effects.

Coherent persisted witnesses and execution against an isolated authorized backend
remain extensions. A stricter walker must report unsupported server effects as
coverage gaps; a captured startup snapshot alone cannot model later lease renewals
or other timed writes. These extensions are separate from the static inventory.

The typed handler battery supplies portable boundary inputs and checks actual
caged handlers. It does not know all cross-field invariants or producer
preconditions. CEL is the preferred existing language for domain constraints;
solver-guided correlated inputs remain a separate extension and cannot supply a
missing business oracle.

## Four layers and backend counterparts

| Layer | Frontend | Backend |
| --- | --- | --- |
| Structural inventory | Declared consumers, references, ownership and cardinality | Source/event/type linkage, effect outcomes and finite workflow obligations |
| Conditional analysis | Supported chart and input predicates | Supported control/effect contracts, with unsupported SQL/Jessie internals left opaque |
| Fast execution | Linkedom, actual terminal interpreter, held clocks and witness rows | Actual reducers and compatible embedded database replay |
| Real host | Browser layout, native properties, navigation and scheduling | Native PostgreSQL transactions, admission locks, workers and external delivery |

Reuse the same declared oracle as far as its meaning survives each host. Reduce
trace breadth as execution cost rises. Passing a symbolic or embedded model does
not establish native isolation, layout, delivery or race freedom. Differential
checks between hosts establish framework conformance; they are not independent
application oracles.

## Authoring and test retirement

Start with reusable consistency and quality policies, then derive obligations
from contracts already needed by the application. ARIA is useful because it
provides existing role and ownership semantics instead of a new assertion DSL.
Backend ownership, cardinality and workflow obligations likewise need explicit
scope; authorization and occupancy are different properties.

Guide application authors toward acceptance criteria and CEL invariants next to
the owning declarations. A contract is usually cheaper to reuse across traces
than a bespoke scenario, but the author still has to identify its requirement.
Do not pretend this removes the oracle problem. Mandatory declarations should
express capabilities the compiler genuinely needs, rather than force arbitrary
business semantics through unification.

Prioritize failure, timeout, refusal, cancellation and stale-completion paths.
Retain application tests for business meaning and unsupported boundaries. Retire
a scenario only when the same failure is demonstrably caught by a cheaper,
maintained gate. Historical before/after replay is useful evidence; passing
current apps alone is not evidence that a verifier detects their past defects.

The navigation lifetime implementation restores the committed machine attachment
when presentation recovers from failure. These are framework corrections; they
must not be counted as newly discovered application bugs.
