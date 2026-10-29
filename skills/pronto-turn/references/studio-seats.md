# Review seats

Each seat pairs with the mechanical gate of the rung it owns, but **never blocks
the lead from advancing to the next rung**. Launch a seat as a background
subagent the moment its rung's gate turns green, and keep building the next
layer in parallel while the seat reads. Address findings when the seat reports
back (or in a single consolidated fix pass before the final gate), when you have
fuller context from the downstream work.

Skip a seat whose surface is untouched. Read each selected seat's linked charter
and the active team file (`teams/{squad,studio,arcade,ops}.md`) so the seat
carries both its Pronto surface contract and the team's business bar.

| Rung | Trigger (launch seat in background) | Seat | Select when | Blocking contract (settled before handoff) |
| --- | --- | --- | --- | --- |
| 1. Spec / Oracle | Oracle drafted (`DESIGN.md`, `ir.html` `#screens` / `#flows`) | [Product](../../../teams/seats/product.md) | `brief.md`, `DESIGN.md`, `ir.html` framing/flows/storyboards, or `acceptance.md` changes | Journeys, recovery roads, and the visual system honor an accepted oracle. |
| 2. Schema / Generate | `sayt generate && sayt lint` exit `0` | [Architect](../../../teams/seats/architect.md) | `ir.html` topology, `program.cue`, `seed.cue`, RLS, migrations, CDC pipelines, or hatches change | Access policy, idempotence, and lattice boundaries have a concrete failure scenario. |
| 3. Code / Unit | `sayt build && sayt test` exit `0` (+ simplify pass) | [Engineer](../../../teams/seats/engineer.md) | `shell/handlers/*.js`, `shell/screens/*.{html,css}`, `shell/shared/*.css`, units/hatches, or drivers change | Authored code uses platform seams, styles all states across viewports, and keeps Jessie reducers pure and minimal. |
| 4. System / Verify | `sayt integrate` + live browser playtest + `journal.html` | [QA](../../../teams/seats/qa.md) | Acceptance IDs, test spans/drivers, user-visible behavior, or `journal.html` changes | Claimed behavior is covered by a genuinely falsifiable check and verified in a live browser playtest with real screenshots in `journal.html`. |

Do not select a seat because its title sounds relevant. Select it only when the
change includes an artifact the seat owns, launch it in the background as soon
as that artifact's gate is green, and fold confirmed findings in once the
subagent completes. The command gates remain the source of truth for emitted
trees, types, lint, tests, and integration.
