---
type: decision
title: The Ory broker as a pronto app
description: Built and live on GCP (`plugins/broker`) — Ory Hydra, Kratos, and consent run in Cloud Run beside pronto's stack at `id.bonisoft3.com` on Cloud SQL `broker-db` (PostgreSQL 18), with custom auth screens and release-time/runtime app branding.
status: built; contract in [[../identity]]
---

# The Ory broker as a pronto app

Evaluated and built `plugins/broker` as a pronto application targeting `gcp`
to replace the retired standalone deployment script (`deploy.sh`). The live
contract is maintained in [[../identity]].

## Findings

1. **Container count and CPU fit Cloud Run without `apart`.**
   Dropping `router` (pronto's `caddy` replaces it) and
   `kratos-selfservice-ui-node` (pronto's screens and `broker-ui` hatch replace
   it), keeping `capabilities.auth: {required: false, service: "/auth"}` as the
   Electric shape gatekeeper, and setting `ssr: "spa"` on all screens (omitting
   the `render` container) leaves **8 containers** in one Cloud Run revision
   (`caddy`, `crud`, `auth`, `electric` at `250m`/`256Mi`, `cloud-sql-proxy`,
   `hydra`, `kratos`, `consent`), under Cloud Run's 10-container and 8-vCPU
   limits, with `alwaysOn: true` keeping Kratos's courier active.
2. **PostgreSQL databases and sidecar secrets (`gcp/schema/gcp.cue`).**
   Sidecars reach Cloud SQL on `127.0.0.1:5432` via `cloud-sql-proxy`. Adding
   `database.extra` (`["kratos", "hydra"]`) and `sidecars.<n>.{secrets,
   dependsOn, extraPorts, healthPath, healthPort}` lets `gcp/release.nu` create
   additional databases and `<id>-<db>-dsn` Secret Manager secrets alongside
   pronto's own database.
3. **Multi-route `/.well-known/*` door hatches (`schema.cue`, `emit.cue`).**
   Extending `capabilities.hatches.<n>.door` from a single `route` to `routes`,
   admitting `/.well-known/<name>` routes, and excluding `_doorPaths` from
   `@terminal` CSP (`emit.cue`) places Hydra (`/.well-known/openid-configuration`,
   `/.well-known/jwks.json`, `/oauth2`, `/userinfo`), Kratos (`/.well-known/ory`,
   `/self-service`, `/sessions`, `/schemas`), and consent (`/start`, `/consent`,
   `/broker-api`) ahead of static `/.well-known/*` in Caddy while keeping their
   own response headers intact.
4. **Mecha footprint and Electric branding (`AppBrand`).**
   `crud`, `auth`, and `electric` are no longer idle overhead: `plugins/broker`
   stores `AppBrand` overrides in Postgres and syncs them via Electric to the
   sign-in screens.

## Visuals and app-contributed branding

- **Release-time extraction (`identity/brand.ts`, `identity/register.ts`):**
  `brand.ts` reads display name from `shell/shell.json`, sanitized `DESIGN.md`
  tokens, and same-origin favicon; `register.ts` sends `client_name` and
  optional same-origin `logo_uri` to Hydra Dynamic Client Registration (Hydra
  open DCR rejects client `metadata`), while custom palette tokens come from
  operator-managed Electric `AppBrand` rows (or `skip_consent` client metadata).
- **Trust gate and same-origin logo proxy (`consent.ts` `GET /broker-api/brand`, `GET /broker-api/logo`):**
  Reads the Hydra login/consent challenge and verifies `skip_consent` or the
  origin's `_pronto-identity` TXT record before returning brand tokens or
  allowing runtime `AppBrand` overrides. Untrusted clients receive only their
  hostname and keep the broker's neutral styling. Verified logos are proxied
  through same-origin `GET /broker-api/logo` (`x-content-type-options: nosniff`,
  `content-security-policy: sandbox`) so pronto's `img-src 'self' data: blob:`
  CSP remains strict.
- **Kratos JSON flow UI (`shell/hatches/broker-ui.js`):**
  Talks directly to same-origin Kratos public JSON APIs (`credentials:
  "include"`), keeping Ory's CSRF cookies, `ory_kratos_session`, and rate
  limits native, and handling `422` (`redirect_browser_to`) via
  `window.location.assign` so pronto's `form-action 'self'` CSP remains intact.
  DOM nodes are built strictly without `innerHTML` for Trusted Types.

## Cutover

Deployed `plugins/broker` live on 2026-11-24 via
`./plugins/sayt/sayt.sh -d ./plugins/broker release@gcp --no-gate` to Cloud Run
`ory-broker` (`id.bonisoft3.com`) backed by Cloud SQL `broker-db` (PostgreSQL
18, created via the Cloud SQL Admin REST API in `gcp/release.nu`). Re-release
staging apps (`snapcards`, `yogurt`, `truco`, `iris`) so they register fresh
branded OAuth clients in the new Hydra database (`plugins/pronto/identity/ory/deploy/deploy.sh` retired).
