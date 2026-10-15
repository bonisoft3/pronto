Writing an app? Read only this file and the [idioms](idioms/README.md), copy from them, and open another doc when a gate's error names it. SPEC, GUIDE and the prelude are references for that moment, not reading before you write.

# Working in this repository

Comments: DRY, concise, HEAD-only, non-local only. No paraphrase, no TODOs, no changelog. Favor regression rationale in tests. Delete rot.

Docs: md + wikilinks, DRY. Live: modify, kill, archive at will. Argue the alternatives code cannot. Links resolve. Shape follows content. A dated doc is a decision record with a status; when it is built, its contract moves to the reference or guide and the record is archived. A component's docs/index.md is where its documents start; where a doc and the code disagree, the code is right and the doc is the bug.

Errors: do not swallow errors, only try/catch what you can resolve, fail loudly, no fallback paths, die instead of logging.

Dependencies: cross clear domain boundaries only; pin internal and external deps. Prefer reproducible, portable, relocatable choices.

# Writing a pronto app

Time travel: an app with no hatches replays. The same rows, events, `?seed=` and `?clock=manual` give the same screens, from a click back to a physics frame. Nothing grants it; it emerges from the rules below. A hatch is where it stops.

Five languages, one job each: pure functions (Jessie) compute, SQL holds data, IVM moves it, HTML/CSS presents it, statecharts coordinate. A handler that fetches, a screen that queries, a pipeline that decides: each is the wrong language.

Lineage: The Elm Architecture for the screen loop (rows in, updates out), durable functions (Temporal, DBOS) for work that outlives a request, differential dataflow for derived data, block-mode terminals for forms. Their invariants are ours.

Stack: PostgreSQL holds rows, PostgREST serves them, Conduit and Dapr carry changes, Electric syncs shapes into TanStack DB, PGlite stands in within a tab, DuckDB checks facts and folds, Caddy is the one door, SES confines handlers. CUE states it all.

Split: pronto compiles brief → ir → program.cue; omnishell is the terminal (screens, handlers, machines in the browser); mecha is the cluster (Postgres, sync, pipelines, server machines); sayt is the loop (setup … release); bayt is the build graph.

Machines: a statechart over one row's field. In omnishell (`data-machine`) it owns a `tab` or `device` row; in mecha it runs in a Postgres trigger and rolls back an illegal transition. Cortex composes mecha machines into browser sessions and commands.

Bootstrap: yours to run, first, in the app's directory, as [bootstrap](skills/pronto-turn/references/bootstrap.md) says; it installs into that directory and mise's cache, nothing global. Until it has run, no gate has.

TDD loop: sayt's. Pick the verb for the layer you changed (`generate` and `lint` for CUE and markup, `test` for handlers, `integrate` for the running app), repeat until it exits 0, then move up a layer. The exit code is the verdict, so run each verb in the foreground and wait for it: a gate you backgrounded has not passed. A hand-written page or a test written around a handler is not the app.

Done: any task that changes an app ends with the four verbs green, then using what you built as a person would, screenshots as evidence, and the app's journal rewritten: a page for people showing each turn's before and after. A task that stops before that has not built the app; there is no later step that does it for you. The journal is a log, never state a turn resumes from. A meaty feature runs this through the `pronto-turn` skill (plugins for Claude Code, Codex and Antigravity; see the README).

Files: you write brief.md, ir.html, acceptance.md, DESIGN.md, program.cue, shell/screens and shell/handlers; a do-not-edit header means emitted. Import pronto as `github.com/bonisoft3/pronto`. Leave `id` and `ordinal` out of a new entity: `generate` mints both. A `cue vet` error names the schema.cue line to read.

Idioms: [idioms](idioms/README.md) is a small app, compiled at this release, with one screen per concept. Copy from it before reading a full app or the compiler.
