---
type: decision
status: built
---

# Predicates belong to lifecycle transitions

The authored contract is in [[../../GUIDE#validations|the guide]] and
[[../../SPEC|the artifact specification]]. This records why the lifecycle
machine owns it.

A predicate attached directly to an entity hid which operation called it.
The separate validation trigger also gave guards and relational actions two
execution paths. A named predicate belongs to a lifecycle machine, whose
insert, update and delete transitions select guards and actions. The entity's
predicate list remains a derived projection for the browser preflight and IR;
it cannot introduce another authored rule.

Keeping validation as a separate entity field would preserve that ambiguity.
Moving every predicate into a statechart would require an artificial status
column for rules that inspect a write. The existing lifecycle interpreter is
the one-state machine over those writes, so it owns their guards directly.

## Access stays policy

RLS must refuse an unauthorized write before a privileged predicate reads
related rows. Evaluating that predicate in a BEFORE trigger would let its
refusal reveal information to a caller whose write is later denied. It would
also miss stored generated columns. Guarded lifecycle interpreters therefore
run AFTER and cannot use NEW assignments that PostgreSQL would discard then.
Their relational actions and any earlier transactional writes roll back when
a guard refuses. A declared SQL hatch still has unspecified delivery.

Access stays declarative RLS and the browser's visibility mirror. Putting it
inside a SECURITY DEFINER guard would combine authorization with the very
privileged reads authorization must precede.

## The two holders

The browser judges its visible snapshot before an optimistic mutation. The
server judges transaction-local rows after the write, including foreign-key
actions. On delete, event.row and state.items carry the previous row; related
rows are the current rows at that seat, not a historical snapshot. A false
answer is a named refusal. A non-boolean is a program error at both seats.

The browser checks a whole local batch before calling its mutation client.
Request-only batches remain separate server requests, each protected by its
transaction. This adds no cross-request transaction guarantee.

Predicate SQL function identities and refusal names are retained so client
error handling stays stable. Applying the generated predicate and machine
migrations together removes the old validation-only trigger and installs the
new interpreter; declaration edits alone cannot upgrade an existing volume.
