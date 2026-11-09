# Direct presentation synchronization

Status: built; archived 2026-11-07.

## Decision

Use direct source synchronization with development configuration covering declared
capabilities. Compose owns file delivery; generation remains explicit. The live
contract and native-watch options are in [[../pronto-hmr]]. Chart references and
IR derivation are documented in [[../screens]] and [[../compiler]].

## Alternatives

Direct sync with screen-specific generated configuration would leave some binding
edits dependent on a manual generation. That boundary is difficult for authors to
recognize. Covering declared capabilities moves the boundary to explicit program
changes.

A semantic watcher could compare markup projections and conditionally generate.
It would preserve narrower development configuration but add a second event loop,
publication ordering, and compiler lifetime management. Compose's native watch
rules cannot choose their actions from the meaning of an HTML edit. Keep the
watcher responsible for file transport and the compiler responsible for explicit
compilation.

Broader development configuration can load more modules and data than a
screen-specific release configuration. It must preserve access restrictions.
Tests must distinguish availability of a declared capability from permission to
read its rows. Release configuration and content-hashed packaging remain
unchanged by this decision.
