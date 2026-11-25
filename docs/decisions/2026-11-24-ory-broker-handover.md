---
type: handover
title: The Ory broker — handover
description: Where the sign-in broker work stands on 2026-11-24, for the agent picking it up; delete once its open items are done or moved.
status: live
---

# The Ory broker — handover

The design and its reasons are [[2026-11-24-ory-broker]]; this page is only
where the work stands and what is next. PR #2536 (`feat/ory-broker`) carries
all of it; nothing of it is merged.

## Running now

- **id.bonisoft3.com is the `plugins/broker` pronto app** (deployed 2026-11-24 via
  `sayt.sh release@gcp --no-gate`): Cloud Run `ory-broker`, project
  `bonisoft3`, us-central1, one instance of eight containers (`caddy`, `crud`,
  `auth`, `electric`, `cloud-sql-proxy`, `hydra`, `kratos`, and `consent`).
  Cloud SQL `broker-db` (Postgres 18, `db-f1-micro`).
- **Mail** goes as `sign-in@id.bonisoft3.com` through Cloudflare Email
  Sending, with snapcards staging's `MAIL_API_TOKEN` (the operator's choice);
  `auth.bonisoft3.com` was onboarded too by mistake and is unused.
- **Google** signs in through Kratos with the hand-written broker's client
  (`189132819333-koejjf6…`); its console lists both callbacks, the old
  `/callback/google` and Kratos's `/self-service/methods/oidc/callback/google`.
- **Staging apps to re-release**: `snapcards.bonisoft3.com`,
  `yogurt.bonisoft3.com`, `truco.bonisoft3.com`, and `iris.bonisoft3.com` need
  re-releasing so their releases register fresh OAuth clients (with
  release-time branding) in `broker-db`'s new Hydra database.

## How to change it

Edit `plugins/broker` (or shared `identity/ory/{consent,start}.ts` ->
`deno bundle` -> `plugins/broker/ory/consent.mjs`), lint, and release via
`release@gcp`:

```sh
cd plugins/broker
../../plugins/sayt/sayt.sh lint
../../plugins/sayt/sayt.sh release@gcp --no-gate
```

Local: `docker compose -f plugins/pronto/identity/ory/compose.yaml up -d
--wait`; the `signin` rule in `plugins/pronto/.say.yaml` runs every test.

## Decided by the operator

- Apps register their own client at release (Dynamic Client Registration,
  `identity/register.ts`, run by the edge, k8s and gcp releases), not a
  broker-side list; the `_pronto-identity` TXT record decides which are told
  the address. Apps on GKE and k8s will sign in through it.
- The broker's name stays `id.bonisoft3.com`.
- Facebook is an extra behind the app's one "more ways" entry (`email`),
  never a button of its own: snapcards, yogurt and truco; not realworld (its
  iOS app would then owe Sign in with Apple), apexrun or doom; iris only if
  the operator asks.
- The broker may become a pronto app of its own (`plugins/broker`) — see
  below.

## Next

1. **Done (staging sign-in verified).** The 2026-11-24 12:26 UTC
   `{"error":"request timed out"}` was Hydra generating `hydra.jwt.access-token`
   on its first `GET /.well-known/jwks.json` (6.00s on 0.5 vCPU vs `jose`'s 5s
   default `timeoutDuration`); `oidc.ts` sets `JWKS_TIMEOUT_MS = 30_000`. Both Google and emailed-code
   sign-in passed on `snapcards.bonisoft3.com`.
2. **Done (`plugins/broker` live at `id.bonisoft3.com`)**
   ([[../archive/2026-11-24-broker-as-pronto-app]]). Deployed `plugins/broker` to Cloud Run
   (`ory-broker` on Cloud SQL `broker-db`, PostgreSQL 18, 8 containers),
   warmed `/.well-known/jwks.json`, and verified `/health`,
   `/.well-known/openid-configuration`, and `/login` (HTTP 200).
   Re-release staging apps (`snapcards`, `yogurt`, `truco`, `iris`) so they
   register fresh branded OAuth clients in the new Hydra DB, then test sign-in.
3. **Facebook** in Kratos (a Meta app; its mapper keeps an address only when
   verified, which Meta does not always say), then rename the app's entry to
   "More ways to sign in".
4. **Passwords and address changes** stay off until a flow proves the
   address first (the decision record says why).
5. Merge #2536; snapcards.fun (production) is not re-released and keeps its
   older build.

## Traps

- Hydra's issuer is `https://id.bonisoft3.com`, no slash: discovery is
  compared exactly and the apps name it so.
- Hydra serves registration but advertises it only through
  `webfinger.oidc_discovery.client_registration_url`; a release finds it by
  discovery, so without it apps silently keep `client: origin`.
- Hydra refuses, only at sign-in, a pairwise client with several callbacks
  and no sector document: a release registers a client per provider.
- A person whose address has an account by a code, signing in by Google
  with it, is asked by Kratos to sign in by the code first to link them.
- Kratos calls its courier template as `function(ctx)`, not with an external
  variable; Kratos's log level is spelled `warning`, Hydra's `warn`.
- Deno grants a TXT lookup only with unscoped `--allow-net`.
- A local release leaves an unpushed tag on HEAD: delete it, never push it
  (snapcards' tags trip CD's propagate-tag).
- Regenerate apps with the tree's `plugins/sayt/sayt.sh generate`; Homebrew's
  `sayt` predates CUE 0.18 and fails.
- The auto-mode classifier refuses outward-facing steps (Cloudflare
  activations, the domain cutover); the operator runs those.
