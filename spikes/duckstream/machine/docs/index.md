# Bounded batch protocol spike

This fixture uses the existing [[../../../../mecha-reducer.ts|Mecha reducer
compiler]], [[../../../../mecha-runtime.js|bounded reducer runtime]], and SES
executor. It introduces no scheduler, worker runtime, or app changes. The
[[../machine.test.ts|tests]] compile [[../machine.ts|the chart]] with
[[../rules.js|pure rules]] and execute its emitted reducer with the existing
fuel meter. Existing compiler imports bring pinned Acorn dependencies; the
fixture adds none.

From the repository root:

```sh
deno test --no-config --allow-read --allow-env plugins/pronto/spikes/duckstream/machine/machine.test.ts
```

The seven tests cover invalidation during work and publication; immutable claims
across failure/retry; lease boundaries and stale attempts; lost replies,
duplicate and conflicting completions; publication identity; bounded counters;
and each placement of an invalidation around completion and acknowledgment. A
JSON round trip tests serialized reducer state, not a database crash.

## Protocol

One instance represents one rebuildable materialization. `requested` is the
maximum observed source revision, `claimed` is the revision captured by the
active batch, and `published` advances only after publication acknowledgment.
The invariant is `published <= claimed <= requested`. Idle does not mean caught
up: an idle instance with `requested > published` is eligible for claim.

A claim from idle captures `requested`; a retry retains its existing `claimed`
revision. Each claim issues a new monotonic attempt ID and a lease deadline. The
fixture uses a 100 ms lease for deterministic boundary tests, with time supplied
through Mecha's authoritative context. Expiry explicitly moves running work to
retry. An expired attempt cannot complete even before expiry is swept. The
worker stages an immutable artifact and reports its claimed revision, attempt ID
and artifact identity. Accepted completion enters publishing without advancing
`published`. The publisher acknowledges the exact tuple before the machine
returns to idle; newer invalidations remain pending throughout.

Revisions here are bounded safe integers representing a committed, totally
ordered source frontier for a full recomputation. They are not wall-clock
timestamps, Mecha command revisions, row IDs, or raw PostgreSQL LSNs. Skipping
intermediate revisions is valid only when the batch input reconstructs the
complete state at its claim, including deletions. Partitioned input requires a
proven aggregate frontier or a different vector model. Relabeling whatever
snapshot a worker happens to read with the claimed number is incorrect.

Duplicate completion with the retained result tuple is accepted without changing
state, including after publication or during the next batch. Conflicting
artifact identity is refused. The bounded state retains only the latest result:
older completions are safely refused after another result replaces it. Replaying
an arbitrarily old command with its original success receipt belongs to Mecha's
existing durable command receipts. That SQL behavior is not executed here.
Attempt exhaustion is a refusal, never identity wraparound.

## Durable adapter boundary

The emitted SQL is compiled but is not installed or exercised against
PostgreSQL. The tests establish pure transition behavior; they do not establish
durable execution, concurrent transaction behavior, reliable CDC, or
exactly-once external publication. A deployment still needs these integrations:

- Feed committed source frontiers into `invalidate` through Mecha's dispatcher;
  retain the source cursor and delivery receipt transactionally so a crash
  cannot skip an invalidation. Notifications alone are insufficient.
- Use the existing instance lock, expected command revision and durable receipts
  to serialize claims and completion. Claim state and the durable launch record
  must commit together, or a scanner must rediscover running leases and retry
  expired work. Duplicate job delivery must carry the same attempt identity.
- Read a snapshot pinned to the immutable claim, or retain immutable batch
  input. The worker writes to an attempt-specific immutable location. Old
  workers cannot replace the public artifact merely because they once held a
  lease.
- Publish only the accepted result. Recheck the accepted tuple and fence while
  atomically changing the destination manifest, or use a destination that
  enforces that conditional write. Make the publication key include the instance
  identity, claimed revision and attempt. A crash after publication but before
  acknowledgment must retry the same publication idempotently. Publishing state
  remains discoverable until acknowledgment; it intentionally blocks a
  subsequent claim.
- Keep server-only event access and authoritative time. Transport retries must
  preserve command identity; a fresh command after a stale-revision refusal
  needs a new ID because Mecha receipts preserve refusals too.

These seams can use Mecha relational actions and its existing effect machinery;
they should not introduce a second durable workflow engine. A production proof
requires PostgreSQL concurrency, transaction rollback and crash/restart tests
across the selected source, worker and destination adapters. Worker execution,
source snapshot retention, publication fencing and retries of the external write
are intentionally absent from this bounded fixture.
