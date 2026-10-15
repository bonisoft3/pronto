package pronto

// A drain has no interval: it is woken only by its start and its tables,
// which is what keeps an idle stack from calling it.
_drainIdle: (#rpkDrain & {
	d: {name: "team-profiles", on: ["team_profile_dirty"], call: "refresh_team_profiles", body: batch_size: 50}
	app: "golaberto"
}).out

_drainIdle: input: broker: inputs: [
	{redis_streams: consumer_group: "golaberto-team-profiles"},
	{generate: {count: 1, interval: ""}},
]
_drainIdle: pipeline: processors: [{mapping: """
	let row = this.catch({})
	let table = $row.data.or("").parse_json().catch({}).__table.or("")
	root = if $row.exists("wake") || ["team_profile_dirty"].contains($table) { {"body": {"batch_size":50}, "trace": @traceparent.or("")} } else { deleted() }
	"""}]
_drainIdle: output: http_client: {
	url: "${CRUD_URL}/rpc/refresh_team_profiles"
	headers: {"Content-Type": "application/json"}
}

// Auth'd clusters put every table behind RLS, so the call carries the
// service token.
_drainAuthed: (#rpkDrain & {
	d: {name: "recent", on: ["championship", "day_tick"], call: "refresh_recent"}
	app:    "golaberto"
	authOn: true
}).out

_drainAuthed: output: http_client: headers: Authorization: "Bearer ${SERVICE_JWT}"

_drainIdle: pipeline: threads: 1
_drainIdle: output: http_client: {
	max_in_flight: 1
	batching: {
		period: "1s"
		processors: [{archive: format: "json_array"}, {resource: "cdc_trace_batch"}, {mapping: "root = this.index(0).body"}]
	}
}
