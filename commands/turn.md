---
description: Drive one turn of the outer loop over a problem statement
argument-hint: "<problem statement>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Workflow, Agent, Artifact
---

# One turn

The problem statement: **$ARGUMENTS**

## What a turn is

The inner loop is sayt's: pick the verb pair for the layer, ping-pong until
green, advance the cascade. It is total, mechanical and free, and it settles
everything a command can settle.

This is the outer loop. Its whole job is routing — `docs/decisions/2026-08-27-review-by-consequence.md`
splits every obligation into *checkable* and *reviewable*, and a turn sends each
one to the budget that can decide it. Checkable goes to a verb. Reviewable goes
to a seat, bounded. Nothing else happens here.

Three rules hold for the whole turn:

1. **An LLM never adjudicates what a verb can adjudicate.** If `sayt lint` has an
   opinion about the thing under discussion, run it instead of reasoning about it.
2. **Every step ends in a verdict, not prose.** Report the step, the gate, and the
   outcome. The next step reads the outcome.
3. **Write no state.** The turn is resumable by re-running it: the artifacts are on
   disk (`brief.md`, `ir.html`, `program.cue`, the branch) and the verbs are
   idempotent. There is no phase directory and no `STATE.md`, because a second
   source of truth for where you are is a second thing that can be wrong. The
   app's journal (`journal.html`, Rung 4) is a log for people that no turn reads to decide what
   to do.

## The rungs

Read `${CLAUDE_PLUGIN_ROOT}/skills/pronto-turn/references/model-routing.md` for
the phase defaults and native dispatch contract, and
`${CLAUDE_PLUGIN_ROOT}/skills/pronto-turn/references/studio-seats.md` for the four
review seats (`product`, `architect`, `engineer`, `qa`). Each seat is launched
**in the background** (`run_in_background: true` on Agent or async Workflow
invocation with `args: {context, ir, team, seat, routes}`) the moment its rung's
mechanical gate turns green — do not block the lead waiting for a seat before
starting the next rung. Address background seat findings when they report back
(with full context from the downstream work) and verify before handoff. Skills
that run in this conversation retain its model; report that actual route.

### 0. Bootstrap and preflight — abort gate

If this repository is not bootstrapped, read
`${CLAUDE_PLUGIN_ROOT}/skills/pronto-turn/references/bootstrap.md` and perform its seed phase before
running the doctor. That contract is shared with Codex and Agy; this command
does not replace it with a Claude-specific installer.

Run `sayt doctor` and read which tiers are ready. If a tier this turn needs is
missing, stop and name it. Do not route around a missing tool; `sayt setup` or a
fix to `.mise.toml` is the only move.

Run it as a tool call, not as a `!`-expansion in this file. An expansion happens
before the turn starts, so a machine without the toolchain fails the command
itself and step 0 never gets to report which tier was missing — which is the one
thing it exists to say.

### 1. Rung 1: Spec / Oracle — escalation gate + `product` seat

Read `${CLAUDE_PLUGIN_ROOT}/skills/pronto-turn/references/design-tools.md`.
Invoke the available `design` skill and put the turn's visible surface on a canvas. Its job
is to write the oracle *before* the code exists — without it, "done" means
whatever the implementer decided it meant.

The canvas is not the contract. `ir.html` is. The order is: canvas → the human
reacts → the reaction becomes ir rationale (`brief.md`, `DESIGN.md`, `ir.html`
`#screens` / `#flows`). This is the one step a human is genuinely required for,
because there is no unique answer and no verb can score it. Stop here and wait
when a taste decision is genuinely open.

When `brief.md`, `DESIGN.md`, `ir.html` framing/flows/storyboards, or
`acceptance.md` changed, **launch the `product` seat in the background**
(`seat: 'product'`) and immediately proceed to Rung 2 while it reviews in
parallel. Skip Rung 1 only when the turn touches nothing visible, and say that
you skipped it.

### 2. Rung 2: Schema / Generate — `sayt generate && sayt lint` + `architect` seat (background)

When `program.cue`, `seed.cue`, `ir.html` topology (`entity`, `pipeline`,
`hatch`), RLS, or migrations change:

1. Edit `program.cue` / `seed.cue` and run `sayt generate && sayt lint`. That is
   `check-facts`, `derive`, the ir↔program bijection and `cue vet` — the
   checkable schema budget, in full. Iterate until clean (max 3 passes; findings
   must decrease between iterations or escalate).
2. Right after `sayt generate && sayt lint` exit `0`, **launch the `architect`
   seat in the background** (`seat: 'architect'`) and immediately proceed to
   Rung 3 while it reviews in parallel.
3. Skip the `architect` seat when `program.cue`, `seed.cue`, topology, and
   hatches are untouched.

### 3. Rung 3: Code / Unit — `sayt build && sayt test`, simplify, + `engineer` seat (background)

Load the `sayt:tdd` skill and drive it over `shell/screens/*.{html,css}`,
`shell/shared/*.css`, `shell/handlers/*.js`, units/hatches, and unit/driver tests:

- name the **layer** the change actually lives in before running anything;
- pick the **verb pair** (`sayt build && sayt test`, plus `sayt lint` when
  bindings change) and announce it;
- ping-pong inside the layer until both exit `0`;
- fix config, not just code, when the config is what is wrong.

For a self-contained slice, dispatch the `sayt:sayt-dev-loop` agent and let it own
the ping-pong. Whether to split Rung 3 across worktrees is a case-by-case call using
worktree isolation. When work from separate worktrees or branches comes back together,
merge only the hand-written sources — the brief, `ir.html`, the app's own `.cue`,
handlers, stylesheets and tests. Never merge a file `write.ts` emits: resolve a
conflict in one by taking either side, then re-run `write.ts` and re-pin the ir's
sha256.

Once `sayt build && sayt test` are green:

1. **Simplify — once:** Invoke the `simplify` skill exactly once over the
   hand-written diff. Re-run `sayt build && sayt test`; if the layer is not
   green, revert the simplification rather than repairing it.
2. **Launch `engineer` seat in background:** Launch the **`engineer` seat in the
   background** (`seat: 'engineer'`) and immediately proceed to Rung 4 while it
   reviews in parallel.

### 4. Rung 4: System / Verify — `sayt integrate`, playtest, drain background seats, `journal.html`, + `qa` seat

Run `sayt integrate`, plus the battery and whatever oracle the app carries. This
is the last checkable gate and it is not negotiable.

Then use what the turn built in a live browser and capture screenshots of what
you saw. Collect the verdicts from the background seats launched at Rungs 1–3
(`product`, `architect`, `engineer`) alongside any issues uncovered during
playtesting, apply all confirmed fixes in one consolidated pass with full
implementation context, and re-run the owning Sayt gates (max 2 revision rounds;
a flat count escalates).

Update `journal.html` as `${CLAUDE_PLUGIN_ROOT}/skills/pronto-turn/SKILL.md`
Rung 4 says, and run the **`qa` seat** (`seat: 'qa'`) over the acceptance
coverage, test drivers, live playtest evidence, and `journal.html`.

### 5. Hand back

Report the turn by rung: rung, mechanical gate, seat verdict, outcome. Name every
rung that escalated and every seat you skipped, with the reason. Never collapse
"nothing to review here" into "I could not look" — they are different outcomes
and a summary that merges them hides the second one.

Include actual model and design-tool routes, including host substitutions or
inherited choices; a requested model is not evidence that it ran.

## What a turn does not do

Naming these because every general-purpose loop grows them, and each one is a
generic answer to a question this repo answers specifically:

| Not here | Because |
|---|---|
| A state file | The tree is the state; re-run the turn; the journal is a log for people |
| Phase directories | The ir is the plan |
| A roadmap or milestone layer | The branch is the milestone |
| App-kind detection | The app's own CUE says what it is |
| A verb this turn invents | sayt has ten; anything else is `.say.yaml` or a direct command |
