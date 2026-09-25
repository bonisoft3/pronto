# A carrier table is the definition, and a holder applies it

Written from the carrier work
(`2026-09-21-a-carrier-is-a-canonical-string.md`): every holder keeps a value
in one canonical spelling, and until now two of them said what that spelling
is. CUE held a pattern per carrier, which a seed row unifies with; the client
held the same knowledge as code, in a regex here and a bound there. They agreed
because someone read them side by side.

The claim: **what a carrier IS belongs to the program, as data; what a
transport spells it as belongs to the holder, as code; and the holder is judged
by the program's statement rather than by a rule of its own.**

## The two halves, and why the second one is named

`carriers.cue` states one entry per carrier. Half of it is a pattern — the
canonical spelling where the spelling is regular — and that half is exact: CUE
reads it to validate a seed, the client compiles it to assert every value it
canonicalizes, and neither writes it down twice.

The other half is what a pattern cannot say. A calendar has no 30 February; a
signed 64-bit integer stops at 9223372036854775807; an IANA zone is a lookup;
a column's decimal profile is the field's and not the carrier's. These are
named, in `beyond`, from a closed vocabulary, and a holder that meets a name it
does not implement refuses the table rather than the value — because the
alternative is a check the program states and nothing performs.

Naming them made one claim answerable immediately. The json entry spelled
RFC 8785, and nothing canonicalizes key order: not the client, which keeps the
order it was handed, and not the domain, whose base type is `json` and keeps
its text. The entry says RFC 8259 now, and a json column has no order.

## What the agreement is, and how it is held

Measured on 2026-09-22, over 686 values — canonical samples, adversarial
near-misses and generated rows — asked of both sides:

| | before | after |
|---|---|---|
| disagreements | 8 | 4 |
| explained by `beyond` | 1 | 4 |

The four that remain are the residue, one per name: a calendar day, the int64
range, an IANA zone, and a field's decimal profile. Two disagreements were a
loose pattern (a timestamp admitting month 99, a year 0000) and two were a
GeoJSON stub; both are now the pattern's to refuse.

`carrier-agreement.test.ts` states the contract as two invariants and checks
them on every run, over a written set rather than that generated one — the
boundary values, the near-misses and one value per named check:

1. Whatever the client calls canonical, the program's pattern admits.
2. Where the program admits what the client refuses, the carrier names a check.
   A carrier with `beyond: []` agrees exactly.

## Where the tests live, and why they moved

A holder can prove on its own that it applies the table it was handed. That it
applies THIS table is provable only beside the table, so the client's carrier
suite moved from `libraries/mecha` to here. Running it found an expectation
stale since the comparator was made to match the view engine: no task had run
that file.

What stays in mecha is a test of the code — the projections a lake query
needs, which are the same for every table — and where such a test needs a table
at all, it declares a small one, as an input. An input is not a definition: it
names two carriers, not fifteen, and nothing reads it as an answer.

## The holders that still state it themselves

Three holders convert, and each writes the conversion in its own language: the
client in TypeScript, the CDC transform in Bloblang, the domains in SQL. That
is what the claim allows — a transport's spelling is the holder's. What the
claim does not allow is a second answer to what canonical IS, and two remain:

- **The domains** carry the spelling as a regex beside a cast. Where they say
  what the table says, they say it in the same characters, and
  `carrier-sql.test.ts` holds them there; `timestamp`, `date` and `time` carry
  a looser pre-filter with the cast behind it, and what they accept is held to
  the table against a running database. The generator does not read the table
  because its output is a migration every app has committed and applied: a
  tightened pattern is a new migration, never a rewrite of one already run.
- **GeoJSON's shape** is written out in CUE, in TypeScript and in PL/pgSQL, and
  no `beyond` name covers it, so the agreement test cannot explain a
  divergence in it. They already differ in one detail: a `MultiPoint` needs one
  position in CUE and in the client, and none in SQL.

## Consequences accepted

A shell that emits no table has a terminal that refuses at the first carrier
rather than guessing one, and a client whose tables declare no field never asks
for one, because there is nothing to be canonical about. `#Carrier` is written
out per carrier rather than built by a comprehension: a comprehension leaves an
absent optional seed field incomplete instead of absent, which four apps fail
to export over. And the patterns are written in the intersection of RE2 and
JavaScript — no lookaround, no backreference — because both engines read them.

See [[2026-09-23-entity-types-and-boundary-execution.md]] for the boundary
execution model and the decoupling of the type system from engine runtimes.
