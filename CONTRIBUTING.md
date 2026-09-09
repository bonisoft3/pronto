# Contributing to pronto

How the pieces fit, and where to change each one. `README.md` is the pitch,
`SPEC.md` is normative — what a conforming `brief.md` and `ir.html` must
contain, enforced by lints — and `docs/` holds the dated arguments behind
individual decisions. This page is the map between them.

A note on one filename: `DESIGN.md` is **an app's** design system here, not
pronto's architecture. `emit.cue` lists it beside `brief.html`, `ir.html` and
`acceptance.md` as a ladder satellite, and `schema.cue` reads the design
tokens out of its frontmatter. Pronto's own architecture is this file.

## The ladder, and what is deterministic about it

```
brief.md ── LLM ──▶ ir.html ── LLM (narrow) ──▶ program.cue ── cue export ──▶ everything
 product              engineering                machine              mecha YAML, omnishell
 altitude             altitude                   altitude             config, HTML/CSS, handlers
```

Three artifacts, one per audience, and the reason there are three is that each
is reviewed by someone different. `brief.md` is what a product person writes.
`ir.html` is the design doc an engineer signs — boxes, arrows, screen sketches,
numbered decisions — and it renders in any browser with no tooling. `program.cue`
is a compiler intermediate that happens to be committed; nobody reviews it.

**Only the first hop is probabilistic, and that is the rung a human is
reviewing anyway.** Everything below it is checkable, which is the property the
whole design is arranged around:

| Rung | Mechanism | Deterministic |
|---|---|---|
| brief ↔ ir | LLM judgment, human-reviewed — this *is* the design step | no |
| ir ↔ program | id bijection (`objects.ts`) | yes |
| program ↔ outputs | `cue export` is a pure function | yes |
| behaviour | test pairs, data in the program | yes |
| visual | the battery over rendered screens | yes |

`ir.html` is a stage rather than a projection *of* the program, and that was a
deliberate trade: a projection can never hold information the program lacks,
which defeats the point of reviewing architecture before it is frozen. The cost
is the second hop, and the bijection check is what contains it.

## The compiler

| File | Owns |
|---|---|
| `schema.cue` | what may be declared — `#Entity`, `#Pipeline`, `#Screen`, `#Flow`, `#App` |
| `emit.cue` | emission: every output the program becomes |
| `derive.ts` | derivation from screen markup — reads, handler lists, decisions |
| `write.ts` | materializing the emission bundle onto disk |
| `objects.ts` | the bijection surface: which ids each rung defines, under what kind |
| `facts.ts` / `check-facts.ts` | the fact store, and the invariants two rungs owe each other |
| `jessie.ts` | what a Jessie module may reference and what it evaluates to |
| `acceptance.ts` | the acceptance ledger and the ir's claims about it |

The four seats a program targets are declared as CUE, one file each:
`clusters/mecha.cue`, `terminals/omnishell.cue`, `loops/sayt.cue`,
`builders/bayt.cue`. A program is not coupled to any of them beyond the seat's
shape — that is what makes the seat a seat.

## What the constraint cascade buys

The thesis is one sentence: **the smaller the surface an LLM must write, the
higher its success rate.** Mecha and omnishell exist to reduce an application
to infra config, HTML/CSS, and small pure handlers, and every layer below is
arranged to keep computation out of the LLM's hands:

1. **CUE absorbs pure derivation** — computed fields, filters, validation. CUE
   is total, so every expression terminates and no second total language is
   needed.
2. **Handlers are Jessie** — a defined safe subset of JS: no `this`, no
   classes, no ambient authority. JS syntax keeps LLM fluency, and a defined
   grammar makes constrained decoding possible.
3. **Enforcement is dual** — the grammar gate at compile time, an SES
   Compartment at runtime.
4. **Time and randomness are injected**, never ambient.

The net property, and it is the one to protect: **nothing in a pronto
application runs with ambient authority.** A change that grants a handler a
clock or a network is not a feature, it is the end of the argument — see
`plugins/omnishell/docs/2026-08-02-terminal-doctrine.md` for the open question
this leaves.

## Escape hatches, ranked

Every escape is a box in `ir.html`, so a hole in the guarantees is visible in
the design doc an engineer reviews. In order of preference:

1. **Pre-compiled WASM** — sandboxed, the interface is a CUE contract, and the
   same `.wasm` runs at every tier. The only escape that leaves vertical
   scaling untouched.
2. **External API endpoint** — a full escape with a clean trust boundary: the
   pronto-managed database is only ever touched by pronto.
3. **Container** — a full escape realized per tier, binding at browser tier to
   a *declared shim*. Declaring the shim is what forces a mockable interface.

## The loop

`just build`, `just test`, `just integrate` in this directory. The
determinism the ladder claims is only real if you check it, so the checkers
are the fast tier: the bijection, the fact invariants, the Jessie grammar
gate, and `cue vet` against the stack schemas all run without a cluster.

Recompiling an unchanged brief may legitimately produce a different ir —
models and prompts move — and that diff is productive rather than a fault.
`SPEC.md`'s "Compile diffs" specifies the merge workflow.

## Where the arguments live

`docs/` carries pronto's own: the ladder and its grammar, the incremental
model, what must be reviewed versus merely checked, the screen typechecker,
validation. The terminal's arguments are `plugins/omnishell/docs/`, the
cluster's are `libraries/mecha/docs/`, and `PENDING.md` is what is argued and
not yet built.
