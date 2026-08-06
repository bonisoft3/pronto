# Keep stage 2 — frozen vocabulary deltas (time & search)

Scope contract for apps/keep stage 2. Implementation agents follow this
exactly; scope questions are settled here.

## App model additions (frozen)

Note gains fields:
- `remind_at` timestamptz nullable (`required: false`).
- `due` bool default false.
- `search` — NEW field type `tsvector`, `generated:
  "to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))"`,
  never in forms. Entity gains `indexes: [{on: "search", using: "gin"}]`.

Pipelines (both scheduled — trigger "schedule", no from/group/transform/
shim/key):
- `purge`: interval "30s", action "delete", to Note, filter
  `deleted_at=lt.{cutoff}`, window "168h" (7 days).
- `remind-due`: interval "10s", action "update", to Note, filter
  `due=is.false&remind_at=lte.{nowts}`, set `{due: true}`. (A moved-forward
  reminder does not clear `due` — stage cut, record in ir Decisions.)

Screens:
- notes-grid gains a search form: `data-form="search"
  data-action="navigate" data-target="#/search/{q}"`, single input name=q
  required, placeholder "Search notes". No entity/store involvement.
- NEW screen `search` route `/search/:q`: h1 shows `{param.q}`; region Note,
  filter `search=fts(simple).{param.q}&deleted_at=is.null`, order
  created_at.desc, same card markup as the grid (incl. nested NoteSummary);
  empty text "Nothing matches."; back link to `#/`.
- NEW screen `reminders` route `/reminders` (static → gets a nav entry,
  label "Reminders"): region Note, filter
  `remind_at=not.is.null&deleted_at=is.null`, order remind_at.asc; card
  carries `data-due="{due}"` and shows `{remind_at}` raw ISO (v0, note in
  ir Decisions); `[data-due="true"]` highlight style (amber left border).
- note-detail edit form gains field remind_at, NEW control `"datetime"`.

Acceptance additions (ids): accept-search-title (search from the grid form
navigates and finds by title), accept-search-excludes-trashed,
accept-reminder-listed, accept-due-flagged (due flips within the tick),
accept-trash-purged (a note trashed >7d ago disappears within the tick).
Storyboards: search (empty/loading/populated), reminders
(empty/loading/populated); paths + tests cover the new ids.

## Schema deltas (schema.cue)

- `#Field.type` += `"tsvector"`; `generated?: string` (SQL expr → DDL
  `GENERATED ALWAYS AS (<expr>) STORED`; generated fields emit no NOT
  NULL/DEFAULT and never appear in forms).
- `#Entity.indexes?: [...{on: string, using: *"btree" | "gin"}]` → DDL
  `CREATE INDEX IF NOT EXISTS idx_<table>_<on> ON <table> USING <using>
  (<on>);` appended after the tables in 004.
- `#Pipeline`: `trigger: *"cdc" | "schedule"`. `from`, `group`, `transform`
  become optional (`from?`, `group?`, `transform?`); cdc pipelines still set
  all three (existing apps unchanged — defaults preserve todo/keep stage-1
  byte-identity EXCEPT keep re-materializes with new content anyway; the
  TODO app must stay byte-identical: its pipeline sets every field
  explicitly, so optionality is byte-neutral there). Scheduled fields:
  `interval?: string`, `action?: "delete" | "update"`, `filter?: string`
  (PostgREST fragment; tokens `{cutoff}`, `{nowts}`), `window?: string`
  (Go duration; required when filter uses {cutoff}), `set?: {[string]:
  bool | int | string}` (PATCH body for action update). `shim` emission and
  shell.yaml `shim` field are gated on trigger == "cdc".
- `#FormField.control` += `"datetime"`.

## Emitter deltas (emit.cue)

- DDL: generated columns and index emission per above (indexes in
  004_create_tables.sql after all tables).
- Scheduled rpk yaml (derived entirely; NO .blobl assembly, NO browser
  shim): input `generate: {interval: <interval>, mapping: "root = {}"}`;
  one bloblang processor setting metadata:
  `meta cutoff = (timestamp_unix() - <windowSeconds>).ts_format("2006-01-02T15:04:05Z", "UTC")`
  and/or `meta nowts = now()` (emit only the tokens the filter uses), plus
  `root = <set-json or {}>`; output http_client verb DELETE (action
  delete) or PATCH (action update) to
  `${CRUD_URL}/<table>?<filter with {tok} → ${! meta("tok") }>`,
  Content-Type application/json on PATCH, `successful_on: [200, 204]`,
  wrapped in the same retry block as cdc sinks.
- shell.yaml pipelines entries for scheduled pipelines: {name, to,
  trigger: "schedule"} only (no from/aggregate/shim/key).
- Regression gate unchanged and mandatory: apps/todo re-materialization
  byte-identical.

## Binding deltas (interpreter)

- NEW form action `navigate`: form has `data-target` (hash template with
  `{field}` placeholders = form input values, URI-encoded); on valid
  submit, set location.hash — no store call, no success state (the
  navigation is the feedback). Invalid → normal validation-error path.
- NEW control datetime: `<input type="datetime-local">`; populate from row
  via `data-value="{remind_at}"` → slice ISO to `YYYY-MM-DDTHH:MM`; on
  submit, empty string → JSON null, else `<value>:00Z` (UTC v0 — record
  as a decision).
- No other binding changes; `data-due` reflection and fts filter
  passthrough already work.

## Out of stage 2

Clearing `due` on reminder change; local timezones; push notifications;
search snippets/highlighting; label attach (still stage 3 fodder);
wiring omnishell's Playwright visual linters into `sayt verify` (tracked,
separate task).
