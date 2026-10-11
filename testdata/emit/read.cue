// #App.#read, each reason it gives: one small program per case, whose `goal`
// table is the one judged. Query-local completeness does not become an
// entity-wide constraint; requirements outside queries still do.
package emit

import pronto "github.com/bonisoft3/pronto"

_readFields: [
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
#readCase: {
	reads: [...pronto.#Read]
	writes?: [...pronto.#Write]
	goal?: {...}
	more?: {...}
	pipelines?: {...}
	route: *"/jogo/:id" | string
	app: pronto.#App & {
		state: {
			entities: {
				Goal: [if goal != _|_ {goal}, {table: "goal", durability: "live"}][0] & {fields: _readFields}
				Player: {table: "player", durability: "live", fields: _readFields}
				Note: {table: "note", durability: "live", access: {scope: "private", owner: "player_id"}, fields: _readFields}
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
				charts: []
				forms: []
				states: []
			}
			handlers: {}
			design: {}
			flows: {}
		}
		meta: {
			name:        "read"
			description: "the read rule"
			ir: sha256: ""
			targets: []
			clocks: []
			decisions: {}
			tests: {}
		}
	}
	out: app.#read.Goal
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
_lazy: {mode: "lazy", reason: "each active query demands its own subset or complete snapshot"}

readViews: (#readCase & {reads: [_view, #view & {clauses: [{col: "id", op: "eq"}]}]}).out & _lazy
readReduce: (#readCase & {reads: [_view, {table: "goal", kind: "reads", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]}).out & _lazy
readNamed: (#readCase & {reads: [_view, #view & {kind: "named"}]}).out & _lazy
readWhole: (#readCase & {reads: [#view & {route: "whole", clauses: []}]}).out & _lazy
readBoolean: (#readCase & {reads: [#view & {route: "snapshot", clauses: [{col: "done", op: "true"}]}]}).out & _lazy
readPattern: (#readCase & {reads: [#view & {route: "snapshot", clauses: [{col: "name", op: "ilike"}]}]}).out & _lazy
// A cap pages with a cursor comparing the order's columns; uncapped, TanStack
// orders the rows itself.
readCappedDomain: (#readCase & {reads: [#view & {limit: 5, orders: ["at"]}]}).out & _lazy
readUncappedDomain: (#readCase & {reads: [#view & {orders: ["at"]}]}).out & _lazy
// Postgres picks the rows inside a cap by its collation, and the view orders
// them by the reader's locale: for free text the two differ, so the view would
// show rows an eager table does not. A uuid or a date orders alike in both.
readCappedText: (#readCase & {reads: [#view & {limit: 1, orders: ["name"]}]}).out & _lazy
readCappedSpelled: (#readCase & {reads: [#view & {limit: 1, orders: ["on", "id"]}]}).out & _lazy
readUncappedText: (#readCase & {reads: [#view & {orders: ["name"]}]}).out & _lazy
// An int64 is a canonical string whose text order is not its value order.
readUnsorted: (#readCase & {reads: [#view & {orders: ["n"]}]}).out & _lazy
readDomainFilter: (#readCase & {reads: [#view & {clauses: [{col: "at", op: "eq"}]}]}).out & _lazy
readFold: (#readCase & {
	reads: [_view]
	pipelines: tally: {from: "Goal", to: "Player", fold: {projects: "n", watermark: "w", dedupe: ["id"], pair: {table: "player"}}}
}).out & {mode: "eager", reason: "the fold tally projects the reader's own contribution from it"}
readValidationEdge: (#readCase & {
	reads: [_view]
	more: Card: {table: "card", durability: "live", fields: _readFields, validations: fair: {src: "shell/handlers/fair.js", via: ["Goal.player_id"], note: ""}}
}).out & {mode: "eager", reason: "validation Card.fair walks to it"}
readOffline: (#readCase & {reads: [_view], goal: {table: "goal", durability: "offline"}}).out & {
	mode: "eager", reason: "offline keeps the whole table on the device"
}
readPrivate: (#readCase & {reads: [_view], goal: {table: "goal", durability: "live", access: {scope: "private", owner: "player_id"}}}).out & {
	mode: "eager", reason: "Goal is private, and a view cannot restate its visibility"
}
// A server-computed list observes changes without retaining dependency rows.
readUpdateElsewhere: (#readCase & {reads: [_view, {table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}], writes: [{table: "goal", op: "update"}]}).out & _lazy
readUpdateUnviewed: (#readCase & {reads: [_view & {table: "player"}, {table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}], writes: [{table: "goal", op: "delete"}]}).out & _lazy
// The view of its key is one Electric must be able to compare.
readUpdateUncomparedKey: (#readCase & {
	reads: [#view & {table: "tick"}]
	writes: [{table: "tick", op: "update"}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#read.Tick & {
	mode: "eager", reason: "jogo.html updates a row of it by id, which Electric cannot compare to load the row"
}
readUpsert: (#readCase & {reads: [_view], writes: [{table: "goal", op: "upsert"}]}).out & _lazy
// A form's write is read from writes alone, as the markup reader records it
// (read-markup.ts, "a form's writes").
readDeleteFiltered: (#readCase & {reads: [_view], writes: [{table: "goal", op: "delete", filter: "game_id=eq.{id}"}]}).out & _lazy
// A reduce bound to a click writes as one bound to a mutation does; the
// markup reader records both as op "reduce" (read-markup.ts, "every reduce's
// writes").
readReduceWrites: (#readCase & {reads: [_view], writes: [{table: "goal", op: "reduce"}]}).out & {
	_lazy
}
// Opaque writes demand their complete table at execution, so a reducer on
// another table does not require eagerly loading this one.
readReduceTabWrites: (#readCase & {reads: [_view], writes: [{table: "draft", op: "reduce"}]}).out & _lazy
readReduceWritesElsewhere: (#readCase & {reads: [_view, #view & {table: "player"}], writes: [{table: "player", op: "reduce"}]}).out & {
	_lazy
}

readReduceUncomparedKey: (#readCase & {
	reads: [_view, {table: "tick", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]
	writes: [{table: "goal", op: "reduce"}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}]}
}).app.#read.Tick & {mode: "eager", reason: "jogo.html writes from a reduce, and Electric cannot compare Tick's key to load a row it targets"}
readPrivateEmbed: (#readCase & {reads: [#view & {embeds: ["note"]}, {table: "note", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]}).out & _lazy
// A private base stays eager; the query demands its public embed at runtime.
readPrivateViewEmbeds: (#readCase & {reads: [#view & {table: "note", embeds: ["goal"]}, _view]}).out & _lazy
// The read falls to the snapshot path, which reads the embedded collection
// whole as well.
readSnapshotEmbed: (#readCase & {
	reads: [#view & {table: "player", route: "snapshot", clauses: [{col: "done", op: "false"}], embeds: ["goal"]}]
	writes: [{table: "goal", op: "create"}]
}).out & _lazy
// A server read does not widen a local join's demand.
readJoinUncomparedKey: (#readCase & {
	reads: [#view & {embeds: ["tick"]}, {table: "tick", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]
	more: Tick: {table: "tick", durability: "live", fields: [{name: "id", type: "int64", pk: true}, {name: "game_id", type: "uuid"}]}
}).app.#read.Tick & _lazy
// Nested queries demand only their own rows; identical queries share a view.
_players: #view & {table: "player", clauses: [{col: "done", op: "eq"}]}
readListed: (#readCase & {reads: [_players, #view & {nested: true, lists: [0]}]}).out & _lazy
readListedJoin: (#readCase & {reads: [_players, #view & {table: "player", nested: true, lists: [0], clauses: [{col: "id", op: "eq"}], embeds: ["goal"]}, _view]}).out & _lazy
readSlotted: (#readCase & {reads: [#view & {nested: true}]}).out & _lazy
readListedOne: (#readCase & {reads: [#view & {table: "player", clauses: [{col: "id", op: "eq"}]}, #view & {nested: true, lists: [0]}]}).out & _lazy
readServer: (#readCase & {reads: [{table: "goal", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: []}]}).out & _lazy
readUnread: (#readCase & {reads: [#view & {table: "player"}]}).out & {mode: "eager", reason: "no screen reads it"}

// The mode is the entity's, so an authored one that agrees stands. One the
// rule contradicts fails to unify, which read.test.ts asks cue for: a value
// that fails cannot sit in a package `cue vet` passes. A browser tier has none.
readAgreed: (#readCase & {reads: [_view], goal: {table: "goal", durability: "live", read: "lazy"}}).app.state.entities.Goal.read & "lazy"
readTab: ((#readCase & {reads: [_view]}).app.state.entities.Draft.read == _|_) & true
readEntity: (#readCase & {reads: [_view]}).app.state.entities.Goal.read & "lazy"
readEntityEager: (#readCase & {reads: [_view & {table: "player"}]}).app.state.entities.Goal.read & "eager"

readUnorderedCap: (#readCase & {reads: [#view & {limit: 1}]}).out & _lazy

readUnorderedCapEmbed: (#readCase & {reads: [#view & {limit: 1, embeds: ["player"]}, #view & {table: "player"}]}).app.#read.Player & _lazy

// A broad query on another screen does not widen a filtered screen's demand.
readAcrossScreens: (#readCase & {
	reads: [_view]
	app: surface: screens: all: {
		title: "All goals"
		route: "/all"
		reads: [#view & {route: "whole", clauses: []}]
		writes: []
		charts: []
		forms: []
		states: []
	}
}).out & _lazy

// A server result never fills the collections it watches. Preexisting rows
// must be held for their external deletion to invalidate that result.
readServerEmbed: (#readCase & {
	reads: [#view & {route: "server", embeds: ["player"]}, #view & {table: "player"}]
}).out & _lazy
readServerEmbedElsewhere: (#readCase & {
	reads: [#view & {table: "player", route: "server", embeds: ["goal"]}, _view]
}).out & _lazy
// The runtime also uses PostgREST when one embed has no local collection.
readMissingEmbed: (#readCase & {
	reads: [#view & {embeds: ["player"]}]
}).out & _lazy
readMissingEmbedDependency: (#readCase & {
	reads: [#view & {table: "player", embeds: ["goal", "unregistered"]}, _view]
}).out & _lazy

// An older projection without embed metadata cannot narrow invalidations.
readServerOpaqueEmbed: (#readCase & {
	reads: [{table: "player", kind: "live", nested: false, lists: [], route: "server", orders: []}, _view]
}).out & _lazy

// Markup relations can name a foreign-key column instead of its target table.
readServerForeignKey: (#readCase & {
	reads: [#view & {route: "server", embeds: ["player_id"]}, #view & {table: "player"}]
}).app.#read.Player & _lazy
readServerLeavesUnrelatedDemand: (#readCase & {
	reads: [#view & {table: "note", route: "server", embeds: ["player_id"]}, #view & {table: "player"}, _view]
}).out & _lazy

// A joined dependency is registered even when no region reads it alone.
readEmbeddedCollection: (#readCase & {reads: [#view & {embeds: ["player_id"]}]}).app.#collections.player & "Player"
readRequestOnly: (#readCase & {reads: [_view], goal: {table: "goal", durability: "server"}}).out & _lazy

_visibilityDependencies: (#readCase & {
	reads: [#view & {route: "server"}]
	goal: {table: "goal", durability: "live", access: {scope: "folder", parent: "Player", on: "player_id"}}
	app: state: entities: Player: access: {scope: "folder", parent: "Owner", on: "player_id"}
	more: {
		Owner: {table: "owner", durability: "server", access: {scope: "private", owner: "player_id", shared: {via: "grant", on: "game_id", user: "player_id"}}, fields: _readFields}
		Grant: {table: "grant", durability: "server", fields: _readFields}
	}
}).app.#collections
readUnseenParent: _visibilityDependencies.player & "Player"
readUnseenAncestor: _visibilityDependencies.owner & "Owner"
readUnseenGrant: _visibilityDependencies.grant & "Grant"

// The session strip reads its name even when no screen reads that entity.
_authOnly: (#readCase & {reads: []}).app & {
	capabilities: auth: {required: true, service: "/auth", self: {route: "jogo", name: {table: "goal", column: "name"}}}
}
readAuthOnlyCollection: _authOnly.#collections.goal & "Goal"
readAuthOnlyMode: _authOnly.#read.Goal & {mode: "eager", reason: "the strip reads the signed-in person's name from it"}
