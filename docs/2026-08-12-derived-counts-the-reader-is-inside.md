# A derived count the reader is inside of

Supersedes `2026-08-10-optimistic-derived-counts.md` and
`2026-08-11-derived-values-as-folds.md`, both deleted: they describe designs
this one abandons, and a reader finding them would follow a path that ends in
an impossibility.

Worked example rather than doctrine. The problem is a favourite counter — the
smallest interesting derived value there is — and it took most of a day,
through four wrong designs, to reach something exact. The wrong turns are the
useful part, because each one was reasonable and each one failed at a
different edge.

## The problem

The heart fills in under 100 ms and the number beside it lagged a whole CDC
loop, near a second. Both were working as built: the heart reads the reader's
own row, which is local, and the number reads `article_stats`, which a pipeline
recomputes after the write lands.

## Why this one is hard, and how to know in advance

The reader is **inside the aggregate and cannot see the rest of it**.
`Favorite` is `owned/private`, so a browser holds its own rows and no one
else's, while `article_stats.favorite_count` counts everybody.

That is the whole difficulty, and it gives a test worth applying before
designing anything:

> Can the reader see the rows the aggregate is over?

If yes, there is no problem to solve — count them in a live query and the
optimistic overlay does the rest, instantly and exactly, in both directions. If
no, expect the producer to have to publish something, and read on.

## What it reduces to

    shown = others + intent

`others` is how many *other* people have favourited. `intent` is whether this
reader currently wants their own favourite to count, which is local fact and
needs no synchronisation. The only unknown is `others`, and since a browser
cannot see other people's rows it must come from the public total:

    others = total − mine_counted

`mine_counted` is not "does this reader have a favourite". It is **whether the
read that produced this total counted them** — a property of that read, not of
the data now.

## Why `mine_counted` cannot be inferred locally

Four attempts, each defeated by a different case, and all measured rather than
argued:

- **The sink's own `txid`.** Stamped when the sink row is *written*, strictly
  after the read it summarises, so every source row committed in between looks
  covered while never having been read. Measured on the running cluster: the
  write stamp ran about 40 transactions ahead of the read. Fixed by emitting a
  real read watermark (`counted_txid`), which is necessary but not sufficient.
- **Last-assertion and last-retraction txids on the row.** Exact for two
  unseen changes. Wrong at three: both columns sit above the watermark and the
  state before them was overwritten.
- **Parity from `txid` and the pending flag.** Two changes look exactly like
  none, so re-asserting inside one loop counts twice. Worse, the guess changes
  at every pending → synced → recounted transition, so the number moves when
  the reader has done nothing.
- **A client-side version trace**, keeping the reader's own versions above the
  frontier and compacting below it — the textbook incremental-view answer, and
  the most sophisticated wrong turn. It cannot be built: the optimistic overlay
  hides the server versions during rapid writes, which are exactly the versions
  a lagging sink reads. Measured: ten rapid clicks surfaced eleven versions and
  **every one was pending**.

The general statement, which retires all four at once: **a bounded row cannot
carry unbounded history.** Reconstructing a past state from a current one needs
either the history or a group inverse with the delta known, and the row has
neither. Worth reaching for early — the argument takes a minute and invalidates
every remaining variant of "infer it from what we have".

## The answer: whoever derived it, states it

`mine_counted` belongs to the pipeline. It knows the answer for free, having
just done the read. So `favorite-count` emits, from its own absolute read, one
`FavoriteCount` row for the reader who acted:

| column | meaning |
|---|---|
| `mine_counted` | did that read count this reader's favourite |
| `total_at_read` | the total that same read produced |
| `as_of_txid` | which version of the reader's row the pair describes |

RLS keeps it private — **a count discloses nobody**, so this leaks nothing
`decision-favorite-private-derived` protects. Only the actor's row is written,
so it costs one row per event and never fans out across a piece's other
favouriters.

`total_at_read` rides beside `mine_counted` because Electric **streams per
shape**: two tables never arrive atomically, not even from one transaction. A
pair split across two rows would be read skewed, one frame in either direction.

## What the terminal evaluates

Three cases, every input a synced and persisted collection, so the value is
derivable at boot with no network:

1. **The watermark covers the reader's acknowledged row.** The read saw exactly
   that version, so `mine_counted` is simply its state. This is the one
   question a watermark answers exactly — two server txids about versions that
   exist — and it is what stops a first favourite spiking, since the total
   begins including the reader before their pair arrives.
2. **Otherwise, the pair's own read.** `total_at_read − mine_counted` is
   internally consistent whatever has happened since: older, never wrong, and
   never a frozen value.
3. **No pair was ever written.** No read has counted this reader, so the total
   is already theirs alone.

## Why the decomposition is the design

`others + intent` and `total − mine + intent` are algebraically identical and
operationally nothing alike. **`others` is invariant under the reader's own
writes.** Nothing they do can invalidate it, so there is nothing to hold, wait
for, or reconcile — and offline stops being a special case: the row is pending,
`others` keeps its last known value, intent applies on top, and reconnecting
corrects nothing because the contribution was never in doubt.

An earlier revision of this doc proposed holding the displayed value during a
gap. That was a symptom of tracking the wrong quantity.

## Measured

Cluster reset from empty, per-frame traces:

| | |
|---|---|
| heart | 116 ms, no dip, no spike |
| un-heart | 49 ms, no dip |
| 12 clicks at 120 ms | 12 changes, swing 1 |
| 16 clicks at 60 ms | 16 changes, swing 1 |
| burst of 7, then settle | screen 8 = sink 8 = database 8 |

The revision before this one produced twenty changes and swings of ±2 for the
same twelve clicks.

## What it costs, and what it deleted

Costs one private entity, one pipeline, and O(1) writes per event. It deleted a
version trace, an observed baseline, a per-tab tombstone map with a retirement
rule, and the fold's inverse — all of which existed only to guess a number
somebody else already knew.

## Platform facts this rests on

- **Electric streams per shape.** Two tables are two deliveries even from one
  transaction; put numbers that must agree in one row.
- **The optimistic overlay hides server versions.** During back-to-back writes
  the collection shows only pending values, so client-side version history is
  not obtainable from collection changes.
- **Logical replication publishes tables only.** Views and materialized views
  are both rejected from a publication (verified on Postgres 18), so a
  per-reader *view* is not a syncable substitute for a per-reader *table*.

## Rules worth carrying

1. Ask whether the reader can see the rows the aggregate is over. If not,
   expect to publish provenance.
2. **A fact about how a value was derived belongs to whoever derived it.** The
   tell that you have this backwards: you are comparing local state against a
   watermark to guess what a remote computation concluded. A watermark can say
   whether a read covered your version; never what it concluded about you.
3. Prefer the decomposition whose remote term is invariant under local action.
4. When the third fix in a row fails at a different edge, stop fixing and try
   to prove the quantity is unobtainable. It is cheap and it ends the search.
5. For optimistic UI the test oracle is the **converged database**, not the
   screen. Three separate detectors here flagged legitimate behaviour — a stale
   baseline, another writer's traffic, honest toggling — and sent this
   investigation down two blind alleys. Per-frame traces are for shape; the
   database is for correctness.
