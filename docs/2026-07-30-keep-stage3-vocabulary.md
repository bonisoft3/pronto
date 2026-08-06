# Keep stage 3 — frozen vocabulary deltas (multi-user: auth, RLS, sharing)

Scope contract for apps/keep stage 3. Every cross-component interface is
frozen here; agents implement, they do not redesign.

## Identity & tokens (fixed contract)

- JWT: HS256, claims `{role, sub, handle, exp}`. Secret: env
  `PGRST_JWT_SECRET`, dev default `pronto-dev-secret-please-override-32ch`.
  User tokens: role `app_user`, sub = app_user.id, exp 7d.
- Service token: role `service`, sub `00000000-0000-0000-0000-000000000000`,
  exp 2033-01-01 — pre-signed against the dev secret ONCE (deno one-liner)
  and emitted as compose env default `SERVICE_JWT` for the transform
  service; prod overrides both envs. Record as a decision.
- SQL helper (emitted in 000): `CREATE OR REPLACE FUNCTION auth_uid()
  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(
  'request.jwt.claims', true)::json->>'sub','')::uuid $$;`

## Auth service (mecha component)

New cluster service `auth` at `libraries/mecha/services/auth/`:
Deno (pinned 2.3.7) HTTP server, deps pinned via npm:@simplewebauthn/server
(latest 10.x pin) + npm:postgres (or jsr equivalents), Dockerfile
(denoland/deno pinned digest). Self-migrates at boot:
`CREATE TABLE IF NOT EXISTS webauthn_credential (id text primary key,
user_id uuid not null references app_user(id) on delete cascade,
public_key bytea not null, counter bigint not null default 0)` (app_user is
a program entity and exists first — auth depends_on database healthy).
Endpoints (JSON; all under /auth, Caddy strips nothing — service mounts
paths WITH the /auth prefix):
- POST /auth/register/start {handle} → WebAuthn creation options;
  challenge is carried in a short-lived signed JWT returned as `state`
  (stateless server).
- POST /auth/register/verify {state, response} → creates app_user(handle)
  + credential; 409 if handle taken → {token, user: {id, handle}}.
- POST /auth/login/start {handle} → request options + `state`.
- POST /auth/login/verify {state, response} → {token, user}.
- GET /auth/whoami (Bearer) → {id, handle} or 401.
RP config: rpID env WEBAUTHN_RP_ID default "localhost", origin env
WEBAUTHN_ORIGIN default "http://localhost:8080" (compose passes
`http://localhost:${CADDY_HOST_PORT:-8080}`).
Cluster wiring (libraries/mecha/cluster.cue): service `auth` (build
context "\(mechaPath)/services/auth"), env DATABASE_URL + PGRST_JWT_SECRET
+ WEBAUTHN_*, depends_on database healthy; caddy route
`handle /auth/* { reverse_proxy auth:9999 }`; crud service gains
`PGRST_JWT_SECRET`; transform env gains `SERVICE_JWT` default (frozen
above) and rpk requests carry `Authorization: Bearer ${SERVICE_JWT}`.

## Access model (schema + emitter)

- `#Entity.access?:` one of:
  - `{mode: "owned", owner: string, shared?: {via: string, on: string,
    user: string}}` — RLS: ENABLE; TO app_user: SELECT/UPDATE/DELETE
    USING (owner = auth_uid() [OR EXISTS shared-row]), INSERT WITH CHECK
    (owner = auth_uid()); TO service: ALL USING (true) WITH CHECK (true).
  - `{mode: "through", parent: string, on: string}` — TO app_user ALL
    USING/CHECK EXISTS (SELECT 1 FROM <parent.table> p WHERE p.id = <on>
    AND (<parent's owned USING inlined, single level>)); service ALL true.
  - `{mode: "public-read"}` — TO app_user SELECT USING true; service ALL.
  - `{mode: "service-only"}` — service ALL only.
  Entities WITHOUT access: no RLS (pre-stage-3 behavior).
- Policies land in a new emitted migration
  `services/database/migrations/005_policies.sql`. 002_grants.sql v2:
  anon keeps USAGE only (zero table grants); app_user + service get
  SELECT/INSERT/UPDATE/DELETE on all tables; roles migration creates
  app_user + service NOLOGIN.
- `#App.auth?: {required: bool, service: string}` → shell.yaml `auth:`
  block verbatim.
- `#App.rawMigrations?: [...{name: string, src: string}]` — hand-authored
  complex SQL as ASSEMBLY files (src entries; writer copies into
  services/database/migrations/<name>). Stage-3 use: the share trigger.

## Keep model additions

- Entity `AppUser` (table app_user): id uuid pk (NO default — auth service
  supplies), handle text required unique, created_at default now().
  access: public-read. Never in forms.
- Note gains `owner_id` uuid `ref: "app_user"`, `default: "auth_uid()"`,
  required. access: {mode: owned, owner: "owner_id", shared: {via:
  "note_collaborator", on: "note_id", user: "user_id"}}.
- NoteItem/NoteLabel: access {mode: through, parent: "Note", on:
  "note_id"}. Label gains owner_id (default auth_uid(), ref app_user) and
  access owned (no shared). NoteSummary: access {mode: through, parent:
  "Note", on: "note_id"} for reads; writes arrive as service anyway.
- Entity `NoteCollaborator` (table note_collaborator): id uuid pk, note_id
  ref note, user_id uuid ref app_user (`required: false` — trigger fills),
  handle text required. access: {mode: through, parent: "Note", on:
  "note_id"} (only the note's owner/collaborators manage sharing; owner-
  only is a stage cut, record it).
- rawMigrations: [{name: "010_share_trigger.sql", src:
  "services/database/sql/010_share_trigger.sql"}] — assembly SQL: BEFORE
  INSERT trigger on note_collaborator resolving handle → user_id from
  app_user (RAISE EXCEPTION 'unknown handle %' when absent) SECURITY
  DEFINER so the lookup crosses RLS.
- note-detail gains a share form: input name=handle (+ hidden note_id
  {param.id}) creating NoteCollaborator; collaborator chips region lists
  {handle} with detach form.
- Acceptance additions: accept-register, accept-private (a second user
  sees none of the first user's notes), accept-share-grants (shared note
  appears for the collaborator), accept-unknown-handle-refused,
  accept-signout.

## Terminal (login is chrome, not app assembly)

- shell.yaml `auth: {required: true, service: "/auth"}` → createShell:
  when required and no token in sessionStorage("pronto-token"), render the
  terminal-owned login screen (handle input; Sign in / Create account
  buttons) driving the WebAuthn ceremony via navigator.credentials against
  the service endpoints (base64url helpers inline); on success store
  {token, user} and proceed to routes. Nav chrome gains "<handle> · sign
  out" (clears storage, reloads). data-crud store sends Authorization:
  Bearer when a token exists; any 401 clears the session and re-renders
  login (session expiry, not a fallback).
- Storybook and ?tier=browser: bypass auth entirely (fixture/PGlite tiers
  have no cluster; state this in the module comment).

## QA notes (driver, post-workflow)

Two-user flows via CDP WebAuthn virtual authenticator if browse's cdp
allowlist permits WebAuthn.*; otherwise fall back to two isolated browser
profiles + real ceremony is impossible headless — then QA drives the auth
service HTTP contract directly (register/login verify with
@simplewebauthn/server's own test vectors is NOT feasible by hand; instead
the auth service ships a deno unit test exercising start/verify round-trip
with simplewebauthn's testing helpers, and browser QA covers everything
past token issuance by injecting a legitimately-issued token into
sessionStorage via the /auth endpoints called from page context).

## Out of stage 3

Email/social login, credential management UI, multi-device passkey sync
notes, Electric shape auth, collaborator write-permission tiers,
owner-only share management, browser-tier auth.
