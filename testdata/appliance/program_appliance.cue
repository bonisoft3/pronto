package APP

import bayt "github.com/bonisoft3/bayt/core:bayt"

// The docker appliance's integration fixture: a row that moves through an
// effect answered by an embedded bridge, and a drain that counts the answers.
code: state: entities: Ping: {
	id:         "0xa1b2c3d4e5f60718"
	table:      "ping"
	durability: "server"
	access: scope: "internal"
	fields: [
		{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
		{ordinal: 2, name: "status", type: "string"},
		{ordinal: 3, name: "answer", type: "string", required: false},
	]
}
code: state: mecha: rows: PingMachine: {
	name:    "PingMachine"
	entity:  "Ping"
	field:   "status"
	initial: "pending"
	states: {
		pending: on: send: "sending"
		sending: invoke: {
			src: "ping"
			onDone: {target: "answered", actions: [{assign: {answer: {raw: "outcome->'data'->>'answer'"}}}]}
			onError: "failed"
		}
		answered: type: "final"
		failed: type:   "final"
	}
}
code: state: effects: ping: {
	input: {id: "NEW.id"}
	sink: {bridge: "pingstub", idempotent: false}
	reentry: "repeat"
	note:    "the stub answers every call the same, so a repeated call is harmless"
}
code: state: bridges: pingstub: {
	container: "pingstub"
	port:      8090
	targets: ["docker"]
	appliance: {
		srcs: ["/usr/local/bin/ping-stub.ts"]
		command: ["airlock-deno", "run", "--allow-net=127.0.0.1:8091", "/usr/local/bin/ping-stub.ts"]
		port: 8091
	}
}
code: capabilities: hatches: pingstub: {kind: "container", note: "answers the ping effect"}
cluster: surface: targets: pingstub: {
	activate: ""
	cmd: "builtin": null
	srcs: globs: ["ping-stub.ts"]
	dockerfile: {
		from: name: bayt.lock.images.deno_bin
		copy: [{srcs: ["ping-stub.ts"], dst: "/usr/local/bin/ping-stub.ts"}]
		cmd: ["/deno", "run", "--allow-net=0.0.0.0:8090", "/usr/local/bin/ping-stub.ts"]
	}
}
// The drain's function arrives by a forward migration, so the drain running
// shows the appliance applied the program's pgroll set.
code: state: migrations: "040_ping_count": operations: [{sql: {onComplete: true, up: """
	CREATE TABLE IF NOT EXISTS ping_count (id int PRIMARY KEY, answered bigint NOT NULL);
	CREATE OR REPLACE FUNCTION count_pings() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
	  INSERT INTO ping_count VALUES (1, (SELECT count(*) FROM ping WHERE status = 'answered'))
	  ON CONFLICT (id) DO UPDATE SET answered = EXCLUDED.answered WHERE ping_count.answered IS DISTINCT FROM EXCLUDED.answered;
	$$;
	GRANT EXECUTE ON FUNCTION count_pings() TO service;
	"""}}]
code: state: drains: "ping-count": {on: ["ping"], call: "count_pings"}
code: state: steps: {
	graphile: "030"
	airlock:  "031"
	machines: "032"
	note:     "The raw steps 011 to 025 write no ping row: pings exist only once the fixture inserts them."
}
code: meta: clocks: ["docker", "cloudflare"]
// A database function, so the appliance shows it runs Jessie as `plv8`.
code: state: functions: echo: {rules: "rules/echo.js", fuel: 1000, note: "the appliance's plv8 runs it"}
