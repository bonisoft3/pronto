---
type: concept
title: The compiler and its review ladder
description: How a brief becomes an app — two model hops above deterministic rungs, what `cue export` emits and where it lands, what the bijection holds a person to sign, and how pronto reaches the parts it configures.
---

# The compiler and its review ladder

Pronto compiles a markdown brief into a running app through three artifacts,
one per audience: `brief.md` for product, `ir.html` for an engineer,
`program.cue` for the machine. Two hops are a model's; everything below the
program is a pure function and a set of checks. `cue export -e out` is the
whole backend and `write.ts` its linker. What each artifact must contain is
[SPEC](../SPEC.md); how an author drives the loop is [GUIDE](../GUIDE.md).

## The ladder

The rungs, and which of them are deterministic, are
[the README's](../README.md#drift-detection); the files behind each are
[below](#where-each-part-lives).

**The ir is a stage, not a projection of the program.** Its job is to hold
architecture decisions above the program — richer than the brief, coarser than
CUE — where an engineer reviews them before they freeze. An ir rendered from
the program could never hold what the program lacks. The price is the second
model hop, and it is narrow: the structured parts (entity tables, flow
topology, data-path assignments) extract deterministically, and every design
object carries an id the program cites back, so a difference either way is a
finding rather than a drift.

**Media follow altitude**: a screen is an SVG sketch in the ir and HTML only
in the program, so nothing executable lives at the rung a person reads.
`derive.ts` records the hash of every file it read and wrote in
`.pronto/facts.json`, and `check-facts` refuses to grade facts about a file
that has since changed. `tests/pairs.yaml`, which the emitter writes from the
program's tests, has no runner.

## The bijection

`objects.ts` names the ids each rung defines and `check-facts` compares the
two sets, over the kinds and by the rule [SPEC](../SPEC.md#programcue) states.

## Where each part lives

| file | owns |
|---|---|
| `schema.cue`, `emit.cue` | what may be declared; every output it becomes |
| `derive.ts`, `write.ts` | what markup and the ir imply; materializing the emission (`.pronto/manifest.json`) |
| `objects.ts`, `facts.ts`, `check-facts.ts`, `invariants.sql`, `acceptance.ts` | the bijection, the fact store, and the invariants two rungs owe each other |
| `cel.ts`, `derive-cel.ts`, `cel-emit.ts`, `bounds.ts` | one parse of every `cel:` into `.pronto/cel.json`, and every reading of it |
| `jessie.ts`, `validations.ts` | what a Jessie module references; what a validation compiles to |
| `identity.ts`, `type-*.ts`, `types.cue` | [types and identity](types-and-identity.md) |
| `check-sql.ts`, `check-proto.ts`, `check-replay.ts`, `pgroll.cue` | [schema changes](schema-change-admission.md) |
| `scales.ts`, `scales/`, `styles.ts` | [the design scale](design-scale.md) |
| `prerender.ts`, `bundle/` | server-rendered documents; the `release@pages` bundle |
| `clusters/`, `terminals/`, `loops/`, `builders/` | the rosters ([component contracts](component-contracts.md)) |
| `bootstrap/`, `distribution/` | what a consumer repository is seeded with, and its pins |

## Emission

- **The manifest is part of the program.** The export yields `manifest`, every
  emitted path sorted, and `files`, path → `{format, text | data | src}`: raw
  formats render to strings in CUE, structured ones stay structs for the
  writer, assembly entries carry `src`. Not emitted: `.mise.toml`, which
  bootstrap owns, and any view of the ir, which is itself the pinned artifact.
- **The shell is files, not a DSL.** Bindings, forms and states live in the
  HTML, CSS and Jessie the ir defines, written into the app tree;
  `shell/shell.yaml` maps routes to files and carries what the terminal cannot
  derive, among them the schema, access, uniques, validations, the boot
  `tables`, the type table, migrations and pipelines (`#shellConfig` in
  [`emit.cue`](../emit.cue)). `program.cue` references assembly by path and
  inlines with `@embed` only where a consumer cannot reference a file.
- **Inspection is default-on; a hatch is the exemption.** Every SQL file and
  proto under the app is linted unless a `sql` or `proto` hatch names it, and a
  `container` hatch withholds a service whose definition is the program's
  cluster unification. Every hatch carries `ir`, so an exemption is an ir
  element a reviewer signs, not a line in a tool's config.
- **The loop runs on builtins.** The emitter writes the files sayt's builtin
  verbs read — `.say.yaml`, `.vscode/tasks.json`, a `compose.yaml` including
  what bayt emits — and files every check under the verb whose layer it needs
  ([checks and verbs](component-contracts.md#checks-and-verbs)),
  never a script nobody runs. Pronto's own: `derive`, `types`, `facts`,
  `proto`, `identity` and `sql` at `lint`, `prerender` at `test`, `replay` at
  `integrate` after the images exist.

## The constraint cascade

The smaller the surface a model writes, the more often it is right; the layers
that shrink it are [the README's](../README.md#js-handlers). What enforces
them: `jessie.ts` refuses a module that reaches for `window`, `fetch`, `Date`,
`Math.random`, `eval`, `this` and the rest of `DENIED`; omnishell's `check
handlers` loads each module in the compartment its role runs in; the
interpreter runs it under SES with time and randomness supplied by the
terminal ([the terminal](../../omnishell/docs/terminal.md)). Nothing parses a
module against Jessie's grammar ([pending](../PENDING.md#the-compiler)). A
vendored unit is the declared exception to ambient authority: code an engineer
audited, contracted and visible as an ir box.

## The parts pronto configures

Pronto configures sayt, bayt, omnishell and mecha and imports none of them:
each receives files it consumes as configuration — `shell.yaml`, screens and
handlers; entities, pipelines and access; `bayt.json`; `.say.yaml`. Each
constrains its language until code becomes config, which is what makes `check
markup`, `check handlers` and `check machines` possible: checkability bought
with expressiveness, the right trade when the author is a model that produces
exactly the plausible-but-wrong output a grammar rejects.

Each part holds four properties: **a CUE surface** naming what a consumer
fills and which commands exist; **published commands**, so what crosses to
pronto is what to ask, never how to run it; **relocatability**; and
**self-bootstrapping**. One trick delivers them: a launcher that resolves its
own directory and `exec`s a mise tool-stub on its program
(`plugins/bayt/runtime/bayt`, `plugins/omnishell/runtime/omnishell`),
depth-relative prefixes in generated invocations, and a mode chosen **at
generation**. In the monorepo an app's `loop.surface.sources` default to the
sibling checkouts; a bootstrapped consumer's `generate` writes
`program_pronto.cue` setting `sources: pronto: ""`, and every command then
finds the installed distribution with `run-mise where` as it runs.

Each brings what the others cannot. sayt bootstraps the rest and carries the
cross-platform concern, which is why it alone ships per-platform binaries;
bayt configures sayt in a standard way and brings isolation, which buys
parallelism and memoisation; omnishell and mecha bring programming models
checkable at authoring time and by automation, paid for in imperative
expressiveness. The install order follows: sayt → bayt → {omnishell, mecha} →
pronto, each installable by the one below it.

The monorepo is where a terminal change is tested against every app in the
commit that makes it; the trick lets that coexist with a published
distribution running the same program.

## Rejected

- **Rendering the ir from the program** — a projection holds nothing the
  program lacks, so it cannot be where architecture is reviewed before it is
  frozen.
- **Generating TypeScript and React** — a generated framework app needs `tsc`
  and a bundler between the model and the page, cannot be built in a tab, and
  is code a reviewer has to read. Screens interpreted by the terminal keep the
  served artifact data.
- **An ir that embeds executable CUE, JS test pairs and animated HTML
  storyboards** — it turns the engineer's design document into code. Contracts
  and tests belong to the program, where `cue vet` and the checks read them;
  the ir keeps sketches and prose with CEL.
- **A part reached by import, by a relative path alone, or by a published
  invocation** — an import is not a surface; a path into a sibling tree with
  no installed branch is a fixed depth relocatable to nothing; a published
  `deno run` carrying lockfile policy, permissions and paths makes pronto know
  how a part runs rather than what to ask it.
- **Choosing monorepo or distribution mode by a runtime probe** — committed
  emissions would depend on the machine that wrote them, and
  `verify-generated` (`.github/workflows/cd.yml`), which regenerates them on
  every release tag and aborts on a diff, could never pass.
- **A source filesystem that makes one tree both a checkout and a
  distribution** — a FUSE layer such as Google's srcfs is infrastructure this
  repository does not have; the emitted artifact differs between the two
  instead, chosen at generation.
- **Elm for the residue** — no in-browser compiler and little model fluency;
  Jessie keeps JavaScript's syntax, and the cage keeps the discipline.
- **Computing graphs in CUE** — CUE stays total, but forcing a recursive
  structure such as a transitive closure concrete is super-quadratic; CUE
  composes, validates and emits, and graph work belongs to code.
- **Starlark for that code** — pure, terminating and fast, but a second wasm
  heap beside CUE's, so every handoff of CUE's export is a serialize, copy and
  parse; JavaScript walks the export where it lies, and SES with an iteration
  bound recovers the two guarantees where they matter.
- **Bun as the local runtime** — no permission model, so a checker's
  `--allow-read=.` has no equivalent and purity rests on SES alone; its Node
  compatibility surface diverges from the browser APIs Deno mirrors.
