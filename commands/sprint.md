---
description: Wrap four turns into a sprint — refresh the brief, collect the journal, walk the whole ledger, cut a release, harvest the mechanisms, re-plan
argument-hint: "[sprint name or number]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Workflow, Agent, Artifact
---

# One sprint

The sprint: **$ARGUMENTS**

## What a sprint is

A turn is one engineer-week: one slice end to end, with its oracle, its gates,
its seats and a live walk. A sprint is four turns and a wrap. The wrap is half a
turn, mostly mechanical, and it does what no single turn owns: the plan drifts,
the journal grows, the acceptance ledger is trusted rather than walked, and
what the turns learned about the platform stays in the dispositions. A sprint
is also the unit that ships; a turn is the unit that merges.

Why four and not ten: ten engineer-weeks between wrap-ups is a quarter, and a
plan is stale long before that. Four is a month of engineer-weeks, which is
where a brief refresh, a journal collection and a re-plan pay for themselves
without becoming ceremony.

The three rules of a turn hold here unchanged: a verb adjudicates what a verb
can adjudicate; every step ends in a verdict; write no state. The sprint has no
file of its own. Its opening line is the rewrite of `brief.md` and its closing
line is the wrap's entry in `journal.html`, so a reader finds a sprint by that
entry and nothing new is introduced.

## When to run it

After the fourth feature turn since `brief.md` was last rewritten, or sooner when the
plan's next item no longer describes what the app needs. Not after every turn:
a wrap after one turn is the turn's own Rung 4 done twice.

## The wrap

### 1. Refresh the brief

Rewrite `brief.md` in place; `brief.html` beside the journal renders it, and
the journal never carries a copy. It says what the product is today, in the
product's words, and carries the plan: the next sprint's four turns made
concrete, one slice each, and the rest left coarse. Mark the turns this sprint
finished. A plan item that no turn will take is deleted here, not carried. A
person may have edited the brief mid-sprint; the rewrite keeps what they wrote
and plans from it.

### 2. Collect the journal

Superseded entries and their `journal/` files leave `HEAD`; git holds the
history. A capture taken before a visible change the sprint made (a rename, a
redesign, a strip that changed) is retaken from the live stack or dropped with
its entry. Every image the journal cites exists and shows what its caption
says; the `qa` seat checks this per turn, the wrap checks it for the whole.

### 3. Walk the ledger

Every id in `acceptance.md` is walked once against the live stack in one pass,
in the order the ids appear, with two sessions where a line names two people.
A turn walks its own lines and trusts the earlier ones; the sprint boundary is
where the whole ledger is due. An id that cannot be walked is a finding, not a
skip. Where the app carries an acceptance driver (`build: checks`), run it and
walk by hand only what it does not cover.

### 4. Cut a release

The full gate chain from `sayt generate` to `sayt integrate`, then
`sayt release --snapshot` locally, then the tag on the merge commit. A sprint
that cannot cut a release is not done; name the gate that refused.

### 5. Review the sprint, not the turns

Launch the `product` and `architect` seats **in the background** over the four
turns as a whole: `brief.md`, the four journal articles, the decisions the
sprint added, and the dispositions it declined. The per-turn seats look at a
slice; this pass looks at the seams between slices — a control named three ways
on three screens, a decision one turn made that a later turn quietly undid, a
cost accepted four times. Findings are dispositioned in `ir.html`'s team-review
section under the sprint's heading, as a turn's are.

### 6. Harvest the mechanisms

Every trap that cost the sprint a relaunch cycle becomes a rule in the platform
reference (`llms.txt`), placed in the section it belongs to and phrased as a
mechanism, never as a changelog. Every seam the sprint worked around becomes a
line in `PENDING.md` naming whose pain it removes. Doing this once per sprint
is what keeps the reference free of recency bias; per turn it would tilt
toward whatever broke last.

### 7. Record what it cost

Prepend the wrap's entry (`<article id="sprint-YYYY-MM-DD">`) to
`journal.html`: one line of cost — turns, wall time, defects found by seats
against defects found by the live walk, dispositions declined — and the
harvest's pointers. The next plan is estimated from the cost line, in
engineer-weeks, one per turn.

## Hand back

Report the wrap by step: step, gate, outcome. Name the ledger ids that could
not be walked and the release gate if one refused. Then the next sprint's first
turn starts as `/pronto:turn` with the plan's first concrete item.

## What a sprint does not do

| Not here | Because |
|---|---|
| A sprint file or board | `brief.md` opens the sprint and the wrap's journal entry closes it; the tree is the state |
| A retrospective document | The harvest and the cost line are the retrospective, in the places the next reader looks |
| A turn's rungs again | Each turn already ran its gates and seats; the wrap reads across them |
| A velocity metric | One turn is one engineer-week by definition; the cost line records the variance |
