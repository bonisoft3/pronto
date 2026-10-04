// #App.#sync, each reason it gives: one small program per case, whose `goal`
// table is the one judged. A table is on demand only when every read of it is
// a view whose subset Electric can state, or one the server computes.
package emit

import pronto "github.com/bonisoft3/pronto"

_syncFields: [
	{name: "id", type: "uuid", pk: true},
	{name: "game_id", type: "uuid"},
	{name: "player_id", type: "uuid", ref: "player"},
	{name: "name", type: "string"},
	{name: "done", type: "bool"},
	{name: "at", type: "timestamp"},
	{name: "n", type: "int64"},
	{name: "on", type: "date"},
]

// Inputs a case leaves out are none, chosen by a guard rather than a default:
// a disjunction here is one the evaluator carries into every entity.
#syncCase: {
	reads: [...pronto.#Read]
	writes?: [...pronto.#Write]
	goal?: {...}
	more?: {...}
	pipelines?: {...}
	app: pronto.#App & {
		state: {
			entities: {
				Goal: [if goal != _|_ {goal}, {table: "goal", durability: "live"}][0] & {fields: _syncFields}
				Player: {table: "player", durability: "live", fields: _syncFields}
				Note: {table: "note", durability: "live", access: {scope: "private", owner: "player_id"}, fields: _syncFields}
				Draft: {table: "draft", durability: "tab", fields: [{name: "id", type: "uuid", pk: true}]}
				[if more != _|_ {more}, {}][0]
			}
			"pipelines": [if pipelines != _|_ {pipelines}, {}][0]
		}
		capabilities: {hatches: {}, vendored: {}}
		surface: {
			screens: jogo: {
				title:   "Jogo"
				route:   "/jogo/:id"
				"reads": reads
				"writes": [if writes != _|_ {writes}, []][0]
				forms: []
				states: []
			}
			handlers: {}
			design: {}
			flows: {}
		}
		meta: {
			name:        "sync"
			description: "the sync rule"
			ir: sha256: ""
			targets: []
			clocks: []
			decisions: {}
			tests: {}
		}
	}
	out: app.#sync.Goal
}

#view: pronto.#Read & {
	table:  *"goal" | string
	kind:   *"live" | _
	nested: *false | _
	lists: *[] | _
	route:  *"view" | _
	clauses: *[{col: "game_id", op: "eq"}] | _
	embeds: *[] | _
	orders: *[] | _
}
_view: #view
_onDemand: {mode: "on-demand", reason: "every read of it is a view whose filter Electric compares, or the server's"}

syncViews: (#syncCase & {reads: [_view, #view & {clauses: [{col: "id", op: "eq"}]}]}).out & _onDemand
syncReduce: (#syncCase & {reads: [_view, {table: "goal", kind: "reads", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]}).out & {
	mode: "eager", reason: "jogo.html reads it whole for a reduce (data-reads)"
}
syncNamed: (#syncCase & {reads: [_view, #view & {kind: "named"}]}).out & {
	mode: "eager", reason: "jogo.html reads it through a named read, which no view is proved to serve"
}
syncWhole: (#syncCase & {reads: [#view & {route: "whole", clauses: []}]}).out & {
	mode: "eager", reason: "jogo.html reads the whole table"
}
syncBoolean: (#syncCase & {reads: [#view & {route: "snapshot", clauses: [{col: "done", op: "true"}]}]}).out & {
	mode: "eager", reason: "jogo.html filters it with is.true, which the view engine cannot state"
}
syncPattern: (#syncCase & {reads: [#view & {route: "snapshot", clauses: [{col: "name", op: "ilike"}]}]}).out & {
	mode: "eager", reason: "jogo.html filters it with ilike, which the view engine cannot state"
}
// A cap pages with a cursor comparing the order's columns; uncapped, TanStack
// orders the rows itself.
syncCappedDomain: (#syncCase & {reads: [#view & {limit: 5, orders: ["at"]}]}).out & {
	mode: "eager", reason: "jogo.html caps it ordered by at, and the cursor past the cap compares it, which Electric cannot"
}
syncUncappedDomain: (#syncCase & {reads: [#view & {orders: ["at"]}]}).out & _onDemand
// Postgres picks the rows inside a cap by its collation, and the view orders
// them by the reader's locale: for free text the two differ, so the view would
// show rows an eager table does not. A uuid or a date orders alike in both.
syncCappedText: (#syncCase & {reads: [#view & {limit: 1, orders: ["name"]}]}).out & {
	mode: "eager", reason: "jogo.html caps it ordered by name, which Postgres orders by its collation and the view engine by the reader's locale"
}
syncCappedSpelled: (#syncCase & {reads: [#view & {limit: 1, orders: ["on", "id"]}]}).out & _onDemand
syncUncappedText: (#syncCase & {reads: [#view & {orders: ["name"]}]}).out & _onDemand
// An int64 is a canonical string whose text order is not its value order.
syncUnsorted: (#syncCase & {reads: [#view & {orders: ["n"]}]}).out & {
	mode: "eager", reason: "jogo.html orders it by n, which the view engine does not order"
}
syncDomainFilter: (#syncCase & {reads: [#view & {clauses: [{col: "at", op: "eq"}]}]}).out & {
	mode: "eager", reason: "jogo.html filters it on at, which Electric cannot compare"
}
syncFold: (#syncCase & {
	reads: [_view]
	pipelines: tally: {from: "Goal", to: "Player", fold: {projects: "n", watermark: "w", dedupe: ["id"], pair: {table: "player"}}}
}).out & {mode: "eager", reason: "the fold tally projects the reader's own contribution from it"}
syncValidationEdge: (#syncCase & {
	reads: [_view]
	more: Card: {table: "card", durability: "live", fields: _syncFields, validations: fair: {src: "shell/handlers/fair.js", via: ["Goal.player_id"], note: ""}}
}).out & {mode: "eager", reason: "validation Card.fair walks to it"}
syncOffline: (#syncCase & {reads: [_view], goal: {table: "goal", durability: "offline"}}).out & {
	mode: "eager", reason: "offline keeps the whole table on the device"
}
syncPrivate: (#syncCase & {reads: [_view], goal: {table: "goal", durability: "live", access: {scope: "private", owner: "player_id"}}}).out & {
	mode: "eager", reason: "Goal is private, and a view cannot restate its visibility"
}
// A write by key loads a row no view loaded as a view of its key, so the key
// may come from anywhere: a pick from a list the server computes, here, with
// or without a view of the table beside it. The store's half is
// ondemand-smoke.js's "a write by key loads the row no view loaded".
syncUpdateElsewhere: (#syncCase & {reads: [_view, {table: "goal", kind: "live", nested: false, lists: [], route: "server", orders: []}], writes: [{table: "goal", op: "update"}]}).out & _onDemand
syncUpdateUnviewed: (#syncCase & {reads: [_view & {table: "player"}, {table: "goal", kind: "live", nested: false, lists: [], route: "server", orders: []}], writes: [{table: "goal", op: "delete"}]}).out & _onDemand
// The view of its key is one Electric must be able to compare.
syncUpdateUncomparedKey: (#syncCase & {
	reads: [#view & {table: "tick"}]
	writes: [{table: "tick", op: "update"}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#sync.Tick & {
	mode: "eager", reason: "jogo.html updates a row of it by id, which Electric cannot compare to load the row"
}
syncUpsert: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "upsert"}]}).out & {
	mode: "eager", reason: "jogo.html upserts it, which finds the row by natural key in the table"
}
// A form's write is read from writes alone, as the markup reader records it
// (read-markup.ts, "a form's writes").
syncDeleteFiltered: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "delete", filter: "game_id=eq.{id}"}]}).out & {
	mode: "eager", reason: "jogo.html deletes from it by filter, which finds the rows in the table"
}
// A reduce bound to a click writes as one bound to a mutation does; the
// markup reader records both as op "reduce" (read-markup.ts, "every reduce's
// writes").
syncReduceWrites: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "reduce"}]}).out & {
	mode: "eager", reason: "jogo.html writes from a reduce, whose updates and effects may write any table"
}
// Regression: a reduce was recorded as a put on its region's table only, so a
// table another of its updates named stayed on demand, and the store refused
// the put (ondemand-smoke.js, "a write by key") on the first gesture.
syncReduceWritesElsewhere: (#syncCase & {reads: [_view, #view & {table: "player"}], writes: [{table: "player", op: "reduce"}]}).out & {
	mode: "eager", reason: "jogo.html writes from a reduce, whose updates and effects may write any table"
}
syncPrivateEmbed: (#syncCase & {reads: [#view & {embeds: ["note"]}, {table: "note", kind: "live", nested: false, lists: [], route: "server", orders: []}]}).out & {
	mode: "eager", reason: "jogo.html embeds Note, whose visibility a join cannot restate"
}
// A view of a private table is read through the snapshot path, which reads
// what it embeds whole. Regression: only the embedded tables' visibility was
// asked, so the embedded table went on demand and the read threw.
syncPrivateViewEmbeds: (#syncCase & {reads: [#view & {table: "note", embeds: ["goal"]}, _view]}).out & {
	mode: "eager", reason: "jogo.html embeds it in a read of Note the view engine does not maintain"
}
// The read falls to the snapshot path, which reads the embedded collection
// whole as well.
syncSnapshotEmbed: (#syncCase & {
	reads: [#view & {table: "player", route: "snapshot", clauses: [{col: "done", op: "false"}], embeds: ["goal"]}]
	writes: [{table: "goal", op: "create"}]
}).out & {
	mode: "eager", reason: "jogo.html embeds it in a read of Player the view engine does not maintain"
}
// A join loads the embedded rows by key, so the key is one Electric compares.
syncJoinUncomparedKey: (#syncCase & {
	reads: [#view & {embeds: ["tick"]}, {table: "tick", kind: "live", nested: false, lists: [], route: "server", orders: []}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#sync.Tick & {
	mode: "eager", reason: "jogo.html joins it on id, which Electric cannot compare"
}
// Regression: a view read once per row of a list (a championship's category,
// a standing's zone chances) sent one subset request per row, where an eager
// table loads once; its join's key is loaded per row the same way. A view
// nested only in slots reads once, as a slot binds one row, and so does one
// in a list whose filter pins a key (a game's goals, under the one game).
_players: #view & {table: "player", clauses: [{col: "done", op: "eq"}]}
syncListed: (#syncCase & {reads: [_players, #view & {nested: true, lists: [0]}]}).out & {
	mode: "eager", reason: "jogo.html reads it once per row of a list"
}
syncListedJoin: (#syncCase & {reads: [_players, #view & {table: "player", nested: true, lists: [0], clauses: [{col: "id", op: "eq"}], embeds: ["goal"]}, _view]}).out & {
	mode: "eager", reason: "jogo.html joins it in a read once per row of a list"
}
syncSlotted: (#syncCase & {reads: [#view & {nested: true}]}).out & _onDemand
syncListedOne: (#syncCase & {reads: [#view & {table: "player", clauses: [{col: "id", op: "eq"}]}, #view & {nested: true, lists: [0]}]}).out & _onDemand
syncServer: (#syncCase & {reads: [{table: "goal", kind: "live", nested: false, lists: [], route: "server", orders: []}]}).out & _onDemand
syncUnread: (#syncCase & {reads: [#view & {table: "player"}]}).out & {mode: "eager", reason: "no screen reads it"}

// The mode is the entity's, so an authored one that agrees stands. One the
// rule contradicts fails to unify, which sync.test.ts asks cue for: a value
// that fails cannot sit in a package `cue vet` passes. A browser tier has none.
syncAgreed: (#syncCase & {reads: [_view], goal: {table: "goal", durability: "live", sync: "on-demand"}}).app.state.entities.Goal.sync & "on-demand"
syncTab: ((#syncCase & {reads: [_view]}).app.state.entities.Draft.sync == _|_) & true
syncEntity: (#syncCase & {reads: [_view]}).app.state.entities.Goal.sync & "on-demand"
syncEntityEager: (#syncCase & {reads: [_view & {table: "player"}]}).app.state.entities.Goal.sync & "eager"
