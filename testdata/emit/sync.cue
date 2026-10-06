// #App.#sync, each reason it gives: one small program per case, whose `goal`
// table is the one judged. Query-local completeness does not become an
// entity-wide constraint; requirements outside queries still do.
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
	route: *"/jogo/:id" | string
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
				"route": route
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
	route: *"view" | _
	clauses: *[{col: "game_id", op: "eq"}] | _
	embeds: *[] | _
	orders: *[] | _
}
_view: #view
_onDemand: {mode: "on-demand", reason: "each active query demands its own subset or complete snapshot"}

syncViews: (#syncCase & {reads: [_view, #view & {clauses: [{col: "id", op: "eq"}]}]}).out & _onDemand
syncReduce: (#syncCase & {reads: [_view, {table: "goal", kind: "reads", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]}).out & _onDemand
syncNamed: (#syncCase & {reads: [_view, #view & {kind: "named"}]}).out & _onDemand
syncWhole: (#syncCase & {reads: [#view & {route: "whole", clauses: []}]}).out & _onDemand
syncBoolean: (#syncCase & {reads: [#view & {route: "snapshot", clauses: [{col: "done", op: "true"}]}]}).out & _onDemand
syncPattern: (#syncCase & {reads: [#view & {route: "snapshot", clauses: [{col: "name", op: "ilike"}]}]}).out & _onDemand
// A cap pages with a cursor comparing the order's columns; uncapped, TanStack
// orders the rows itself.
syncCappedDomain: (#syncCase & {reads: [#view & {limit: 5, orders: ["at"]}]}).out & _onDemand
syncUncappedDomain: (#syncCase & {reads: [#view & {orders: ["at"]}]}).out & _onDemand
// Postgres picks the rows inside a cap by its collation, and the view orders
// them by the reader's locale: for free text the two differ, so the view would
// show rows an eager table does not. A uuid or a date orders alike in both.
syncCappedText: (#syncCase & {reads: [#view & {limit: 1, orders: ["name"]}]}).out & _onDemand
syncCappedSpelled: (#syncCase & {reads: [#view & {limit: 1, orders: ["on", "id"]}]}).out & _onDemand
syncUncappedText: (#syncCase & {reads: [#view & {orders: ["name"]}]}).out & _onDemand
// An int64 is a canonical string whose text order is not its value order.
syncUnsorted: (#syncCase & {reads: [#view & {orders: ["n"]}]}).out & _onDemand
syncDomainFilter: (#syncCase & {reads: [#view & {clauses: [{col: "at", op: "eq"}]}]}).out & _onDemand
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
// A server-computed list observes changes without retaining dependency rows.
syncUpdateElsewhere: (#syncCase & {reads: [_view, {table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}], writes: [{table: "goal", op: "update"}]}).out & _onDemand
syncUpdateUnviewed: (#syncCase & {reads: [_view & {table: "player"}, {table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}], writes: [{table: "goal", op: "delete"}]}).out & _onDemand
// The view of its key is one Electric must be able to compare.
syncUpdateUncomparedKey: (#syncCase & {
	reads: [#view & {table: "tick"}]
	writes: [{table: "tick", op: "update"}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#sync.Tick & {
	mode: "eager", reason: "jogo.html updates a row of it by id, which Electric cannot compare to load the row"
}
syncUpsert: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "upsert"}]}).out & _onDemand
// A form's write is read from writes alone, as the markup reader records it
// (read-markup.ts, "a form's writes").
syncDeleteFiltered: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "delete", filter: "game_id=eq.{id}"}]}).out & _onDemand
// A reduce bound to a click writes as one bound to a mutation does; the
// markup reader records both as op "reduce" (read-markup.ts, "every reduce's
// writes").
syncReduceWrites: (#syncCase & {reads: [_view], writes: [{table: "goal", op: "reduce"}]}).out & {
	_onDemand
}
// Opaque writes demand their complete table at execution, so a reducer on
// another table does not require eagerly loading this one.
syncReduceTabWrites: (#syncCase & {reads: [_view], writes: [{table: "draft", op: "reduce"}]}).out & _onDemand
syncReduceWritesElsewhere: (#syncCase & {reads: [_view, #view & {table: "player"}], writes: [{table: "player", op: "reduce"}]}).out & {
	_onDemand
}

syncReduceUncomparedKey: (#syncCase & {
	reads: [_view, {table: "tick", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]
	writes: [{table: "goal", op: "reduce"}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}]}
}).app.#sync.Tick & {mode: "eager", reason: "jogo.html writes from a reduce, and Electric cannot compare Tick's key to load a row it targets"}
syncPrivateEmbed: (#syncCase & {reads: [#view & {embeds: ["note"]}, {table: "note", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]}).out & _onDemand
// A private base stays eager; the query demands its public embed at runtime.
syncPrivateViewEmbeds: (#syncCase & {reads: [#view & {table: "note", embeds: ["goal"]}, _view]}).out & _onDemand
// The read falls to the snapshot path, which reads the embedded collection
// whole as well.
syncSnapshotEmbed: (#syncCase & {
	reads: [#view & {table: "player", route: "snapshot", clauses: [{col: "done", op: "false"}], embeds: ["goal"]}]
	writes: [{table: "goal", op: "create"}]
}).out & _onDemand
// A server read does not widen a local join's demand.
syncJoinUncomparedKey: (#syncCase & {
	reads: [#view & {embeds: ["tick"]}, {table: "tick", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#sync.Tick & _onDemand
// Nested queries demand only their own rows; identical queries share a view.
_players: #view & {table: "player", clauses: [{col: "done", op: "eq"}]}
syncListed: (#syncCase & {reads: [_players, #view & {nested: true, lists: [0]}]}).out & _onDemand
syncListedJoin: (#syncCase & {reads: [_players, #view & {table: "player", nested: true, lists: [0], clauses: [{col: "id", op: "eq"}], embeds: ["goal"]}, _view]}).out & _onDemand
syncSlotted: (#syncCase & {reads: [#view & {nested: true}]}).out & _onDemand
syncListedOne: (#syncCase & {reads: [#view & {table: "player", clauses: [{col: "id", op: "eq"}]}, #view & {nested: true, lists: [0]}]}).out & _onDemand
syncServer: (#syncCase & {reads: [{table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]}).out & _onDemand
syncUnread: (#syncCase & {reads: [#view & {table: "player"}]}).out & {mode: "eager", reason: "no screen reads it"}

// The mode is the entity's, so an authored one that agrees stands. One the
// rule contradicts fails to unify, which sync.test.ts asks cue for: a value
// that fails cannot sit in a package `cue vet` passes. A browser tier has none.
syncAgreed: (#syncCase & {reads: [_view], goal: {table: "goal", durability: "live", sync: "on-demand"}}).app.state.entities.Goal.sync & "on-demand"
syncTab: ((#syncCase & {reads: [_view]}).app.state.entities.Draft.sync == _|_) & true
syncEntity: (#syncCase & {reads: [_view]}).app.state.entities.Goal.sync & "on-demand"
syncEntityEager: (#syncCase & {reads: [_view & {table: "player"}]}).app.state.entities.Goal.sync & "eager"

syncUnorderedCap: (#syncCase & {reads: [#view & {limit: 1}]}).out & _onDemand

syncUnorderedCapEmbed: (#syncCase & {reads: [#view & {limit: 1, embeds: ["player"]}, #view & {table: "player"}]}).app.#sync.Player & _onDemand

// A broad query on another screen does not widen a filtered screen's demand.
syncAcrossScreens: (#syncCase & {
	reads: [_view]
	app: surface: screens: all: {
		title: "All goals"
		route: "/all"
		reads: [#view & {route: "whole", clauses: []}]
		writes: []
		forms: []
		states: []
	}
}).out & _onDemand

// A server result never fills the collections it watches. Preexisting rows
// must be held for their external deletion to invalidate that result.
syncServerEmbed: (#syncCase & {
	reads: [#view & {route: "server", embeds: ["player"]}, #view & {table: "player"}]
}).out & _onDemand
syncServerEmbedElsewhere: (#syncCase & {
	reads: [#view & {table: "player", route: "server", embeds: ["goal"]}, _view]
}).out & _onDemand
// The runtime also uses PostgREST when one embed has no local collection.
syncMissingEmbed: (#syncCase & {
	reads: [#view & {embeds: ["player"]}]
}).out & _onDemand
syncMissingEmbedDependency: (#syncCase & {
	reads: [#view & {table: "player", embeds: ["goal", "unregistered"]}, _view]
}).out & _onDemand

// An older projection without embed metadata cannot narrow invalidations.
syncServerOpaqueEmbed: (#syncCase & {
	reads: [{table: "player", kind: "live", nested: false, lists: [], route: "server", orders: []}, _view]
}).out & _onDemand

// Markup relations can name a foreign-key column instead of its target table.
syncServerForeignKey: (#syncCase & {
	reads: [#view & {route: "server", embeds: ["player_id"]}, #view & {table: "player"}]
}).app.#sync.Player & _onDemand
syncServerLeavesUnrelatedDemand: (#syncCase & {
	reads: [#view & {table: "note", route: "server", embeds: ["player_id"]}, #view & {table: "player"}, _view]
}).out & _onDemand

// A joined dependency is registered even when no region reads it alone.
syncEmbeddedCollection: (#syncCase & {reads: [#view & {embeds: ["player_id"]}]}).app.#collections.player & "Player"
syncRequestOnly: (#syncCase & {reads: [_view], goal: {table: "goal", durability: "server"}}).out & _onDemand

_visibilityDependencies: (#syncCase & {
	reads: [#view & {route: "server"}]
	goal: {table: "goal", durability: "live", access: {scope: "folder", parent: "Player", on: "player_id"}}
	app: state: entities: Player: access: {scope: "folder", parent: "Owner", on: "player_id"}
	more: {
		Owner: {table: "owner", durability: "server", access: {scope: "private", owner: "player_id", shared: {via: "grant", on: "game_id", user: "player_id"}}, fields: _syncFields}
		Grant: {table: "grant", durability: "server", fields: _syncFields}
	}
}).app.#collections
syncUnseenParent: _visibilityDependencies.player & "Player"
syncUnseenAncestor: _visibilityDependencies.owner & "Owner"
syncUnseenGrant: _visibilityDependencies.grant & "Grant"

// The session strip reads its name even when no screen reads that entity.
_authOnly: (#syncCase & {reads: []}).app & {
	capabilities: auth: {required: true, service: "/auth", self: {route: "jogo", name: {table: "goal", column: "name"}}}
}
syncAuthOnlyCollection: _authOnly.#collections.goal & "Goal"
syncAuthOnlyMode: _authOnly.#sync.Goal & {mode: "eager", reason: "the strip reads the signed-in person's name from it"}
