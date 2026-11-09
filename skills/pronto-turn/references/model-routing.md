# Model routing

Commands own the cheap, decidable work. Models are selected only for reasoning,
implementation, or review that survives those commands.

## Phase defaults

These are Pronto's routing choices, not a claim that a skill can switch the
running conversation's model. Phase numbers also apply to Claude's turn command.

| Phase / Rung | Codex | Claude | Agy |
| --- | --- | --- | --- |
| 0. Bootstrap / doctor | Commands; current lead coordinates | Commands; current lead coordinates | Commands; current lead coordinates |
| 1. Rung 1 — Spec / Oracle (`brief.md`, `DESIGN.md`, `ir.html` `#screens`/`#flows`) | Astra, high | Opus 5, high | Gemini 3.1 Pro, High |
| 1b. Rung 1 review — `product` seat and finding verification | Terra, medium | Sonnet 5, medium | Gemini 3.8 Flash, Medium |
| 2. Rung 2 — Schema / Generate (`program.cue`, `sayt generate && sayt lint`) | Astra, high | Opus 5, high | Gemini 3.1 Pro, High |
| 2b. Rung 2 review — `architect` seat (durable data / RLS / CDC / migrations) and verification | Astra, high | Opus 5, high | Gemini 3.1 Pro, High |
| 3. Rung 3 — Code / Unit (`shell/*`, `sayt build && sayt test`) | Terra, high | Sonnet 5, high | Gemini 3.8 Flash, Medium |
| 3b. Rung 3 simplify + `engineer` seat and finding verification | Terra, medium | Sonnet 5, medium | Gemini 3.8 Flash, Medium |
| 4. Rung 4 — System / Verify (`sayt integrate`, live playtest, `journal.html`) | Astra, high; commands and browser | Opus 5, high; commands and browser | Gemini 3.1 Pro, High; commands and browser |
| 4b. Rung 4 review — `qa` seat and finding verification | Terra, medium | Sonnet 5, medium | Gemini 3.8 Flash, Medium |
| 5. Handoff / unresolved tradeoffs | Current lead | Current lead | Current lead |
| Any phase: file map / test inventory / finding classification / bounded cold-start or single-slice edits | Luna, medium | Haiku 5.5 | Gemini 3.8 Flash, Medium |
| Difficult cross-layer or high-risk escalation | Astra, high | Fable 5.1, high | Gemini 3.1 Pro, High |

Codex IDs are `gpt-6-astra`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
Claude IDs are `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-5-5`, and `claude-fable-5-1`.

Claude's [model comparison](https://platform.claude.com/docs/en/models/overview)
positions Opus for complex agentic coding, Sonnet for speed/intelligence balance,
and Haiku 5.5 for high-speed subagent and bounded implementation work under
100k-token context windows. Reserve the slower
Fable for demanding reasoning or work that still defeats Opus at higher effort.
This is why ordinary edits and bounded seats do not all run on the lead model.

On Agy, [Gemini 3.8 Flash](https://antigravity.google/blog/gemini-3-8-flash-in-google-antigravity)
is the fast agentic-development workhorse;
[Gemini 3.1 Pro](https://antigravity.google/blog/gemini-3-1-pro-in-google-antigravity)
is the planning and intricate-problem-solving route. Both are listed across
plans in [Agy's model catalog](https://antigravity.google/docs/models); do not
assume Agy offers the same Claude versions as Claude Code.

## Native dispatch

Use explicit per-invocation choices for delegated work, never a model name in
the prompt as a substitute for dispatch configuration. Keep the lead's current
model for orchestration; if a decision needs a stronger route, delegate the
bounded analysis or ask the user to select it. A skill invocation that stays in
the main conversation inherits that conversation; it is not a model switch.
Report requested versus actual routing when the host substitutes a model or
does not expose the requested effort. Respect user and organization overrides.

### Claude

Pass the full ID through the Agent tool's `model` parameter. Apply effort only
through controls the installed host exposes; named subagents also support
`effort` in their definitions. Per-invocation selection overrides an agent's
`model: inherit`, including `sayt:sayt-dev-loop`. Availability and forced-model
settings can override requests; inspect the actual selection as described in
[Claude's dispatch contract](https://code.claude.com/docs/en/subagents).

For `studio-review.js`, supply `args.routes` from the phase table and pass
`args.seat` (or `args.seats`) for the current rung's seat (or omit to run all four
when auditing a completed tree):
`review` is the ordinary seat route (`product`, `engineer`, `qa`) and `risk` is the
`architect` route. Each is an object with `model` and `effort`. Verifiers use their
originating seat's route. The [Workflow runtime](https://code.claude.com/docs/en/workflows)
receives these options explicitly; no script default silently inherits the lead.

### Agy

Use `define_subagent` / `invoke_subagent` with the selected seat's charter and
explicit context. The [subagent contract](https://antigravity.google/docs/subagents)
accepts `model: pro` or `model: flash`, not version IDs. Those tiers target the
Pro and Flash choices above but do not pin a version; inspect the resolved model
when available. High / Medium are model-selector targets, not invented subagent
effort fields. Agy's conversation model stays fixed for the current user turn.

Do not write Claude IDs or Codex effort syntax into shared agent definitions.
If native delegation is unavailable, report the actual lead-only route instead
of claiming the phase ran on another model.

## Budget

The portable turn runs one lead and launches each selected review seat
(`product`, `architect`, `engineer`, `qa`) as a **background subagent** the
moment its rung's mechanical gate turns green, continuing immediately to the
next rung while the seat reviews in parallel. By the time downstream work is
built, earlier seats have completed without adding serial wait time, and their
findings are addressed with full implementation context. Inventory and triage
produce evidence, not design, security, or product approval. Do not delegate a
task whose command can answer it more cheaply.

If a visible design is open rather than constrained by an accepted `ir.html`,
the lead produces alternatives and pauses for the human choice. A model must
not pretend that aesthetic preference is mechanically decidable.
