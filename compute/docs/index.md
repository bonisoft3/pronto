# Compute Cortex machine

[[../machine.ts]] declares the durable composition; [[../rules.js]] contains its
bounded pure reducer. It uses [[../../docs/cortex#Durable work|Cortex durable work]]
and the existing Mecha reducer compiler. `idle` accepts invalidation and
scheduling; entering `active` invokes Durex once. Claiming freezes the current
requested revision without changing the invocation identity. Further
invalidations accumulate behind it. Publication completes the claimed revision;
a foreign-key failure can supersede it only when newer work is durable.

The relational adapter stores program definitions and retained inputs alongside
the authoritative machine instances. Required producer revisions are pinned
when a pending wave begins. Later producer invalidations cannot move that goal
indefinitely, and actual producer publication invalidates consumers again.
Lifecycle decisions live in the chart and its SQL preconditions; the TypeScript
worker performs capture, calculation and transactional publication. Coordinator
transactions run serializable, as Mecha requires; serialization conflicts and
deadlocks retry the whole transaction with the same frozen calculation output.

Generate the shipped Mecha artifact from the repository root:

```sh
deno run --no-config --allow-read --allow-write plugins/pronto/compute/generate.ts \
  libraries/mecha/services/compute/batch-machine.sql
```

`deno task test:hybrid` in `plugins/pronto` verifies the artifact matches current
compiler output and checks the pure claim/successor behavior. The compute service
runs its coordinator regressions against a pinned PostgreSQL image with PLV8;
Durex's adapter separately tests SIGKILL recovery and coexistence with external
workers.

A compiler fingerprint protects installed machine schemas from silent changes.
The first upgrade from the previous TypeScript coordinator accepts only drained
state, preserving completed revision counters. An unfinished previous claim is
refused: drain it with the previous runtime before upgrading. Subsequent machine
schema changes require an explicit migration. Bootstrap repairs only the pinned
read-committed guard artifact to its pinned serializable replacement, under the
worker singleton lock and in the initialization transaction. Earlier compiler
artifacts and unknown fingerprints remain refused. The [Durex upgrade](https://github.com/bonisoft3/mecha/blob/v0.22.0/services/durex/docs/index.md#upgrade-from-internal-airlock-work)
retains pending claims and committed receipts while moving internal work out of
Airlock and replacing the compiled dispatcher. Program/schema changes still
refuse incompatible unfinished inputs.

Graphile's job receipt and the machine's publication revision are distinct.
Durex retains invocation outcomes so lost acknowledgment cannot repeat a
committed publication. The private dispatcher also records transition receipts;
retention/compaction remains an operational consideration for sustained volume.
The initial coordinator runs one worker and captures complete query inputs.
This is durable orchestration, not incremental numerical computation or a
Feldera executor. See [[../../docs/pipelines-and-schedules#Computations|the live
computation contract]] and the [[../../docs/decisions/2026-10-19-duckstream-runtime|runtime design]].
