---
type: decision
title: Held seeds
description: Moves an archive of seed rows out of the program's CUE package into a JSON file judged by `cue vet` against the entities only when it or they change, after golaberto's 18,782-line seed made every evaluation of the program over ten times slower.
status: built
---

# Held seeds

The contract is in [the guide](../../GUIDE.md#seed-rows) and `#App.state.seed`
in `schema.cue`; this record keeps the measurement and the alternatives.

## The cost

golaberto's archive — 14 server entities, 18,734 rows, a 3.6 MB `seed.cue`
written by `tools/seed.py` — sat in the program's package, so every evaluation
judged every row against its entity again and rendered every row's `INSERT`
through `#seedSql`, whether or not the question asked was about seeds:

| golaberto | rows in the package | held in `seed.json` |
|---|---|---|
| `cue export . -e code.meta.ir.source` | 25 s | 1.5 s |
| `write.ts`, nothing changed | 77 s, 82 s | 5 s, 5 s |
| `write.ts`, the seed or an entity changed | 77 s | 9 s |
| `sayt generate` | 3 s | 3 s |
| `sayt lint` | 142 s | 14 s |
| `sayt test` | 60 s | 26 s |
| `cue vet -c ./...` | 45 s | 2 s |

Judging all 18,734 rows on their own, `cue vet -d 'code.#Seed' . seed.json`,
takes 3.6 s: the rows were cheap to check and expensive to carry, because each
evaluation that reached `out` rebuilt the seed SQL as CUE strings.

## What was chosen

The rows are data beside the program, named by `state: seed: src`, and only
server entities may hold them. CUE still judges them, against `#Seed` — each
server entity's own `seed` constraint, so a held row meets exactly what a
stated one does — and `type-check.ts` runs the `beyond` checks after it.
`derive.ts` does the judging and records its verdict in `.pronto/facts.json`
under a key; `write.ts` reads the file and renders `900_seed.sql` from it and
from the stated rows, one renderer for both (`seed.ts`).

## Alternatives

**Leave the rows in the package.** The guarantee is the same and the cost is
paid by every export, vet and check that never asks about seeds — a lint at
142 s is a lint nobody runs between edits.

**Pull the file in with `@embed`.** The program already embeds `DESIGN.md` and
its catalogues this way, but an embedded value is part of the package: every
evaluation unifies it again, which is the cost being removed.

**Judge in TypeScript.** `type-check.ts` already runs the checks a pattern
cannot state, and could be grown to cover patterns, bounds and cel. That is a
second statement of every constraint CUE already holds, kept equal by nothing.
The rows meet the program's own `#Seed` instead, and only the checks CUE cannot
express run in TypeScript, as they did for stated rows.

**Make `900_seed.sql` the source.** It is what the database runs, but SQL is
the one form nothing here can judge without a database, and the generator
would write a dialect instead of data.

**Key the verdict on the whole package.** Exact, and it judges again on every
edit to `program.cue`, which is most edits. The key covers what a row's
constraints are made of — the file, the entities' export (fields, types, cel),
`program_cel.cue`, and pronto's `types.cue` and `schema.cue` — and the guide
says the one thing it misses: a constraint written on `seed` by hand.

**JSON Lines, or a file per entity.** One object keyed by entity, a row per
line, diffs as well as either, and is the shape `cue vet -d` reads against
`#Seed` in one call.

**Hold `tab` rows too.** A tab entity's rows render into `shell.yaml`, which
the emission builds in CUE; holding them would need the writer to splice them
in. No measured app needs it: the largest tab seeds (primer's 2,376 tokens,
plausible's 1,200 events) are `@embed`ded fixtures, and each program still
exports in about 2 s.
