# Activepieces hatch experiments

These experiments support the [[../../docs/archive/2026-10-28-activepieces-hatch|proposal]].
They do not implement the generic hatch or replace the current mail service.

| Experiment | Evidence |
| --- | --- |
| [[portability/README|Local piece]] | Private package exports createPiece; Deno and existing Node load it without publishing; raw actions bypass defaults/required validation. |
| [[declaration/README|CUE declaration]] | Local or pinned npm sources, action aliases, auth secret references, fixed props, schema paths, identity binding and limits; invalid declarations rejected. |
| [[catalogue/README|HTTP and isolation]] | One vs three internal attempts, sensitive errors/logs, execution after caller timeout, Worker environment sharing and subprocess separation. |
| [[routing/README|Dapr routing]] | Actual Dapr appends handler paths beneath the selected action base; exact endpoint accepts and suffix rejects. |

From this directory run `sayt build`, `sayt lint`, `sayt test`, `sayt integrate`.
Build precedes test because the package-root import uses the built export.
`gate.sh` pins Deno 2.9.7 and CUE 0.16.1 through mise's GitHub backend; dependencies
are locked. Docker is required for routing. Dependencies come from registries, but
protocol fixtures are local and send no external mail or API calls. Node is not
required by these gates; the portability README records a separate check using
an existing installation. `dist` and `node_modules` are disposable.

Declaration and hand-written registries are separate experiments. These tests do
not prove CUE generates a registry, packages every runtime asset, installs a piece
in the official platform or enforces a production subprocess boundary. Those are
explicit implementation acceptance items in the proposal.
