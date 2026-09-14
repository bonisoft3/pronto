# Pronto configures its batteries

The ground: `2026-08-02-terminal-planes.md` (what the terminal serves and what
the program says), `2026-08-31-one-ladder-one-grammar.md` (one writer per
fact), `plugins/pronto/README.md` (the target architecture — mecha for data,
omnishell for UI, sayt and bayt for build and deploy), and
`plugins/bayt/core/gen_taskfile.cue`, whose two-branch invocation tokens are
the oldest instance of the trick this doc is about.

The claim: **pronto configures its batteries — through CUE, and by authoring
files each battery consumes as configuration even though they read as the app
itself. A battery that can be configured that way has to hold four properties:
a CUE surface, published commands, relocatability, and self-bootstrapping. One
trick delivers all four, and sayt, bayt, omnishell and mecha each hold them
while contributing something the others cannot. What the four buy together is
portable computing — one computation carried to a different environment.**

## Facts not to re-derive

Read out of this tree on 2026-09-12.

- **bayt's launcher is four lines** (`plugins/bayt/runtime/bayt`). It resolves
  its own directory and `exec`s a mise tool-stub on its own program:
  `exec "$DIR/nu.toml" "$DIR/bayt.nu" "$@"`. It assumes nothing on PATH — the
  stub fetches the pinned interpreter. `omnishell.ps1` is the Windows twin, and
  `plugins/omnishell/runtime/` is the same four files for deno.
- **The mode is a generation-time field.** `gen_taskfile.cue:16` declares
  `runtime: *"" | string`; `:30` computes a depth-relative prefix
  (`strings.Repeat("../", G._m._depth)`); `:32` makes every invocation token a
  two-branch list whose second branch is the bare token `bayt`.
  `plugins/omnishell/terminal.cue:241` and `:248` are the twin for the
  terminal.
- **The detector tests for a sibling checkout.** `plugins/sayt/auto-bayt.nu:47`
  probes `<distribution>/../bayt/core/generate.nu`; `:50` runs the local
  generator with `--runtime plugins/bayt`, `:52` falls through to `^bayt
  generate` from the project toolchain. Terminal selection is not a Sayt
  builtin: `terminals/omnishell.cue` contributes its installation requirements
  and generation commands when selected. Bootstrap itself selects no terminal.
- **All five modules publish.** `registry.cue.works` serves
  `github.com/bonisoft3/{sayt,bayt,omnishell,mecha,pronto}`. sayt and bayt also
  ship a GitHub release that `mise install github:bonisoft3/<tool>` fetches —
  bayt's is one universal source tarball under seven platform names, sayt's is
  per-platform binaries — and `plugins/omnishell/.github/workflows/cd.yml`
  stages one the same way.
- **The blur is in the emitted tree.** `shell.yaml` is the terminal's
  configuration and carries the program's meaning — entities, field types,
  enums, CEL checks — under `schema:`. `shell/handlers/*.js` are authored as
  expressions whose role, endowments and completion contract the terminal
  assigns.
- **The CEL seam is already cut.** `plugins/pronto/arbitrary.ts:50` is
  `extractBounds(ir): FieldBounds`; `:105` is
  `arbitraryField(field, bounds)`. `FieldBounds` (`:28`) is
  `{enumValues?, intMin?, intMax?, sizeMin?, sizeMax?, regex?}` — a value
  domain that names no language.

## Pronto configures its batteries

A pronto app is a program in CUE and a handful of authored files. What reaches
each battery is configuration:

| Battery | What pronto writes it |
|---|---|
| omnishell | `shell.yaml`, the emitted screens, `shell/handlers/*.js` |
| mecha | the cluster's entities, pipelines and access, via `clusters/mecha.cue` |
| bayt | `bayt.cue`, from which the `.bayt/` tree is generated |
| sayt | `.say.yaml`, whose rulemaps are the verbs' rules |

None of it is an import. Pronto names each battery through a CUE adapter —
`terminals/omnishell.cue`, `clusters/mecha.cue`, `loops/sayt.cue`,
`builders/bayt.cue` — that re-exports one implementation from its product home,
so the roster is pronto's and the implementations own themselves.

## The blur is the point

`shell.yaml` is named configuration and carries program semantics. A handler is
a `.js` file whose meaning the terminal decides. Neither is sloppy: each
battery constrains its language until code becomes config, and that constraint
is what makes the checks possible at all. `check-markup`, `check-handlers` and
`check-machines` can exist because the markup is a grammar and a handler is an
expression in a known role; they could not exist over arbitrary imperative
code.

So the trade is expressiveness for checkability, and it is a good trade when
the author is an LLM. A human author resents a grammar that forbids the quick
exception. An LLM author produces exactly the plausible-but-wrong output such a
grammar rejects — and the useful measure of a constraint is whether it catches
that.

It is also what makes "included battery, but swappable" true. A swappable
battery needs its contract published as a surface. An import is not a surface.

## What a battery must hold

1. **A CUE surface** declaring what a consumer fills and which commands exist.
2. **Published commands**, so what crosses to pronto is what to ask, never how
   to run it.
3. **Relocatability**: the directory a battery is distributed to and run from
   changes with the runtime, so it may never assume where it is.
4. **Self-bootstrapping**, so a consumer needs nothing installed first.

Relocatability shows up at three levels. The launcher resolves its own
directory. Generated files carry depth-relative prefixes
(`strings.Repeat("../", G._m._depth)`, `{{.TASKFILE_DIR}}`) rather than fixed
ones. Tools come from mise stubs rather than PATH.

## The trick, in three parts

A CUE surface; a launcher that `exec`s a mise tool-stub on its own program; and
a generation-time mode switch with a sibling-checkout detector. Any two without
the third fail: a CUE surface without a distributed command line emits
invocations only one layout can run.

The switch has to be generation-time, not a runtime probe, and that is not an
implementation detail. The emitted artifacts are checked in, and
`.github/workflows/cd.yml`'s `verify-generated` regenerates them on a release
tag and aborts on any diff. A runtime probe would make a committed tree depend
on the machine that wrote it, and that gate unsatisfiable. The trick is
compatible with reproducible generation, which is most of why it is the right
one.

## Monorepo and published

There is no universal mechanism for making one tree serve as both a checkout
and a distribution. The closest is a FUSE-style source filesystem — Google's
srcfs — which is infrastructure that makes one tree look like two. Lacking
that, this repo solves it at generation time: the emitted artifact itself
differs between the two worlds, and a sibling-checkout detector picks which.

Pronto is the consumer that most requires it, because pronto is where the
monorepo's value is concentrated. A terminal change is immediately testable
against every app, and a language change and the battery that serves it can
land in one commit. That co-evolution sets the pace at which the language
evolves. A published-only arrangement would put a release cycle between every
battery change and the apps that would have revealed it.

The trick is what lets that loop coexist with a real published distribution.
The monorepo keeps its fast inner loop; a consumer gets commands that resolve
from PATH; and both run the same program, differing in one unification.

## What each battery brings

- **sayt** bootstraps. It can install the others, and it carries the
  cross-platform concern — native on Windows, macOS and Linux — which is why it
  is the only one shipping per-platform binaries while the rest ship one
  universal source tarball.
- **bayt** configures sayt in a standard way and brings isolation. Isolation is
  what buys parallelism and memoisation, and those are what make the cycle
  fast.
- **omnishell** and **mecha** bring programming models verifiable both at
  authoring time and by automation, paying in imperative expressiveness.

The list is also the install order: sayt → bayt → {omnishell, mecha} → pronto.
Each layer's command line is installable by the one below it.

## Portable computing

The four properties together buy one thing, at four scales:

| Scale | The same… | …across |
|---|---|---|
| 1 | command | directory depth |
| 2 | command | a checkout or an installed tool |
| 3 | verb | a host or an image |
| 4 | app description | a browser tab or a cloud cluster |

They are not four properties but one, observed at four distances. Scale 3 is
the concrete demonstration: a verb whose commands leave the app directory
cannot be containerised, so fixing scale 1 is what makes scale 3 possible.
`README.md` promises scale 4; scales 1 through 3 are what make the promise
true rather than aspirational.

## The counter-example

A `checks:` entry that published a deno invocation — lockfile policy,
type-check policy, module resolution, a config path, permission grants and two
filesystem paths — is not merely an ugly string. It is a battery failing to be
configurable, because it forces pronto to know how the battery runs rather than
only what to ask it. The same shape in reverse is a compiler reaching into a
battery's tree by relative path: `../../plugins/omnishell/...` is a fixed depth
assumption, and a fixed depth assumption is relocatable to nothing.
