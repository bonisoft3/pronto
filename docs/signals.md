# Signals

A webhook is a provider's word that a row may have changed. A signal takes it as
exactly that: nothing in the body is believed and no signature is checked, because
all a signal can do is send a machine's event to one row, and the state that event
enters asks the provider through an [external
effect](decisions/2026-10-03-external-effects.md). A forged signal costs one read.

```cue
state: signals: payment: {
    machine: "OrderMachine"
    event:   "recheck"
    id:      {body: ["data", "object", "client_reference_id"]}  // or {path: true}
    count:   "checks"
}
state: effects: "read-session": {key: ["id", "checks"], ...}
state: mecha: rows: OrderMachine: states: {
    awaiting: on: recheck: "checking"
    checking: invoke: {src: "read-session", onDone: "paid", onError: "awaiting"}
}
```

The route is `POST /signal/<name>`, with `/<id>` when `id` is `{path: true}`. It is
public. Both doors call the one emitted function, `airlock.signal`.

| The row | The answer |
|---|---|
| In a state that takes the event | 200 `moved`; `count` goes up by one, so the effect's ledger key is new |
| In a state that invokes an effect | 503: the provider's redelivery is what keeps a signal that arrives mid-check |
| Anything else, or no such row, or no id in the body | 200 `ignored` |

An unknown name answers 404, a body that is not JSON 400, and a body past 1 MiB 413.

The `count` field is in the effect's `key` because a ledger key is performed once and a
row is checked often. Each move therefore adds a ledger row, forged ones included.

The state the event enters may invoke a [read](decisions/2026-10-03-external-effects.md#reads)
instead: a GET whose answer moves the row, with no handler and no key. A read's state
refuses a request's anonymous role, which is the role a signal arrives under, so
`airlock.signal` names the table, the machine's state field, the row and the state its
move enters, as a JSON array and for that update alone, and the interpreter of a read's
state a signal's event enters admits exactly that move. An anonymous client's own write
into the state stays refused, and so does anything else a transition's action writes into
a read's state during the signal, another row or another machine's field on the same
row, which fails the signal whole. A read counts its entries in a field only its
machine writes, so the signal's `count` is another field. A read no signal's event
enters keeps its interpreter as it is; one that gains a signal on a database that
outlived a release has its machine restated in a forward migration
([[schema-change-admission|schema changes]]).

What an unauthenticated caller can make the app ask is bounded per row, for a read as
for a handler effect: a row asks once at a time, since a signal mid-check is refused with
503, and only while it stands in a state that takes the event. Where the state an answer
leads to takes the event again, each further signal is one more check, with a new count:
nothing limits how many over time, or across the rows whose ids a caller knows. One
check is one call where the provider answers; where it does not, a handler effect is
called up to its `attempts` and a read up to five runs of got's retries. A read's answer
the airlock's cache still holds fresh is not asked again.

The container door rewrites the route to PostgREST's `/rpc/signal_in` and states the path
in `X-Signal-Path`, so no service is added and no provider's `Authorization` reaches it.
The edge's object calls the function directly.
