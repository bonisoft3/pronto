# A unit's events are typed by the program, not by the seat

Status: built. The contract is in omnishell's [terminal reference](https://github.com/bonisoft3/omnishell/blob/v0.23.0/docs/terminal.md); this record keeps the argument.

## Context

A vendored unit answers through named events whose detail crosses a realm
(sandboxed iframe) or agent (worker) seat. Today the seat applies one grammar to
every event: at most 8 keys matching `^[a-z][a-z0-9_]{0,23}$`, each a
printable-ASCII string of at most 128 characters (`DETAIL` in omnishell's
`hatch.js`, the `hatch.<seat>.detail` offer in `terminal.cue`). Its stated
threats are a megabyte, a control character, a getter and a nested object
reaching a screen.

The alphabet was never argued, and it decides what a unit may be. An address
search cannot return "Praça da Sé"; a map cannot return a label over 128
characters; an image-producing unit cannot answer at all. Meanwhile two of the
four threats are already the browser's: `postMessage` delivers a structured
clone, so no getter, function or prototype reaches the receiver.

The seat cannot know what an event means. The program can: a machine's events
already carry a payload `#Shape` (mecha `machine.cue`) that the browser and the
database both check, and a memo's answer already lands in an entity whose
fields carry `cel`.

## Decision

**The seat enforces size; the declared type enforces everything else.**

1. *Floor.* A seat admits a structured-clone value whose total size is at most
   10 MiB: strings counted as UTF-16 bytes, binary by `byteLength`/`size`.
   It enforces no alphabet, key grammar or depth. (Built with no binary
   shape yet, so today a detail is strings, numbers, booleans and lists.) The cap bounds what reaches
   the screen, the reduce and the store; deserialisation already happened, so
   it does not bound what a hostile frame can make this thread allocate. That
   cost is the price of embedding, as it is for any frame.
2. *Type.* `ports.raises` becomes a map from event name to a payload
   `#Shape & {type: "object"}` — the grammar machine events use, not a new
   one. The seat rebuilds the detail from that shape, deep-freezes it, and
   delivers only the rebuilt value. A memo's answer is typed by its entity's
   columns and their `cel`, which it already lands in.
3. *Failure* keeps today's split: the realm seat drops a failing event, since
   its sender is a provider's page; the agent seat raises a `ProgramError`,
   since its sender is the app's own wrapper and a lost answer would leave a
   question standing.

This is input handling as LangSec states it — the receiver recognises the
language it consumes, declared where its meaning is known — and "parse, don't
validate": only the value the shape rebuilt crosses.

## Alternatives

- *Widen the alphabet* to a named Unicode subset (RFC 9839 assignables,
  PRECIS `FreeformClass` of RFC 8264) at the seat. It fixes the address case
  and still refuses binary, so it would be revisited by the first image unit.
  A text field that needs such a subset states it in its own shape.
- *Keep the seat grammar and raise its limits.* Every number chosen is wrong
  for some unit, because the seat is the one place that cannot know which.
- *No floor.* A unit could hand a reduce, a store row and a DOM event an
  unbounded value; size is the one property no declared type is asked about.

## Consequences

- `DETAIL`, `parseDetail`, the `detail` offer, the equality test in
  `vendored-unit.test.ts` and `#emit`'s memo-against-detail check are removed;
  `#emit` instead checks that each raised name has a shape and that a memo's
  single event is typed by its entity.
- Existing units restate `raises: [...]` as a map of shapes.
- `#Shape` has no binary type and caps strings at 65536. Text units need
  neither change; the first unit returning an image adds a binary shape there,
  where machines get it too.
- `#Shape` strings carry no alphabet. Bidirectional controls reaching text are
  a display spoof, not an injection — `textContent` renders them inert — and a
  field that must refuse them gains that constraint in `#Shape`, not the seat.
