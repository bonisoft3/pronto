# ARIA is columns

Virtual focus, roving tabindex, and a select-all that answers to its children
are one feature, not three. Four screens defer the keyboard contract with the
same sentence, and the checkbox agent stopped at the same wall from the other
side. This says what the feature is, and — more importantly — what it refuses.

## The wall is the comparison, not the value

The obvious shape is to project an ordinal and let the markup compare it. That
does not work here, and the reason is worth stating first because it rules out
the cheap version.

The binding grammar interpolates; it does not evaluate. `data-text="{index}"`
puts a number on screen and cannot ask whether that number equals another one.
The one conditional in the vocabulary is `data-when`, and it is literals-only
by design: a placeholder inside it is refused at hydration, deliberately, so
that which template a row picks stays decidable by reading the markup.

So a row carrying `index: 4` and a machine holding `active: 4` have nowhere in
the markup to meet. Exposing both as columns and hoping the template joins them
is a design that cannot be written down in this vocabulary.

**The projection has to do the comparison and emit the answer.** Not `index`
and `active` for the markup to relate, but `active: true` — and `tabindex: 0`,
and `aria-posinset: 5`. After that everything downstream is what already works:
`data-when` picks an arm, and each arm's ARIA values are literals a reader can
see in the file.

That is the whole mechanism. The rest of this doc is about keeping it from
becoming something else.

## Do not invent a query language

The read tier already has one, in the boot graph of every app:
`createLiveQueryCollection`, `eq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`,
`not`, `inArray`, `isNull`, and the index types, vendored through
`interpreter/vendor/entry.ts` from mecha's client. Incremental view
maintenance is what computes a derived column exactly and instantly for rows
the browser already holds.

A derived projection is therefore a live query stated in a vocabulary that
exists, over collections that exist, evaluated by an engine that already ships.
Nothing here should grow a second dialect. The platform has one dialect for
reads (PostgREST fragments, parsed by `fragment.js`) and one for incremental
views; a third would be the drift this doc exists to prevent.

## What it refuses

Every boundary that has held in this platform held because the vocabulary
stayed closed and the terminal owned the verbs. A projection that joins a
region's rows against a machine's row is the first construct here that starts
to resemble a query language in the read tier, so the refusals are the load
-bearing half of the design.

Allowed:

- **Positional facts about the region's own projection** — the index of a row
  within the filter and order the region already declares, and the count of
  those rows. The region's read is the projection; nothing new is being
  queried.
- **A comparison against the machine's own row** — the row that region already
  binds. `active` is `index = machine.active`, and the machine's row is a
  parameter, exactly as a nested region's filter interpolates its parent's row.
- **The answer as a column**: a boolean, a number, a string a template can
  interpolate or a `data-when` can match as a literal.

Refused:

- **Arbitrary predicates over foreign collections.** A projection may read the
  region's rows and the machine's row. It may not join a third table, and it
  may not filter one collection by a subquery over another. That is a query
  language, and the moment it exists the chart stops being a complete
  inventory of what a screen can do.
- **Aggregates over server-tier tables.** The derived-counts rule already
  settles this: a count is exact when the reader can see the rows it is over.
  Browser-owned (`tab`, `device`) rows qualify; a `crud` or `live` table is a
  window onto rows the reader does not hold, and an aggregate over it is a
  number the screen cannot justify.
- **Expressions in markup.** The comparison happens in the projection, never in
  a binding. If a future need seems to want `data-when="{index} > 3"`, the
  answer is another derived column, not an expression grammar.

## What it unlocks

- Virtual focus and roving tabindex: `active` and `tabindex` as columns, so
  arrow keys are a machine transition over its own row (`active + 1`, clamped
  by `count`) and the rendering is the reconciler's ordinary work.
- `aria-posinset` / `aria-setsize`, which are positional facts and nothing else.
- Indeterminate driven by real children: the parent's row carries a count of
  checked children, and `mixed` is a `data-when` arm over that column. What a
  click from `mixed` should do stays a product decision the machine states as a
  guard, not something the aggregate decides.

## Rules worth carrying

- The projection emits answers, not operands. If the markup would have to
  compare two columns, the projection is not finished.
- One dialect for reads and one for incremental views. A third is a defect.
- A derived column is exact only over rows the reader holds.
- The refusals above are the feature. A projection that can express anything is
  a query language wearing a column's clothes, and the grammar will stretch
  until it lies.
