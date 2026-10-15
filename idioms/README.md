# Idioms

The least a pure pronto app needs to show each concept working. The authored
files are `brief.md`, `acceptance.md`, `DESIGN.md`, `ir.html`, `program.cue`,
`messages/`, `shell/screens/`, `shell/handlers/` and `tests/handlers.test.ts`;
everything else here is emitted by `generate` and is never copied or edited.

| Screen | Concepts | Read further |
|---|---|---|
| Counter `/` | **reduce**: a seeded `tab` row, a click, `from` telling buttons apart, a minted entity id | omnishell `GUIDE.md` (the reduce contract), `docs/types-and-identity.md` |
| Todo `/todo` | **forms**: `create` mints the key, `{now}` in a hidden `data-value`, a form inside an item updates that item; `device` durability; `{msg.*}` in two locales; state as an attribute CSS draws | omnishell `docs/data.md`, `docs/lattice.md`, `docs/localization.md` |
| Lights out `/grid` | **fold**: the row id is the datum, a CUE-computed seed, read vs heard, recompute absolutely and write differentially, total over any rows | omnishell `GUIDE.md` (rules that bite), `docs/data.md` |
| Timer `/timer` | **machine and time**: a `data-machine` chart, `after` on the terminal's clock, a draw by `then: {seed: true}` | omnishell `docs/machines.md`, `docs/data.md` (the step after) |

`tests/handlers.test.ts` loads a handler file as the value it is and calls it.
Replay any screen with `?clock=manual` and `?seed=`.

## Start an app

Bootstrap the app's directory as pronto's
`skills/pronto-turn/references/bootstrap.md` says; it writes only there and in
mise's cache. Copy the authored files, change
them, and loop until each exits 0:

```sh
./saytw generate && ./saytw lint && ./saytw test && ./saytw integrate
```

Then launch it and use it as a person would, play the game or walk the flow,
and capture what you saw. The app is done when `integrate` exits 0 and using it
shows what the brief promised: a page written by hand or a test written around
the handlers is not the app. Rewrite the app's journal with the turn's before and
after, as the pronto-turn skill says.

