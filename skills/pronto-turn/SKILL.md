---
name: pronto-turn
description: "Drive a Pronto coding turn: establish a design oracle when needed, use Sayt as the mechanical gate, then apply a small consequence-based review panel."
---

# Pronto turn

Use this skill when the user asks to implement, deliver, review, or take a
Pronto app through its outer loop. The working tree is the durable state. Do
not create a state file, a phase directory, or a second task tracker.

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

## 1. Establish the scope

Read the relevant brief, `ir.html`, `program.cue`, changed files, and the
nearest repository instructions. Run `sayt doctor` for a Pronto target before
depending on its toolchain. If a required tier is unavailable, report the
missing tier and stop instead of silently replacing the gate.

Classify the slice:

| Slice | Required work |
| --- | --- |
| Mechanical or internal | Sayt verb pair and a focused implementation/review pass. |
| Visible surface | Design oracle, human decision if a choice is genuinely open, then Sayt. |
| Durable data, policy, pipeline, validation | Backend review plus its mechanical gates. |
| Cross-layer or release-risk | Lead review plus the relevant specialist panel. |

For a visible surface without an existing accepted oracle, read
[design tools](references/design-tools.md), generate a canvas or mockup, and ask
for human judgment before encoding a taste decision. `ir.html`,
not the canvas, is the contract that follows the decision. Skip this only when
the slice has no visible behavior.

## 2. Implement through Sayt

Name the layer before changing it. Use the narrowest applicable Sayt pair,
usually `generate`, `build`, `lint`, `test`, and then `integrate` only where
the target's acceptance evidence needs a running system. Re-run the pair after
every material change. A nonzero exit is a failed gate; output that looks
healthy is not a verdict.

Delegate a self-contained implementation slice only when it can change a
separate file set. Give the implementer an explicit target, acceptance gate,
and ownership boundary. Keep cross-layer work with the lead so the cascade and
generated artifacts stay coherent.

## 3. Review by consequence

Use an available host-native code-review skill when it supplies an evidence-backed
review of this diff. Otherwise perform that review explicitly: inspect correctness,
regressions, and missing acceptance evidence. Do not invoke Claude's `code-review`
command on Codex or Agy, or count a native review as a substitute for specialist
judgment it did not cover.

Read [studio seats](references/studio-seats.md). Select at most three blocking
seats and add the platform seat only as non-blocking advice. Run selected seats
in parallel after the mechanical gate is green.

Every review response must contain only actionable findings with severity,
file and line, failure scenario, and a suggested test or gate. An empty report
is an explicit no-finding verdict. The lead deduplicates reports and rejects
findings that a command already settles.

For each confirmed finding, fix it, rerun the owning Sayt pair, and repeat the
same panel only if findings remain. Stop after two revision rounds; a third
flat round is an escalation with the unresolved decision, evidence, and
alternatives.

## 4. Simplify once

After review and the owning gates are green, use an available host-native
simplify skill, or make one explicit simplification pass over this turn's
hand-written diff. Look for needless indirection, duplication, and a simpler
expression of the same behavior. Respect repository comment discipline and
generated-file ownership. Do not redesign the accepted oracle, add speculative
abstractions, or expand into unrelated cleanup. No useful change is a valid result.

Rerun the owning Sayt pair on any simplification and inspect the diff for altered
contracts; revisit an affected seat if a reviewable decision changed. If a
simplification breaks a gate, undo only that pass's changes, preserving other
work. This is one pass, not another revision loop.

## 5. Evidence and handoff

Run the smallest final gate that proves the changed layer, plus `sayt
integrate` whenever the change affects an acceptance flow or rendered output.
Do not claim coverage that was skipped. Report: scope, oracle decision or why
none was needed, commands and exit status, selected seats and findings, and
actual model/design-tool routes, and any remaining human decision.

## Host adapter

Use the host's native subagent facility for selected studio seats. Do not use
another host's command syntax, environment variables, or proprietary skill
names. `workflows/studio-review.js` is a Claude adapter, not a source of truth;
the role briefs and Pronto artifacts are portable.
