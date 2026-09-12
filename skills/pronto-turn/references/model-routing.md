# Model routing

Commands own the cheap, decidable work. Models are selected only for reasoning,
implementation, or review that survives those commands.

| Work | Model and effort | Why |
| --- | --- | --- |
| Lead: scope, tradeoffs, architecture, durable-policy approval | `gpt-6-astra`, high | This is the small set of decisions where a wrong abstraction is costly. |
| Focused implementation or cross-file debugging | `gpt-5.6-terra`, high | Strong coding throughput without spending the lead model on ordinary edits. |
| Targeted frontend, UX, QA, or backend review | `gpt-5.6-terra`, medium | The role has a bounded artifact and explicit review contract. |
| File-map, test inventory, generated-output audit, finding triage | `gpt-5.6-luna`, medium | Fast, low-cost bounded investigation; its output is evidence, never approval. |
| Security, RLS, migration, or irreversible data decision | `gpt-6-astra`, high | A specialist review is cheaper than discovering an unsafe policy in production. |

Start with one lead and no more than three concurrent specialist seats. Use the
small model only to collect facts or classify a diff; it cannot settle a design,
security, or product decision. Do not delegate a task whose command can answer
it more cheaply.

If a visible design is open rather than constrained by an accepted `ir.html`,
the lead produces alternatives and pauses for the human choice. A model must
not pretend that aesthetic preference is mechanically decidable.
