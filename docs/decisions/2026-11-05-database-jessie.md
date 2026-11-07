# Jessie in the database

Status: partially built. Validations, Mecha reducer steps and functions run as described;
functions take no endowments yet, and the browser tier has no engine for them.

The database runs app-authored Jessie where a transaction must complete the work
itself. Three positions share it:

| Position | Answers | Engine | Built |
| --- | --- | --- | --- |
| A [[../../GUIDE#Validations|validation]] | whether a write stands | the `plv8` language at the cluster rungs; the store at every rung | yes |
| A Mecha reducer's step | the next state of an instance | the `plv8` language on PostgreSQL; `pgl_step` on the edge | yes |
| A function | a transformed value the commit stores | the `plv8` language on PostgreSQL; `pgl_step` on the edge | yes |

On PostgreSQL the `plv8` language is QuickJS's pljs, built under that name in the
database image and in `@local`'s host Postgres from one pin
([libraries/mecha/services/database/pljs/pins.cue](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/database/pljs/pins.cue)). It defines the
`plv8` global, and raises a JavaScript error's first line as the error, its text and
stack as the detail. The edge's `pgl_step` still runs the host's V8; pljs inside
PGlite, on the edge and in the page, is the next step and retires that callback.

Each is a module SES confines and omnishell's `instrument.ts` meters with fuel, so
the battery's executor runs the file production runs. Fuel is deterministic, the same
on every tier. pljs's interrupt handler also honours `statement_timeout`: a
`while (true) {}` stops at the timeout with `InternalError: interrupted`, so on
PostgreSQL fuel is no longer the only bound that fires. Work that may run long, recompute
over many rows or call Wasm is a
[[../pipelines-and-schedules#Computations|computation]] instead, after the commit.

## Validations

What a validation is, and its place among the other rules that refuse a write, is
[[../lattice#The validation ladder|the ladder's]]. Where it runs:

**The store is a courtesy; the trigger is the authority.** Both run the same
file: the store over the reader's visible, possibly unsynced copy before the
optimistic write, Postgres over the truth through a `SECURITY DEFINER` read in
plv8 before commit. A disagreement is an ordinary refusal, and which seat is
stricter is the predicate's polarity: `every` over an empty edge passes where
`some` refuses.

- **A refusal is a 4xx, or it is retried forever.** PostgREST maps a bare plv8
  exception to 500, so the predicate answers `"true"`, `"false"` or
  `"answered <typeof>"` as text, and a PL/pgSQL wrapper raises
  `check_violation` for a no and `raise_exception` for a program error, both
  400.
- **AFTER, not BEFORE.** The trigger runs only for a write the caller's own
  policies admitted, so the definer's read is no oracle over rows RLS hides,
  and `event.row` has its generated columns and restamped `txid`. The
  migration refuses a definer that does not bypass RLS, which would judge one
  caller's slice.
- **It states what was true when the write landed.** It judges a READ
  COMMITTED snapshot, locks nothing an edge reads, and never re-judges when a
  referenced row changes; a rule that must survive that is a set constraint.
- **A backward edge costs its fan-in** on every write; a batch pays it once.
- **One engine per seat.** The database image builds pljs from its pinned tag and
  commit, so a cluster lacking it fails at `000_extensions.sql`. PGlite hosts no
  JavaScript engine yet, so
  the browser tier runs the store seat alone and `pages` refuses a validation.
  The edge's `pgl_step` already runs Mecha reducer steps inside PGlite's transaction;
  validations do not use it yet.

## Functions

`code.state.functions` declares pure Jessie functions the database calls
synchronously. Each compiles to `fn_<name>(input jsonb) RETURNS jsonb`, callable
from a machine's actions, a drain or SQL:

```cue
code: state: functions: sofascore_round: {
    rules: "rules/sofascore/round.js"
    fuel:  200000
    note:  "SofaScore round events into apply_patch input"
}
```

The module's completion value is one function from a plain JSON value to a plain
JSON value. It reads no clock, draw, row or host capability: what it needs arrives
in its argument, detached and frozen. Its answer must be plain JSON: a non-finite
number or a non-plain object is refused, not coerced. A throw, a refused answer or
exhausted fuel raises in the calling transaction. Endowments are refused until a
function needs one.

[[../../database-functions.ts]] compiles each into `009_functions.sql`: the engine
`pronto_functions.<name>`, in the `plv8` language at the container tier, and `public.fn_<name>`, a
`SECURITY DEFINER` wrapper every tier declares, so any caller runs it and only the
wrapper reaches the engine. The edge object creates the engine over `pgl_step` under
the step name `fn:<name>`, apart from any machine's
([[../../bundle/edge-functions.ts]], `mecha-edge/src/machines.ts`). The browser
tier has no engine, so a call there fails.

It suits short, pure transformations of inputs larger than an event payload's
declared shape: provider responses, documents, imported batches. Asynchronous
derivations stay computations, which on the edge need their own Worker outside the
database's Durable Object; that seat is not built and functions do not supply it.

Alternatives not taken:

- **SQL alone.** Reshaping nested provider JSON with `jsonb_to_recordset` is
  possible and fast, but the same logic is clearer in Jessie, shares the fixture
  executor with the rest of the program, and is bounded by fuel.
- **A Mecha reducer as the transformer.** Its events and context are typed,
  synced shapes capped at 65,536-character strings and 1,024-item arrays, with
  instances, revisions and receipts a pure function does not need.
- **A computation.** It runs after the commit, so a transformation the commit
  needs would split one decision across two transactions.

## Follow-ups

### `pgl_step` in the page

The page's cluster runs stock `@electric-sql/pglite`, which lacks `pgl_step`: the
module is linked into [pglite-workerd](https://github.com/bonisoft3/mecha/blob/v0.20.6/packages/pglite-workerd/README.md)'s
own reproducible build. Nothing in `pgl_step` is workerd's: it hands the call to
whatever host sets `globalThis.__pgliteStep`, and a page's realm can. A browser
loader or a browser variant of that build would give the page the engine every
position here uses, so `pages` would stop refusing validations and gain functions.
PGlite lacking an engine of its own is beside the point here: the step calls back into the
host's engine.

### Endowments per seat

Each seat should offer every endowment it can, and a function declaring one is
refused for a target whose seat cannot. Four facts shape how:

- pljs is bare QuickJS: no `TextEncoder`, `URL`, `URLSearchParams`, `Intl`,
  WebCrypto or WebAssembly.
- WebCrypto is asynchronous and a `pgl_step` call cannot await, so the host's crypto
  cannot back a synchronous `Crypto`.
- Fuel meters the module's own code, not a host object's: a native parser working on
  a hostile input is unmetered, and only `statement_timeout` stops it.
- Native implementations differ between V8, ICU and workerd versions, so the same
  file could answer differently by tier.

The proposed answer is endowments as pinned pure-JS modules, loaded into the
compartment on every seat and instrumented like the app's code: present in pljs,
synchronous, metered and identical everywhere, at the cost of size, per-session
load and native speed. `Intl` stays out, since locale data does not pin cheaply;
formatting is the screen's. Compute's `ENDOWABLE` and omnishell's `SAFE_ENDOWMENTS`
become one registry stating which seats supply each endowment. Measure `cheerio/slim`'s
load time in pljs before choosing.
