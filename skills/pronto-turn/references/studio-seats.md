# Studio seats

Choose seats from the changed surface, not from a fixed fan-out. Read each
selected seat's linked charter and include it in the delegation; a role title
alone is not its review contract. A seat reviews the listed artifact against
the Pronto contract and returns findings only.

| Seat | Select when | Blocking contract |
| --- | --- | --- |
| [Backend](../../../teams/studio/backend.md) | Entities, RLS, migrations, CDC, pipelines, or validations change | Policy, idempotence, and delivery behavior have a concrete failure scenario. |
| [Frontend](../../../teams/studio/frontend.md) | Screen assembly, bindings, handlers, states, or terminal contracts change | The emitted surface remains traceable to its storyboard and handles declared states. |
| [UX](../../../teams/studio/ux.md) | Flows, interaction cost, empty/error states, or accessibility behavior changes | A journey and its unhappy paths remain intentional and usable. |
| [Designer](../../../teams/studio/designer.md) | Tokens, layout, visual hierarchy, or a new visible surface changes | The implementation honors an accepted visual oracle and design scale. |
| [QA](../../../teams/studio/qa.md) | Acceptance IDs, coverage, fixtures, verification, or a regression fix changes | The claimed behavior can fail under a specific automated or evidence-backed check. |
| [Platform advisor](../../../teams/studio/platform-advisor.md) | A cross-cutting seam, duplication, or ownership boundary changes | Advisory only; it may identify coupling but cannot block delivery. |

Do not select a role because its title sounds relevant. Select it only when the
change includes an artifact the role owns. The command gates remain the source
of truth for emitted trees, types, lint, tests, and integration.
