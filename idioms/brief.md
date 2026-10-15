# Idioms

Four small screens, each the least a pure pronto app needs to show one thing
working. They exist to be copied from.

## Data

A counter, a todo list that survives a reload, a five-by-five board of lights,
and a timer with a die.

## Screens

- **Counter** — two buttons step a number.
- **Todo** — add a task, tick it off, remove it.
- **Lights out** — pressing a light flips it and its four neighbours; the board
  counts the moves and the lights still lit.
- **Timer** — start and pause a clock that counts seconds; roll a die.

## Behavior

Everything happens in the reader's browser and the same presses give the same
screens, rolls included when the page is opened with a seed.

![[acceptance]]

## Out of scope

Accounts, sharing, and anything that needs a server.
