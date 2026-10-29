---
name: pronto-turn
description: "Drive a Pronto coding turn: establish a design oracle when needed, use Sayt as the mechanical gate, then apply a small consequence-based review panel."
---

# Pronto turn

Use this skill when the user asks to implement, deliver, review, or take a
Pronto app through its outer loop. The working tree is the durable state. Do
not create a state file, a phase directory, or a second task tracker; the app's
journal (`journal.html`, Rung 4) is a log for people, never read to resume a turn.

Pronto distinguishes two budgets. A command settles a checkable fact; an agent
reviews a decision whose consequences a command cannot judge. Never use an
agent to pronounce a command green, and do not spend a panel of agents on a
change whose only remaining question is mechanically decidable.

## Bootstrap before the turn

When starting or adopting a Pronto project, or completing an unfinished
bootstrap, read [the bootstrap contract](references/bootstrap.md) even if
`sayt` already works. Inspect the target's Pronto configuration and generated
toolchain, not just CLI availability; preserve an established project's module
and adapter choices. The agent owns this small seed phase: do not ask the user to
install a global CLI and do not invent a Pronto CLI. Once Sayt is running, CUE
is reached with `./saytw --script tools.nu cue`, never through an agent-plugin
installation path. Bootstrap does not select a terminal, cluster, or builder;
the selected adapters contribute their own tool requirements and Sayt rules.

## Model routing

Read [model routing](references/model-routing.md) before choosing phase models
or delegating. Use its host-specific dispatch contract and report substitutions;
the lead chooses the smallest route that can settle the actual risk.

## 1. Rung 1 — Spec / Oracle (`product` seat)

Read the relevant brief, `ir.html`, `program.cue`, changed files, and the
nearest repository instructions. Run `sayt doctor` for a Pronto target before
depending on its toolchain. If a required tier is unavailable, report the
missing tier and stop instead of silently replacing the gate.

Classify the slice:

| Slice | Required work |
| --- | --- |
| Mechanical or internal | Sayt verb pair and a focused implementation/review pass. |
| Visible surface | Design oracle (`product` seat), human decision if a choice is genuinely open, then Sayt. |
| Durable data, policy, pipeline, validation | Schema / Generate rung (`architect` seat) plus its mechanical gates. |
| Cross-layer or release-risk | Staged rungs (`product` → `architect` → `engineer` → `qa`) as each layer's gate turns green. |

For a visible surface without an existing accepted oracle, read
[design tools](references/design-tools.md), generate a canvas or mockup, and ask
for human judgment before encoding a taste decision. `ir.html`,
not the canvas, is the contract that follows the decision. Skip this only when
the slice has no visible behavior.

When `brief.md`, `DESIGN.md`, `ir.html` framing/flows/storyboards, or
`acceptance.md` changes, **launch the `product` seat in the background**
([review seats](references/studio-seats.md)) and immediately continue to Rung 2
without blocking.

## 2. Rung 2 — Schema / Generate (`architect` seat in background)

When `program.cue`, `seed.cue`, `ir.html` topology (`entity`, `pipeline`,
`hatch`), RLS, or migrations change:

1. Edit `program.cue` / `seed.cue` and run `sayt generate && sayt lint`. A
   nonzero exit is a failed gate; iterate until both exit `0`.
2. Right after `sayt generate && sayt lint` are green, **launch the `architect`
   seat in the background** ([review seats](references/studio-seats.md)) and
   immediately continue to Rung 3 while it reviews in parallel.
3. Skip the `architect` seat when `program.cue`, `seed.cue`, topology, and
   hatches are untouched.

## 3. Rung 3 — Code / Unit (`engineer` seat in background + simplify)

Implement `shell/screens/*.{html,css}`, `shell/shared/*.css`, `shell/handlers/*.js`,
units/hatches, and unit/driver tests against the emitted contracts:

1. Use the `sayt build && sayt test` loop (`sayt lint` when bindings or static
   contracts change). Re-run the pair after every material change.
2. Delegate a self-contained implementation slice only when it can change a
   separate file set. Give the implementer an explicit target, acceptance gate,
   and ownership boundary. Keep cross-layer work with the lead so the cascade and
   generated artifacts stay coherent.
3. **Simplify once:** Once `sayt build && sayt test` are green, use an available
   host-native simplify skill or make one explicit simplification pass over this
   turn's hand-written diff. Look for needless indirection, duplication, and a
   simpler expression of the same behavior. Respect repository comment discipline
   and generated-file ownership. Re-run `sayt build && sayt test`; if a
   simplification breaks a gate, undo only that pass's changes.
4. **Launch `engineer` seat in background:** When `shell/`, units/hatches, or
   drivers changed, launch the **`engineer` seat in the background**
   ([review seats](references/studio-seats.md)) and immediately proceed to
   Rung 4 (`sayt integrate` and playtest) while `engineer` (and any still-running
   `product` / `architect` seats) run in parallel.

## 4. Rung 4 — System / Verify (drain background seats, `qa` seat, journal, and handoff)

Run the smallest final gate that proves the changed layer, plus `sayt
integrate` whenever the change affects an acceptance flow or rendered output.
Do not claim coverage that was skipped.

Then use what the turn built as a person would: launch it and play the game,
file the form, walk the flow the brief describes. A gate can pass an app nobody
can use; a person looking at it cannot. Capture screenshots of what you saw and
look at them: two states that look alike, such as an opened square drawn like a
closed one, are a bug.

**Collect background seat verdicts (`product`, `architect`, `engineer`) and run
`qa`:** By the time `sayt integrate` and the initial playtest finish, the
background seats launched at Rungs 1–3 have usually already completed in
parallel. Collect their verdicts alongside anything the playtest uncovered,
apply all confirmed fixes in one consolidated pass (with the benefit of full
implementation context), and re-run the owning Sayt gates (max two revision
rounds; escalate on a third flat round).

Write `journal.html` from what you captured: it cites only screenshots that
exist and gates whose exit you saw. Maintain it as a reverse-chronological HTML
log for people (most recent entry first), never markdown:
- **Product-centric `<header>` & brief anchor:** `<header>` always opens with a
  product-centric `<h1>` title (what the product is, never a single turn or
  mechanism headline) and a `brief.html`-style product summary paragraph ending
  with an anchor link (`<a href="#initial-brief">Latest product brief ↓</a>` or
  `<a href="#brief-YYYY-MM-DD">Latest product brief ↓</a>`) to the most recent
  brief update in the journal log, so a reader opening `journal.html` immediately
  knows what the product is about before scanning the log.
- **Initial entry:** Starts at cold start with `<article id="initial-brief">` at
  the bottom of the log (what the app is, who it is for, and its target oracle).
- **Turn entries & dated composition (`journal/`):** Prepend this turn's
  `<article>` entry at the top of the log showing the product and technical
  achievements with embedded before/after evidence (screenshots, recordings,
  diagrams, or gate output). Compose entries and assets under `journal/` using
  dated filenames (`journal/YYYY-MM-DD-<slug>.html`,
  `journal/YYYY-MM-DD-<slug>.png`), which the cluster serves under
  `/docs/journal/`.
- **Periodic brief refresh & garbage collection:** From time to time, emit an
  updated brief / state-of-the-app entry (`<article id="brief-YYYY-MM-DD">`) at
  the top of the log, update `<header>`'s anchor link to point to it, and delete
  superseded older entries and their `journal/` files from `HEAD` (git holds the
  full history; `HEAD` keeps the curated subset you choose to keep).

When acceptance IDs, test spans/drivers, user-visible behavior, or `journal.html`
changed, run the **`qa` seat** ([review seats](references/studio-seats.md)) to
verify that every acceptance check is genuinely falsifiable and the live playtest
and `journal.html` evidence match the running app.

Every seat review response across all four rungs must contain only actionable
findings with severity, file and line, failure scenario, and a suggested test or
gate. An empty report is an explicit no-finding verdict. The lead deduplicates
reports and rejects findings that a command already settles.

Report: scope, oracle decision or why none was needed, commands and exit
status, what using it showed, seats run at each rung and findings, actual
model/design-tool routes, and any remaining human decision.

## Host adapter

Use the host's native subagent facility for selected studio seats. Do not use
another host's command syntax, environment variables, or proprietary skill
names. `workflows/studio-review.js` is a Claude adapter, not a source of truth;
the role briefs and Pronto artifacts are portable.
