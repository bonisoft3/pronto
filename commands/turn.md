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

This is the outer loop. Its whole job is routing — `docs/2026-08-27-what-must-be-reviewed.md`
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
   idempotent. There is no journal, no phase directory and no `STATE.md`, because a
   second source of truth for where you are is a second thing that can be wrong.

## The steps

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

### 1. Design — escalation gate

Invoke the `design` skill and put the turn's visible surface on a canvas. Its job
is to write the oracle *before* the code exists — without it, "done" means
whatever the implementer decided it meant.

The canvas is not the contract. `ir.html` is. The order is: canvas → the human
reacts → the reaction becomes ir rationale. This is the one step a human is
genuinely required for, because there is no unique answer and no verb can score
it. Stop here and wait.

Skip only when the turn touches nothing visible, and say that you skipped it.

### 2. Sharpen — revision gate, max 3

Fold the reaction into `ir.html`, then run `sayt lint`. That is `check-facts`,
`derive`, the ir↔program bijection and `cue vet` — the checkable budget, in full.

Iterate until clean. The finding count must **decrease** between iterations; if it
does not, the loop is stuck and further passes will not help — escalate with what
did not move.

### 3. Code — the sayt TDD loop, explicitly

Load the `sayt:tdd` skill and drive it. Do not improvise a build-and-test rhythm;
sayt already has one and it is the reason this turn is cheap:

- name the **layer** the change actually lives in before running anything;
- pick the **verb pair** for that layer and announce it;
- ping-pong inside the layer until both are green;
- advance the cascade one layer, and drop back to the fastest layer that
  reproduces anything new;
- fix config, not just code, when the config is what is wrong.

For a self-contained slice, dispatch the `sayt:sayt-dev-loop` agent and let it own
the ping-pong. For a slice that spans layers, drive the pair yourself so the
cascade stays visible.

The gate is the verb's exit code. Never declare a layer green from reading output
— re-run the verb and let it say so.

### 4. Review — revision gate, max 3

Invoke the `code-review` skill at `high --fix`. It is the only reviewer here with a
typed verdict: findings carry file, line, failure scenario and CONFIRMED/PLAUSIBLE,
so the loop can count them.

After every applied fix, step 3's verb pair must go green again — a fix that breaks
the layer is not a fix. Findings must decrease between iterations; a flat count is a
stall, and a stall escalates rather than burning the third pass.

### 5. Seats — the fan-out

Five studio seats reviewing one artifact is embarrassingly parallel, and it is the
slow part of the turn. Run `${CLAUDE_PLUGIN_ROOT}/workflows/studio-review.js` with
the Workflow tool, with `args: {context, ir}` — `context` is what the seats
review (the working tree, or the paths this turn changed) and `ir` is the ir
they review it against. The script refuses to run without both rather than
review a placeholder.

Whether to split step 3 across worktrees is a case-by-case call, made with Claude
Code's own machinery: a subagent with worktree isolation. When work from separate
worktrees or branches comes back together, merge only the hand-written sources —
the brief, `ir.html`, the app's own `.cue`, handlers, stylesheets and tests. Never
merge a file `write.ts` emits: resolve a conflict in one by taking either side,
then re-run `write.ts` and re-pin the ir's sha256. The same holds when a platform
branch regenerated an app's emissions.

Each seat's blocking findings re-enter step 3 as work. The platform advisor is
advisory forever — read it, never gate on it.

The script needs no interpreter on the machine; it runs inside the harness. What
it does need is the Workflow tool. If that is unavailable, say so and run the
seats serially with the Agent tool — and report that the turn was reviewed
serially, because a fan-out that silently became a sequence is a different turn
than the one that was asked for.

### 6. Simplify — once

Invoke the `simplify` skill exactly once, after the tree is green.

It earns its place here because `program.cue` is unreviewed by construction, so
slop accumulates in the hand-written seams — compartment scripts, Jessie handlers,
anything a person typed. That is what the reuse and altitude lens is aimed at.

It changes working code, so it never iterates and never joins a revision loop. Run
step 3's verb pair on its diff; if the layer is not green, revert the simplification
rather than repairing it.

### 7. Evidence — abort gate

`sayt integrate`, plus the battery and whatever oracle the app carries. Exit code
plus the driving agent's judgment on rendered evidence. This is the last checkable
gate and it is not negotiable.

### 8. Hand back

Report the turn as a table: step, gate, outcome. Name every step that escalated and
every step you skipped, with the reason. Never collapse "nothing to review here"
into "I could not look" — they are different outcomes and a summary that merges them
hides the second one.

Then suggest `/code-review ultra` at the branch boundary. This command cannot launch
it — it is user-triggered and billed — so it is a suggestion, and the user types it.

## What a turn does not do

Naming these because every general-purpose loop grows them, and each one is a
generic answer to a question this repo answers specifically:

| Not here | Because |
|---|---|
| A state file | The tree is the state; re-run the turn |
| Phase directories | The ir is the plan |
| A roadmap or milestone layer | The branch is the milestone |
| App-kind detection | The app's own CUE says what it is |
| A verb this turn invents | sayt has ten; anything else is `.say.yaml` or a direct command |
