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

The container door rewrites the route to PostgREST's `/rpc/signal_in` and states the path
in `X-Signal-Path`, so no service is added and no provider's `Authorization` reaches it.
The edge's object calls the function directly.
