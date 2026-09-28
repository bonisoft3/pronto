---
type: howto
title: Contributing to pronto
description: Changing pronto itself — the two invariants, the commands, where a compiler check is declared, and where each subsystem is argued.
---

# Contributing to pronto

For changing pronto itself. [`README.md`](README.md) is the concept,
[`GUIDE.md`](GUIDE.md) the app author's tour, [`SPEC.md`](SPEC.md) the
normative artifact spec, and [`prelude.md`](prelude.md) what every compilation
assumes. `DESIGN.md` in this repository always means an app's design block
([`SPEC.md`](SPEC.md#designmd)). Which file owns what is
[the compiler's map](docs/compiler.md#where-each-part-lives).

## Two invariants

**The program is data, and `cue export` is the backend.** Everything an app
becomes is `cue export -e out` over its `program.cue`, and `write.ts` only
materializes it and records it in `.pronto/manifest.json`. An emitted file is
never edited; the change goes where it derives from, in `emit.cue` or the
program. Only the two model hops are probabilistic, and everything below the
program is a pure function and a check
([the ladder](docs/compiler.md#the-ladder)).

**Nothing a model wrote runs with ambient authority**
([the constraint cascade](docs/compiler.md#the-constraint-cascade)). A change
that grants a handler a clock or a network ends the argument.

## Workflows

```bash
just build   # deno check over every *.ts
just lint    # the same check, as sayt's lint rulemap
just test    # the .say.yaml rulemap: bounds.ts, check-loop.ts --self-test,
             # cue vet -c ./testdata/emit, and the *_test.ts / *.test.ts suites
deno task test:integration   # types through Postgres, PostgREST and Electric; needs Docker
```

From the repository root, `just sayt -d plugins/pronto <verb>` runs the same.
`testdata/emit` pins `emit.cue`'s output against a small program; it sits
outside every `./...` pattern, so no app or scan evaluates it.

**Adding a test file**: the `test` rulemap in `.say.yaml` names test files one
by one, so a suite that is not listed there runs only when someone globs it by
hand. **Adding a compiler check**: its command goes in `distribution/config.cue`
under `checks`, and `#DefaultLoop` in `emit.cue` declares it under the verb
whose layer it needs, which files it into every app's `.say.yaml`
([checks and verbs](docs/component-contracts.md#checks-and-verbs)).
Findings are `{severity, path, message}` JSON ([SPEC](SPEC.md#lints)).

## The subsystems

**The compiler** turns a brief into an app through three artifacts, two model
hops and deterministic rungs below them; it holds the program to the ir by a
total bijection, emits every output from one export, and reaches the parts it
configures only through their CUE surfaces and published commands:
[compiler.md](docs/compiler.md).

**Component contracts** are what the app and the cluster, terminal, loop and
build graph it runs on each declare — state, capabilities, surface — and how
data moves among them as one graph:
[component-contracts.md](docs/component-contracts.md).

**Types and identity**: fifteen portable types, each equal exactly when its
canonical strings are, rendered into each boundary's own hook, and an entity's
minted type id and field ordinals, so a name is a label nothing is keyed on:
[types-and-identity.md](docs/types-and-identity.md).

**Schema changes** admit additions and retirements and refuse renames, drops
and retypes, through four readers that each see what the others cannot:
[schema-change-admission.md](docs/schema-change-admission.md).

**The lattice** is the durability ladder and the dimensions declared beside
it, with the joins the code refuses and the validation rung:
[lattice.md](docs/lattice.md).

**Access** compiles each entity's declared mode into mecha's tenancy floor and
the policies inside it, mirrored in the browser, and gives a reader inside an
aggregate they cannot see an exact count: [access.md](docs/access.md).

**Pipelines and schedules** keep derived entities from another's changes and
turn periodic work into rows:
[pipelines-and-schedules.md](docs/pipelines-and-schedules.md).

**Localization** derives catalogues, addresses, the door's negotiation and
crawlable documents from one declaration, and keeps `Intl` the terminal's: [localization.md](docs/localization.md).

**The design scale** quotes vendored rungs beneath an app's roles and refuses a
literal wherever a rung exists: [design-scale.md](docs/design-scale.md).

**Screens** are derived from their markup where the markup is the authority,
checked against the program where the program is, and rendered per route by a
policy pronto owns over omnishell's mechanism: [screens.md](docs/screens.md).

**Release targets** project each target a program declares into a sayt
`release@<target>` rule on one tier: [release-targets.md](docs/release-targets.md).

The terminal's arguments are [omnishell's index](../omnishell/docs/index.md),
the cluster's [mecha's](../../libraries/mecha/docs/index.md), and what is argued
and not built is [`PENDING.md`](PENDING.md). Everything else:
[docs/index.md](docs/index.md).
