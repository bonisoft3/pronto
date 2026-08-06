# Keep stage 4 — frozen vocabulary deltas (blobs, first escape hatch, first island)

The stage exists to exercise three built-but-untested doctrines: mecha's
blobs profile, the escape-hatch story, and Jessie islands under SES. Agents
implement exactly this.

## Blobs (mecha capability, like auth)

- `#Cluster.blobs: *false | bool` — when true: `rclone-s3` service (mecha's
  services/rclone-s3 Dockerfile, command serve s3 on :3900, env
  RCLONE_LOCAL_BUCKET=mecha-objects, no auth keys — dev posture) and
  `imgproxy` (ghcr.io/imgproxy/imgproxy:v3.31.1 pinned by the digest
  snapcards uses, IMGPROXY_USE_S3, dummy AWS creds, endpoint rclone-s3:3900,
  bind :8081, IMGPROXY_ALLOW_INSECURE-style dev config per snapcards) +
  caddy routes: `handle /blobs/*` → rclone-s3:3900 (strip /blobs) and
  `handle /img/*` → imgproxy:8081 (strip /img). Launch gate gains both when
  enabled. `#App.blobs: *false | bool` → cluster flag via #emit.
- Upload path (terminal): NEW form control `"file"`. On submit, the shell
  PUTs the file to `/blobs/mecha-objects/<crypto.randomUUID()><ext>` (ext
  from the file name), then submits the form's entity create with hidden
  `object_key` = that key. Grammar: `<input type="file" name="object_key"
  data-upload>`; the file input's own name receives the RESULT key string.
  Render: `<img>` src via attribute interpolation, e.g.
  `src="/img/insecure/rs:fit:480:480/plain/s3://mecha-objects/{object_key}"`
  (imgproxy insecure dev URL form — confirm exact path shape against
  snapcards/imgproxy docs and record it).

## Keep model additions

- Entity `NoteAttachment` (table note_attachment): id uuid pk default
  gen_random_uuid(), note_id uuid ref note required, object_key text
  required, ocr_text text `required: false`, created_at now(). access:
  through Note on note_id. Conduit CDC picks it up automatically (crud
  path).
- note-detail: attachments region (cards: img via imgproxy + ocr_text
  paragraph when present) + upload form (file control + hidden note_id
  {param.id}); delete form per attachment.
- Search: unchanged (notes only) — record as decision-ocr-search-cut.
- Acceptance additions: accept-attach-image, accept-ocr-text (text from an
  attached image appears within a tick), accept-reorder (dragging an item
  persists a new order), accept-attachment-private (B cannot read A's
  attachment rows).

## The escape hatch (OCR container)

- App-owned service at apps/keep/services/ocr/: Dockerfile (alpine pinned +
  tesseract-ocr + tiny HTTP wrapper — Python3 stdlib http.server or Deno,
  pick one, pin base by digest) exposing POST /ocr {url} → the service
  fetches the object (internal http://rclone-s3:3900/mecha-objects/<key>),
  runs tesseract, returns {text}. Port 8088. No external network, no API
  key.
- Hatch placement doctrine AMENDMENT (record in SPEC): hatches compiled
  from the ir land in program.cue's cluster unification — `cluster:
  services: ocr: {...}` + launch-gate dep — because they are program
  output; the emitted bayt.cue redeclaration stays trivial and remains the
  OUT-OF-BAND (human) override seam. ir's Decisions: escape-hatches entry
  now LISTS the hatch (kind container, box id `ocr-hatch`); a new section
  `<section id="ocr-hatch" data-kind="hatch">` describes the contract
  (POST /ocr {url}→{text}, failure → ocr_text stays null, retry rides the
  pipeline). Bijection: kind `hatch` maps to a program `hatches` entry.
- `#App.hatches: [Name=string]: {ir: *Name | string, kind: "container",
  note: string}` — bijection surface only; the actual service definition
  is the cluster unification beside it.

## Raw pipelines (complex pipelines are assembly)

- `#Pipeline` gains variant `raw: true` + `src` (assembly rpk YAML under
  pipelines/, emitted as a src copy to docker/<app>-<name>.yaml and
  included in the transform command; lint rule includes it). No
  aggregate/bloblang/key for raw. Keep's `ocr` pipeline is raw:
  input redis_streams (group keep-ocr), jq filter: table note_attachment,
  insert events with ocr_text null (loop prevention: updates that set
  ocr_text do not match), branch: POST http://ocr:8088/ocr with
  {url: "http://rclone-s3:3900/mecha-objects/" + object_key} → PATCH
  ${CRUD_URL}/note_attachment?id=eq.<id> body {ocr_text} with SERVICE_JWT
  auth headers, retry wrapper, successful_on [200,204].

## Islands (first Jessie island under SES)

- Island files: assembly at shell/islands/<name>.js. Contract: the module
  source evaluates in an SES Compartment (ses pinned from jsdelivr, umd,
  SRI; lockdown() once per page) with NO endowments; it must define
  `export`-free plain `const reduce = (state, event) => result` captured
  via the compartment's completion value: FROZEN MECHANISM — the file's
  last expression must be the reduce function; the loader evaluates the
  source and uses the completion value. (Jessie-friendly, no module
  machinery inside the compartment.)
- Vocabulary: region attr `data-island="<name>"` (name resolves to
  shell/islands/<name>.js via route files.islands list — shell.yaml already
  carries islands paths; the loader matches by basename minus .js).
  For stage 4 the only event source is drag reorder: when a region has
  data-island and its item template carries `data-drag-handle` somewhere,
  the shell makes items draggable and translates DOM drag events into
  island events `{type: "move", fromId, toId}` with state
  `{items: [{id, position}]}` (from the region's last rows, in DOM order).
  The island returns `{updates: [{id, patch: {...}}]}`; the shell applies
  each as an update mutation. Islands never see the DOM, the store, or the
  clock.
- Keep's island `reorder-items`: computes midpoint-free integer
  renumbering (positions 10, 20, 30… rewritten on every move — simple and
  deterministic). note_item.position drives data-order position.asc
  (already). Items region gains data-island + handles.
- ir: `<section id="reorder-items" data-kind="island">` with the
  state/event/result contract and PURE test paragraphs (data-kind="test",
  data-of="reorder-items") — e.g. given three items moving first→last
  yields updates renumbering to 10,20,30 order b,c,a. Program: 
  `#App.islands: [Name=string]: {ir: *Name | string, of: string, src:
  string, note: string}`; bijection kind `island` ↔ islands entries.
  #Screen.files.islands lists the src path (existing plumbing).
- Lint: new pronto script plugins/pronto/check-islands.ts (deno): for each
  island file — denylist identifiers (window, document, fetch,
  XMLHttpRequest, WebSocket, eval, Function, globalThis, import, require,
  Date, Math.random), must end in an arrow-function expression. Wired into
  emitted .say.yaml lint rulemap (rule "islands") only when the app has
  islands. Documented as a stub for the real Jessie grammar gate.
- Storybook: islands are NOT loaded (fixture tier); drag is inert there.
  The earlier interpreter guard that THROWS on islands must be replaced by
  the real loader (cluster tier) and a quiet skip (storybook).

## QA notes (driver)

Upload: page-context fetch PUT with a generated PNG (screenshot of a text
heading rendered by the browser makes a legible tesseract target). OCR:
poll note_attachment.ocr_text until the tick lands. Reorder: synthesize
drag via pointer events or drive the island contract through the store
(DOM drag in headless is flaky — acceptable to QA the island by direct
reduce() invocation in page context plus one best-effort DOM drag).

## Out of stage 4

Real blob ACLs (keys are unguessable uuids — decision), attachment counts
in search, image thumbnails in grid cards, bifrost/AI OCR, island grammar
enforcement beyond the denylist stub, wasm escape hatches.
