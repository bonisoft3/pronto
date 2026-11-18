---
type: decision
title: "Drive's roles and groups, and the origin of an event"
description: Takes more of the two borrowed models a company's data needs rather than adding a third — a grant carries Drive's reader or writer role and a row is shared with groups, and a mecha rule is XState's one argument whose event names who sent it — and states where each still departs from its model.
status: partially-built
---

# Drive's roles and groups, and the origin of an event

A program whose data belongs to a company, and not to one reader, met two gaps
at once. [[../access|Access]] claimed Drive's model and held a third of it: a
grant named a user and carried the owner's full power. And a rule could not ask
who was acting in a form anyone would recognize: a mecha rule took three
positional arguments of our own, and a lifecycle guard took none that named the
sender.

Both are closed by taking more of a model the author and a language model
already know. Neither model is taken whole: [[#Where this is not Drive]] and
[[#Not XState, and stated]] list what a reader who knows the model would
expect and not find.

| Question | Model | What was missing |
| --- | --- | --- |
| Who reads a row, and who edits it | Google Drive: an owner, grants to users and groups, each with a role, inherited by what is under the row | roles, groups, and an owner only the owner replaces |
| Who may take a step | XState: a guard over `{context, event}` | the event did not say who sent it |

The two meet at one point. A guard reads `event._origin`, and may follow an edge
from it to the origin's memberships; the machine knows nothing else of groups or
roles.

## What a grant with no role allowed

Evidence: a company as a `private` row shared through a member table, with
compositions under it, run on mecha's database with the migrations the emitter
wrote and three subjects entering as PostgREST enters them. Containment held: a
member read the company and what was under it, and an outsider read and wrote
nothing. Every member was the owner in all but name:

| A member | Before |
| --- | --- |
| adds an outsider as a member, who then reads the company's rows | allowed |
| removes every other member | allowed |
| sets `owner` to themself, after which the owner reads nothing | allowed |
| renames or deletes the company | allowed |

Declaring the member table `internal` stopped the first two and hid the list
from everyone, the owner included; it did not stop the takeover.

## A grant carries a role, and a row names its groups

Built, at the cluster ([[../access#Roles|the reference]];
[[../../drive-access.integration.test.ts]] holds every line below against
mecha's database).

- **Role.** `shared.role` names the grant table's column holding `reader` or
  `writer`, Drive's own words. A reader reads the row and what is under it; a
  writer changes both. A grant table with no role column grants `writer`.
- **Owner.** Only the owner deletes the row or sets another owner, and is
  then its writer, by a grant row the cluster writes in place of the two
  users' grants. Drive transfers ownership the same way.
- **A writer shares.** A writer edits the row's grant table, as Drive's
  editor adds people, and `shared.writersCanShare: false` is Drive's setting
  of that name, declared for the entity where Drive holds it per file.
- **Group.** `groups` shares a row with the group `<value>:<name>`, where the
  value is the row's key or the column `of` names, as Drive's `finance@acme` is
  a name at a domain. Membership is the program's one `scope: "group"` entity:
  a member reads the rows addressed to them and only the service writes one,
  as Drive's groups are administered outside Drive.
- **A refusal is an error.** A reader's update finds the row and fails its
  check; a delete is refused by a trigger. Without both, each would answer no
  rows and no error, and the store would wait on a write that had changed
  nothing.
- **A group is granted a row.** `shared.group` names a second column of the
  grant table, the group's id as the membership list writes it. A member
  holds the row's role while they are a member, and a grant fills its user
  or its group, which a check holds.

A group the row names by another column is one shape, whatever the table
holds. An advance shared with `finance` of its `company_id` reaches the sync
path as `advance where group_finance = '<company>:finance'`, and a composition
under it carries the same column.

mecha's floor is unchanged, and its client learns one thing: a group's
memberships open shapes as a grant list does. A membership row carries its
member's scope, so the floor delivers it; `mecha.shape_reach` already asks whether the caller reads a row of
the parent an edge names, and a subject reads a membership row for a group
exactly when they are in it.

## A rule is XState's one argument

Built. A mecha rule was `(state, event, context)`: the event held `kind` and a
nested `payload`, a third argument of ours held `actor`, `now` and `entropy`,
and a guard answered `true` or the name of its refusal. XState gives a guard
and an action `{context, event}` and nothing else, an event `type` with its
payload's fields beside it, a guard that answers a boolean, and no notion of
a sender; whoever sends an event states what the receiver needs.

So the runtime, which is where every event is sent from, states it on the
event, and a guard is a boolean:

```js
inTurn: ({context, event}) => context.turn === event._origin,
inTime: ({context, event}) => event._time < context.deadline,
```

```cue
on: play: {guard: ["inTime", "inTurn"], actions: "play"}
setup: guards: {
	inTime: {reads: ["_time"], reason: "expired"}
	inTurn: {reads: ["_origin"], reason: "not_your_turn"}
}
```

| Was | Is | From |
| --- | --- | --- |
| three positional arguments | `{context, event}` | XState |
| `event.kind` | `event.type` | XState |
| `event.payload.slot` | `event.slot` | XState |
| a guard answering `"not_your_turn"` | a boolean, and `reason` in `setup` | XState; a database guard's `reason` |
| `context.actor` | `event._origin` | SCXML's `_event.origin`, which XState v4 handed a guard |
| `context.now` | `event._time` | CloudEvents' `time` |
| `context.entropy` | `event._entropy` | none |

A string is truthy: a guard answering `"not_your_turn"` refused the event here
and would have allowed it under XState. A guard that answers anything but a
boolean is now a program error, so a rule carried over from the old form
fails at its first step and does not pass silently.

What the runtime states begins with an underscore, the prefix SCXML reserves
for the platform's own names (`_event`, `_sessionid`), and no payload or
input field may begin with one; `time` and `origin` are an app's to use, and
`type` is not, being the event's own name. The
fields cannot be in `input`: XState hands `input` to the context factory when
an actor is created and to nothing after, so what varies by step reaches a
guard on the event or not at all. `_origin` is stated by the runtime and
never by the sender, as a browser states `MessageEvent.origin`. An event the
machine's own tier sends has none, and the contract lint already finds a rule
that reads one there. `actor` was the wrong word besides: in XState an actor
is a running machine.

A contract's `reads` name event fields: `["_origin", "_time", "slot"]`.

A lifecycle guard is the same one argument, as every leaf the terminal runs
is, and its event has the same field: `_origin` is
`user:<id>`, the form a scope has, and absent on a write the service makes.
`via: ["_origin"]` walks to the origin's rows of the membership list, so a
guard asks whether the sender is in a group:

```js
({context, event}) => context.rows.group_member.some((m) => m.group_id === event.row.company_id + ":payers");
```

## Where this is not Drive

Drive's sharing is a list of permissions on a file, each `{type, role,
emailAddress}` with `type` one of `user`, `group`, `domain` or `anyone`. What
is here is its roles, its owner and its grants to a user or a group, with the
grantee spelled differently.

- **A grantee's type is a column, not a value.** Drive shares one file with
  a group by adding a permission of `type: group` to it, and a grant row does
  the same: it names a user or a group and carries a role. Drive's permission
  has one grantee field and a `type` beside it. Here the grant table has a
  column for each and a row fills one, because mecha's floor gives a column
  one sync edge, and a user's grants and a group's are reached differently.
  `groups` remains beside it, and is not Drive's: it shares every row of an
  entity with a group the row names, as one shape.
- **`writersCanShare` is the entity's.** Drive's owner sets it on one file;
  here the program declares it for every row of an entity.
- **A previous owner of a row with no grant table keeps nothing** but what a
  group gives them: an entity shared by `groups` alone has nowhere to write
  the grant Drive leaves them.
- **A handover is not accepted.** Drive asks the receiver of a file to
  accept it; here the owner column is set and the row is theirs.
- **A declared group's name** is `<value>:<group>`, where Drive's is an address.
- **Not taken:** `commenter`, the `domain` and `anyone` grantees (`public`
  is every row read by anyone), an expiring grant, and a file of the folder
  owned by whoever created it: what is under a row has no owner of its own.

## Not XState, and stated

Verified against XState v5: a guard and an action are handed
`({context, event}, params)`, an event is `{type, ...payload}`, a guard
answers a boolean, and a context factory is handed `{input}`.

- **A transition names several guards.** XState composes guards with
  `and([...])`, a function its JSON form cannot spell; a transition here lists
  their names, tried in order, as a lifecycle transition already does. The
  list is what lets each refusal keep its own reason.
- **A refusal has a reason.** XState reports an event no transition takes and
  not why. The reason is declared in `setup` beside the guard's contract, where
  a database guard's already was, and is no part of the rule.
- **An action is the assigner.** The configuration names an action and the
  runtime treats what it returns as the context, as XState's `assign` treats
  its assigner's. An action that is not an assignment is a list of relational
  effects in `setup`.
- **The input holds the time.** The initializer is XState's context factory,
  `({input})`, and whoever creates an actor states its input. The runtime
  creates every instance and adds `_time` to what the admission or the spawn
  stated.
- **`invariant`, `project` and `publish`** are rules no configuration names
  and XState has no part for: `(state)`, `(state, viewer)`, `(state)`.
- **A reducer's origin is the name the machine admitted the sender under**, a
  seat, where a lifecycle guard's is `user:<id>`: mecha maps a member to that
  name before the step, and the rules compare it with the seats they hold.
- **`tier`** stays on an event's declaration, where it says which side may
  send it, and is no longer handed to a rule: an origin says as much.
- **A handler returns its writes.** A handler, and a guard or an action of a
  machine the terminal runs, a lifecycle guard among them, is handed
  `({context, event}, params)` as a mecha rule is. A handler answers
  `{updates, then}`, the rows it writes and the beat it asks for, where
  XState's action answers nothing and assigns through `assign`.
- **A composed handler's second argument is its machines.** The module a
  Cortex actor names is handed `{machine, machines}` where XState hands
  `params`: both are what the configuration states for the leaf.
- **`context` is read, not kept.** XState's context is the actor's own
  state. A terminal leaf's is the rows the terminal read for this wake,
  `items`, `rows`, `params` and `locale`, and what it returns is written to
  the store.

## Unbuilt

- **The terminal's seat for roles.** The store shows a reader the row and
  runs their write, which the cluster refuses; nothing in the store refuses it
  first, as it refuses a validation.
- **Groups under the store, in a browser.** The client opens a group's
  shapes, a declared group's and a granted one's, under unit test. The
  store's `visible()` reads both and is under none, as its reading of a
  user's grant is not. Neither has run against a cluster.
- **The edge.** The policies are the same SQL, but the edge serves no keyed
  shape, so the `cloudflare` target refuses a shared entity as `pages` does.
- **A membership of a row that is gone.** The list has no reference to what
  a group is of, so a membership the service leaves behind opens a shape the
  gatekeeper refuses, and the client reports it.
- **Policy order.** A row whose group is named through a reference to a
  shared row calls that row's role function, so the referenced entity is
  declared first; the emitter does not reorder.

## Alternatives not taken

- **A role vocabulary of the program's own, or permissions as names.** A
  permission such as "pays advances" is membership of a group and a guard that
  asks for it. A ladder beyond Drive's two roles would be ours to teach.
- **OpenFGA or SpiceDB.** Drive's model is an instance of theirs, and their
  schema is a second language for what `#Access` states in four keys.
- **OPA or Cedar.** Each decides one request. A rule here is enforced three
  times, as a policy, as a shape's predicate and in the store, and neither
  engine compiles to the last two.
- **The company as a scope every member holds**, on the floor. A shape carries
  the floor and nothing above it, so every member's terminal would be sent
  every row of the company; it fits a row with one audience and an advance has
  three.
- **Roles as guards alone.** A guard allows by default: a composition with no
  guard would be every member's to write. A role denies by default, and the
  guard is kept for what depends on the row's state.
- **The runtime's fields in `params`**, the second argument XState hands a
  guard. `params` are the machine's own, written in its configuration; a
  value the runtime supplied there would wear the name of something else.
- **Unprefixed `origin`, `time` and `entropy`.** A payload could not use the
  three names, and nothing in a rule told a field the sender wrote from one
  the runtime vouches for.
- **`userId` on the event.** It would make every machine speak of
  authorization. Where an event came from is a fact about the event.
- **A generic metadata bag.** The sender would fill it beside what the
  runtime stamps, and a guard could not tell the two apart.
- **Renaming `tier` to `origintype`.** `tier` is the word for where code runs
  throughout, and SCXML's `origintype` names a transport.
