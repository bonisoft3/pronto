# The loop as a first-class citizen

Date: 2026-07-30. Status: frozen design; lands immediately after the
stage-4 workflow releases emit.cue.

The concept triad, completed: *virtual cluster* (backend contract, default
implementation mecha), *virtual terminal* (frontend contract, default
omnishell), and **the loop** (the development lifecycle contract — verbs,
TDD cascade, CI — default implementation **sayt**). Programs target a
cluster, users touch a terminal, developers turn the loop.

## Publication (the established pattern, applied)

- sayt publishes its role as the package, exactly like `mecha:cluster` and
  `omnishell:terminal`: file `plugins/sayt/loop.cue` declares
  `package loop`, so the product-facing import is **`sayt:loop`** —
  in-monorepo `bonisoft.org/plugins/sayt:loop`, on the mirror
  `github.com/bonisoft3/sayt:loop`.
- Pronto owns the roster by indirection: `plugins/pronto/loops/sayt.cue`
  (`package sayt`) re-exports the implementation, so consumers name the
  loop through pronto as **`pronto/loops:sayt`** — in-monorepo
  `bonisoft.org/plugins/pronto/loops:sayt`, externally
  `github.com/bonisoft3/pronto/loops:sayt` once pronto mirrors. A
  different loop (a bazel-loop, a gha-loop) is one more re-export file.
- Copybara: sayt's existing mirror carries loop.cue automatically (path
  rewrite already covers plugins/sayt); no new repos.

## #Loop shape

Input: what the loop needs to know about the app — name, lint validators
(pipeline yamls for rpk, caddyfile, islands script + files), build command,
test command (argv-shaped; the loop owns the argv doctrine, documented on
the field). Output: the loop surface as emitted files — `sayYaml` (the
verb rules: lint rulemap only; other verbs ride builtins) and `tasksJson`
(ide layer). Conventions the loop *documents as data*: the compose `launch`
service gate, agent-driven `verify` (evidence from the storybook, judgment
from the driving agent), the ten-verb vocabulary.

## Pronto integration

- The app package's top level becomes FOUR components: `code:`, `cluster:`,
  `terminal:`, `loop:`. program.cue wires
  `loop: (pronto.#DefaultLoop & {"code": code}).out`; the emitted bayt.cue
  redeclares `loop: sayt.#Loop` beside cluster/terminal — the loop is an
  override seam too (swap a verb's rule out-of-band without touching the
  program).
- #emit takes `loop` as an input and emits `loop.files` verbatim
  (".say.yaml", ".vscode/tasks.json"); the inline .say.yaml/tasks.json/
  _buildCmd/_testCmd logic moves OUT of emit.cue INTO sayt's loop.cue.
- Prelude gains a Loop section (hop-1: briefs never describe build/test/
  deploy mechanics; the loop is platform doctrine). SPEC's component list
  and README's concept pairing update to the triad + code.
- Byte gates: todo and keep must re-materialize byte-identically after the
  move (pure refactor of emission ownership).
