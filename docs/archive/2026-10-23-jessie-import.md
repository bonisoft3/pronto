---
title: Jessie import
status: built
date: 2026-10-23
description: A Jessie module graph for kinetic engines — each module precompiled at build time by Endo's ModuleSource and imported by the terminal's SES Compartment, so the browser links real ES modules with no parser of its own; against a runtime parser, a linker of pronto's own and inlining by hand.
---

# Jessie import

**Status: built; archived 2026-10-23.** The contract is the reference's:
[omnishell's kinetic host](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/kinetic.md#a-jessie-engine)
and `schema.cue` `surface.engines`. This record keeps what the code cannot
argue: why the link is Endo's and happens at build time.

## The problem

A Jessie module was one file: the cage evaluates a script and takes its
completion value, and `jessie.ts` denies the name `import`. That fits a
handler, which is one function. It does not fit Apex Run's simulation: a
1,200-line step, its PRNG and the stage tables the renderer also reads. As
one file, the tables would be copied into it, and the copy would drift from
the renderer's. That was gap 4 of the
[[../decisions/2026-10-22-endowed-babylon|endowed-Babylon record]].

## The decision

- **The language.** An engine's modules import each other with static
  declarations whose specifiers are relative literal paths to the app's own
  `.js` files. Dynamic `import()` and `import.meta` stay a reach. A bare or
  URL specifier, a path out of the app, a path that is no `#Jessie` path, or
  a missing file is refused. Cycles link as ES modules link them.
- **The build.** derive links each `surface.engines` entry
  (`engine-link.ts`). Endo's ModuleSource precompiles every module the entry
  reaches into the record SES imports: its imports, exports and functor
  program. The graph lands in `shell/engines/<name>.json`. Every module is
  scanned on its own, in the engine role, which is endowed with nothing.
- **The runtime.** omnishell's `evaluateEngine` builds one Compartment over
  the records, with no endowments and a resolve hook that mirrors the link's,
  and imports the entry. The cage's own module system links the graph, so
  each module evaluates once, and the engine's empty endowment list is the
  ceiling for all of them.

## Alternatives

- **A runtime import hook that parses source in the browser.** SES has no
  parser of its own: `ModuleSource` is Babel. Shipping it would add Babel to
  every page that runs an engine, and parse the graph on every load. The
  precompile moves that work to the build, where it runs once.
- **A linker of pronto's own,** in the style of Endo's bundle-source
  nestedEvaluate: wrap each module in a function and wire exports to
  imports. It would reimplement live bindings, cycle order, `export *` and
  the rejection of import expressions, which SES already does under the
  same lockdown the cage runs. Owning that code means owning its bugs, and
  an error in it would be a hole in the cage.
- **Inlining by hand,** one file per engine. That is the drift the record
  exists to end: the renderer imports the same tables as ordinary modules.

## Pins and cost

- **Packages.** `@endo/module-source` is pinned to 1.4.0, the release cut
  beside the SES 1.15.0 omnishell vendors (`bundle:ses`). Its records are the
  shape that SES imports.
- **Build-time cost.** 25 packages, 15.2 MB (`deno info`), fetched only by
  an app that declares an engine, since derive imports the module lazily.
- **Runtime cost.** Nothing new ships. The module system is part of the SES
  bundle already served (220 KB), and a graph's JSON is about the size of its
  source.
