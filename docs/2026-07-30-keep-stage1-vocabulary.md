# Keep stage 1 — frozen vocabulary deltas

Scope contract for apps/keep stage 1 (relational core). Implementation agents
follow this exactly; scope questions are settled here, not re-opened.

## App model (frozen)

Entities (PascalCase ids, snake tables):
- `Note` — id uuid pk, title text (may be blank: `required: false`, cel
  `this.size() <= 200`), body text (`required: false`), color text (default
  `'default'`, cel `this in ['default','red','yellow','green','blue']`, sql
  check `color IN (...)`), pinned bool default false, archived bool default
  false, deleted_at timestamptz nullable (null = live; set = trashed),
  created_at timestamptz default now(). Path crud.
- `NoteItem` — id uuid pk, note_id uuid `ref: "note"`, text text required,
  done bool default false, position int default 0. Path crud.
- `Label` — id uuid pk, name text required unique. Path crud.
- `NoteLabel` — id uuid pk, note_id uuid ref note, label_id uuid ref label.
  Path crud. (unique pair deferred; not stage 1.)
- `NoteSummary` — note_id text pk (uuid as text ok), done_count int >= 0,
  total_count int >= 0, invariant done_count <= total_count. Path live,
  writers pipeline. NO seed (rows appear per note via pipeline; the grid
  nested region tolerates absence — see bindings).

Pipeline `item-recount`: from NoteItem to NoteSummary, group
"keep-item-recount", `key: "note_id"` (keyed aggregate), aggregate
`select=note_id,done`, bloblang groups rows by note_id emitting an ARRAY of
`{note_id, done_count, total_count}` sink rows.

Screens:
- `notes-grid` route `/`: regions — labels list (Label, order name.asc;
  cards link `#/label/{name}`), pinned notes (Note,
  filter `pinned=is.true&archived=is.false&deleted_at=is.null`, order
  created_at.desc), other notes (same but pinned=is.false), each note card
  links `#/note/{id}`, shows title/body/color + nested singleton region
  (NoteSummary, filter `note_id=eq.{id}`) rendering "{done_count} /
  {total_count}"; new-note form (create Note: title text control).
- `label-notes` route `/label/:name`: notes filtered by label. STAGE CUT:
  PostgREST can't filter by joined label name without embed gymnastics —
  use filter on embedded resource: reads Note with
  `select=*,note_label!inner(label!inner(name))` and filter
  `note_label.label.name=eq.{param.name}&deleted_at=is.null`. If the ir/
  program author judges this too fragile, fall back to: route exists, region
  reads NoteLabel with select `*,note(*),label!inner(name)` filter
  `label.name=eq.{param.name}` and renders `{note.title}` via dot paths.
  Either is acceptable; pick ONE and state it in ir Decisions.
- `note-detail` route `/note/:id`: note singleton region (Note, filter
  `id=eq.{param.id}`); edit form (update Note: title text, body textarea,
  color select options from the color list, pinned checkbox, archived
  checkbox) with hidden row binding; items region (NoteItem, filter
  `note_id=eq.{param.id}`, order position.asc) with toggle/delete forms per
  item; add-item form (create NoteItem: text + hidden note_id
  `value: "{param.id}"`); attached-labels region (NoteLabel, filter
  `note_id=eq.{param.id}`, select `*,label(name)`) with detach (delete)
  form per chip and attach form (create NoteLabel: hidden note_id from
  param + label_id select — options static cut: use a text input for label
  id is NOT acceptable; instead attach form uses select populated…
  data-driven selects are NOT in stage 1: CUT attach-by-select, attach flow
  = create Label by name then create NoteLabel is too much — FINAL CUT:
  labels attach/detach in detail is detach-only + "new label" form creating
  Label + NoteLabel via two forms is out; ship detach-only chips plus a
  global "new label" form on the grid. State the cut in ir Decisions.)
- `archive` route `/archive`: Note filter
  `archived=is.true&deleted_at=is.null`, unarchive form (update archived
  false via hidden), trash form (update deleted_at — CUT: setting
  timestamps from forms needs server time; instead trash = update with
  hidden `deleted_at` value `now` is NOT expressible; FINAL: trash uses a
  dedicated bool? NO — keep deleted_at but the trash mutation sets it via
  hidden value "{now}" resolved by the shell clock (injected time doctrine:
  the shell owns the clock). Add binding `{now}` = ISO timestamp at submit.)
- `trash` route `/trash`: Note filter `deleted_at=not.is.null`, restore
  form (update deleted_at null via hidden value `null` → typed null), and
  delete-forever form (delete).

Storyboards: modest — grid: empty/loading/populated; others:
loading/populated (+empty where sensible). Paths cover: create note appears,
pin moves section, archive removes from grid, trash/restore round trip,
item toggle updates summary. Acceptance ids accordingly (8-12 checks).

## Schema deltas (schema.cue)

- `#Field`: `ref?: string` (table name → DDL `REFERENCES <ref>(id) ON
  DELETE CASCADE`), `unique?: bool` (DDL UNIQUE).
- `#Screen` reads entries: `{entity, order?, filter?, select?}` — filter and
  select are PostgREST fragments; `{param.<name>}` placeholders allowed.
- Routes may contain one `:param` segment.
- `#FormField.control` adds `"textarea" | "select" | "hidden"`;
  `options?: [...string]` (select), `value?: string` (hidden; placeholders
  `{param.x}`, `{now}`, `null` literal means SQL NULL).
- `#Pipeline`: `key?: string`. When set: transform output is an array of
  sink rows; sink upsert uses `on_conflict=<sink pk>`; shim returns array.

## Binding deltas (interpreter)

- `[data-live]` gains `data-filter` and `data-select` (PostgREST fragments,
  appended to the query string). Placeholder resolution in filters:
  `{param.x}` from route params; inside a template item, bare `{field}`
  from the parent row.
- Nested `[data-live]` inside `template[data-item]`: hydrated per item
  clone with parent-row placeholder context; singleton nested regions
  tolerate zero rows by rendering data-empty text or "0 / 0" via
  `data-empty-row` (JSON attr of fallback row) — chosen mechanism:
  `data-empty-row='{"done_count":0,"total_count":0}'`.
- Interpolation supports dot paths `{label.name}` (embedded objects).
- Router: pattern segments `:name` match one segment; params exposed to
  filters, hidden values, and `{param.x}` interpolation anywhere in the
  screen.
- Controls: textarea (value), select (options → value), hidden (data-value
  resolved at submit; `null` → JSON null; `{now}` → new Date().toISOString()).
- Forms-only mutations doctrine unchanged.

## Emitter deltas (emit.cue)

- DDL: ref/unique columns; note FK ordering — parents before children in
  the entity DDL emission (Note before NoteItem etc.); simplest: emit
  tables in dependency order via `ref` topology or hand order by making
  #App.entities iteration stable and keep authors ordering entities
  correctly (document: entities must be declared parents-first; lint later).
- Keyed pipeline rpk yaml: same absolute re-read; bloblang produces array;
  http_client sink `?on_conflict=<pk>` with `Prefer:
  resolution=merge-duplicates` posting the array.
- shell.yaml: routes carry the raw route pattern; reads carry
  filter/select verbatim. No other shape changes.

## Out of stage 1 (do not implement)

Search/FTS, scheduled pipelines, auth/RLS, blobs, drag reorder, islands,
data-driven selects, browser (PGlite) tier for keep — `tiers:
["container"]` only; the browser shim files are still emitted per pipeline
convention but untested.
