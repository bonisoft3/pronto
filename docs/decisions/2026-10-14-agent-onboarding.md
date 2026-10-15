---
type: decision
title: Agent onboarding
description: What a cold agent needs to write its first pronto app inside a 128k context — an idioms package shipped and gated with the module, a first generate that compiles a hand-authored program, an author's card under 8k tokens, links that resolve in the mirror, and gates that refuse an app nobody can play.
status: partially-built
---

# Agent onboarding

## The measurement

On 2026-10-14 opencode drove `opencode/muse-spark-1.3` from an empty
directory with one prompt: a minesweeper clone, pure pronto,
[bonisoft3/truco](https://github.com/bonisoft3/truco) as the sample, the
Windows game as the homage. It took four turns. After each turn a person
opened the game in Chrome and reported what was broken.

| Turn | Prompt | Steps | Peak context | Outcome |
|---|---|---|---|---|
| 1 | the request | 26 | 137k | Declared done. No bootstrap, no writer run, no `cue vet`; `export default` handlers importing a shared module; a hand-written `cue.mod`. |
| 2 | "nothing was compiled; follow bootstrap, make the gates green" | 144 | 273k | Every verb green, `launch` up. The URL it reported served a stale stack, and the board never rendered. |
| 3 | "unplayable: empty field, `{now}` throws, `network-error`" | 53 | 354k | Forms replaced by a reduce; fold mounted on both regions; a browser `build: checks:` driver; reveal, flood and flag work. |
| 4 | "one column of 81 tiles; timer reads `0111`" | 24 | 377k | A 9×9 grid and a three-digit clock; the driver re-presses until tiles render, its answer to a press landing before the terminal booted. |

The context before the first file was written was 110k tokens. It came from
fifteen fetches: truco's `arena.cue` (50k chars), `ir.html` (48k),
`program.cue` (40k), the emitted `program_derived.cue` (34k), `SPEC.md`
(39k) and `GUIDE.md` (18k). A 128k model is full before it starts.
Afterwards the agent read the installed compiler instead of the docs:
`derive.ts` 23 times, `schema.cue` 5, `screen.js` 4, `write.ts` 3, against
omnishell's `REFERENCE.md` 10 times and `GUIDE.md` 4.

Every stall falls into one of five classes. Each section below closes one.

## 1. The sample is the wrong size and the wrong version

Truco is a reference app. It has a 1.4 MB shell, hybrid machines, online play
and seven handlers. An agent copying idioms from it pays for all of that. The
mirror also pins `pronto@v0.9.1` while
[bootstrap](../../skills/pronto-turn/references/bootstrap.md) installs
v0.12.0. The first `generate` error was a `note` field v0.12.0 requires on
every handler and truco never shows. The `text` and `int` field types it
copied are older spellings too.

**Built:** the monorepo's `apps/idioms`, carried into the pronto mirror as
`idioms/`. It sits beside the apps rather than inside pronto because `write.ts`
derives an app's layout from a pronto it sits beside. Four screens, each named
for a use case and labelled with its concepts, cover the idioms the transcript
paid for:

| Idiom | Paid for by | Where |
|---|---|---|
| A handler is a bare `(state, event) => ({updates})` arrow: no `export`, no `import` | turn 1 shape, turn 2 lint | every handler |
| Clicks wake a handler only inside a live region; `event.from` is the element id, `event.id` the row | turn 3, menu outside the region | counter, todo |
| A table in `data-reads` is read, not heard; a fold rides `data-on-mutation` and writes only what changed | turn 3, empty field | lights out |
| A singleton `tab` row seeded in CUE, and a handler total over any rows | turn 2 battery, no current game | counter, lights out |
| A grid from one `data-live` list, the row id as its datum | turn 4 | lights out |
| `{now}` only in a hidden `data-value`; a draw by `then: {seed: true}` | turns 2–3 | todo, timer |

Not built: `data-empty-row`, a column count bound from a row (the grid's
`--cols` is fixed), a `build: checks:` browser driver, and a kinetic example,
since a kinetic engine is not yet mounted by declaration (supertux and doom
copy `kinetic.js` into `shell/engine/`).

*Alternatives.* A smaller external sample app would carry its own pin and
drift the way truco did. More prose in `GUIDE.md` fails the same way: an
agent learns these idioms by copying working code, and prose that nothing
compiles rots without anyone noticing.

## 2. The first `generate` cannot compile a hand-authored program

`#Screen` requires `reads`, `writes` and `files.handlers`. The writer derives
all three into `program_derived.cue`, but on a first run that file does not
exist. The derivation's first-run stub
([`derive.ts`](../../derive.ts) at the `pronto_derive_` temp file) defaults
only `charts`. A program written from nothing therefore fails its first
`generate` with `field is required but not present`. In turn 2 the agent
read `derive.ts` 23 times and then wrote its own script to render
`program_derived.cue` "exactly as the writer would".

**Built:** the stub defaults `reads`, `writes`, `charts` and `files.handlers`,
held by `derive-input.test.ts`; `apps/idioms` was written from nothing on it.
The proposal as made: the stub defaults every field the derivation owns, as it
already does for `charts`. Bootstrap also emits the smallest app that passes
`generate`, `lint` and `test`: one screen, one `tab` entity, one handler, a
`DESIGN.md`, an `ir.html` and an `acceptance.md` that cite each other. The
author then edits a green program rather than assembling one from a sample.

*Alternative.* Documenting the first-run seed would make each author
reimplement the writer, which is what the agent did.

## 3. No entry point fits a small context

The docs teach the concept first. Before a cold reader reaches an example,
`README.md`, `GUIDE.md`, `SPEC.md` and `prelude.md` cost about 21k tokens,
and none of them separates the files an author writes from the files the
writer emits. The agent fetched truco's `program_derived.cue` and
`program_terminal.cue` as if it had to author them.

**Built, in another shape:** [`AGENTS.md`](../../AGENTS.md) carries the repository's
own rules, then one paragraph each on time travel, the five languages, the
lineage, the stack, the component split, machines, the loop and the idioms.
The proposal as made: add `AGENTS.md` at pronto's root, under 8k tokens and linked
first from the [index](../index.md). It holds:

- the authored-versus-emitted file table;
- the verb loop, including its preconditions: `lint` needs a git repository
  (`check-proto` reads the app's git history), and a stack started by
  `launch` must be relaunched after an edit or it serves the old markup;
- the run path for a `tab`/`device`-only app;
- omnishell's [rules that bite](https://github.com/bonisoft3/omnishell/blob/main/GUIDE.md#rules-that-bite);
- a pointer to `idioms/`.

Every claim on the card is either a link into `idioms/` or a rule a check
enforces, so the card cannot disagree with the code.

*Alternative.* Trimming `README.md` would cost what the concept argument is
for. The card is a second entry point, not a replacement.

## 4. Links die in the mirror

Copybara mirrors the files unchanged. In bonisoft3/pronto,
`../omnishell/GUIDE.md` and `../omnishell/REFERENCE.md` (from `GUIDE.md` and
`README.md`), `../omnishell/docs/*` and the index's wikilinks into
`apps/truco/docs` all point at nothing. Omnishell's "Rules that bite" is the
section that names five of the seven idioms above. The agent never found it
in turn 1 and found `REFERENCE.md` only later, in the installed tool tree.

**Built:** `.mirror/siblings.json` maps each sibling to its mirror and the tag
pronto's `cue.mod` pins, copybara rewrites links and wikilinks from it, and
`links_test.ts` fails on a link that leaves the tree for anything unmapped.
The proposal as made: the release's copybara transform rewrites each sibling-plugin
link to the sibling's GitHub URL at the pinned tag. A mirror lint fails the
release on any relative link that does not resolve inside the mirrored tree.
The index drops its links to app docs, which belong to the apps.

## 5. Green gates over an app nobody can play

At the end of turn 2, `lint`, `test`, the battery, visual lint and
`integrate` were all green. Even so, the screen sat in
`data-state="network-error"`, the field held no tiles, and the console threw
`binding {now} not in row`. At the end of turn 3 visual lint passed a 9×9
board drawn as one column. The two failures need different gates:

- **A region in an error state, or an uncaught interpreter error, on any
  storyboard frame is critical.** The battery already renders every screen ×
  state, so it should refuse both rather than grade contrast on top of them.
- **Every declared `paths` transition is walked once in the browser.** The
  battery clicks the bindings the path names and asserts the target state.
  Today it is the app's own `tests/play.ts` that would have failed turn 2. A
  walk derived from `paths` gives every app that check without writing it.

The one-column grid is a layout intent no derived check can know. It
belongs in the idioms grid example and in the app's own driver, as turn 4
did.

## 6. Defaults an all-local app pays for

Minesweeper's entities are `tab` and `device`. The cluster still started an
auth service, which exited until the agent added truco's `AppUser` table.
Every screen also requires a stylesheet, even when it is a one-line import of
the shared one. **Proposal:** an app with no auth capability gets no auth
service, and a screen with no stylesheet gets none. Each of these
requirements cost the agent a launch and a reading of `schema.cue`.

## Order

1. Section 2's derivation stub and section 4's link rewrite: small, and each
   unblocks every new app.
2. `idioms/` seeded from jsfb, with the bootstrap's minimal app taken from it.
3. `AGENTS.md`.
4. The battery's error-state refusal, then its path walk.
5. Section 6.

The measure of success is the same prompt under `cerebras/qwen-3.8-27b` with
a 128k context: a playable board, `integrate` green, and no read of a `.ts`
or `.cue` file under the installed pronto tree.
