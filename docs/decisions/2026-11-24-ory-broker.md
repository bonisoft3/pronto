---
type: decision
title: The Ory broker
description: Built and live at id.bonisoft3.com — the long tail of ways in (email codes, recovery, social providers beyond an app's own Google, passwords once added safely) lives in plugins/broker (Ory Hydra, Kratos, and consent behind Caddy), which every app signs in through as an ordinary OpenID Connect provider.
status: built
---

# The Ory broker

An app's own auth service signs a person in with a passkey, as a guest, through
Google by its own client, or through Bluesky ([[../identity|identity]]). Everything
else a person may want to sign in with needs state no app should keep: addresses
to mail codes to, password hashes and their recovery, a provider console per
social login, attempt and send limits. One broker holds all of it, and an app
reaches it as one more OpenID Connect provider, `email`, through mecha's generic
client — no code of the broker runs in the app, and none of the app's in the
broker.

## The pieces

Ory's, unmodified, at one version (v26.2.0), each from its own release image
pinned by digest (`identity/ory/compose.yaml`), but for one step of the
broker's own. The UI is given no Hydra admin address, which would turn on its
own consent route beside the broker's:

| Piece | Holds | Why this one |
|---|---|---|
| **Kratos** | people (`identity.schema.json`: an address and a name) and their ways in | the flows, rate limits, recovery and courier are what a hand-written broker would have to grow |
| **Hydra** | the OpenID Connect provider apps sign in through: clients, codes, keys | certified; Kratos accepts Hydra's login challenge itself (`oauth2_provider`) |
| **Ory's self-service UI** | the pages a person sees | the reference UI; restyled later by configuration, never forked |
| **The consent step** (`consent.ts`) | nothing: it answers Hydra's consent | the UI's names the person from the browser's current Kratos session, not the identity the login was accepted for, so a reader switching accounts mid-flow could carry another's address into an app; this one reads the claims from that identity through Kratos's admin API, and refuses a client not registered as first-party |
| **PostgreSQL** | one database each for Kratos and Hydra | both need SQL; neither has a stateless mode |

The alternatives were weighed in the sprint plan: Dex keeps state too, advertises
only public subjects and registers no clients dynamically; the proxy group
(Pomerium, oauth2-proxy, Vouch) gates an app but issues no tokens; the
hand-written broker (`identity/broker/main.ts`) is stateless only because it
does none of the above.

## The contract

- **An app registers itself**, as the hand-written broker needed no word of
  an app beforehand. Each release registers a client of its own by OpenID
  Connect Dynamic Client Registration (`identity/register.ts`, which the
  edge, k8s and gcp releases run), public
  (PKCE, no secret) and pairwise, with the callback of every provider
  signing in through the broker, and puts its id in the Worker's settings.
  The release finds the broker registers clients by its discovery document,
  so a release through the hand-written broker keeps the origin as its
  client. A client a release made is never updated: its registration token
  rotates on every update and would be a secret written back each release,
  so a release registers anew, and a sign-in begun across a release is
  begun again. The subject an app learns hashes Kratos's identity with the
  redirect's host and the broker's salt, not the client: apps on two hosts
  get two subjects, every client on one host the same one, and none learns
  Kratos's id. The salt never changes once people have signed in.
- **Which apps are the operator's** — told the verified address and name
  without a word — the consent step decides, since registration is open to
  anyone and Hydra lets no registered client call itself first-party: a
  client whose every callback is on one origin carrying the operator's
  `_pronto-identity` TXT record (`identity/serve.sh txt`, signed with the
  hand-written broker's secret, so its records hold), or one the operator
  registered with `skip_consent`. Any other app on one origin is named to
  the person, who goes on or not, and learns only its subject; a client
  whose callbacks span origins is refused, or one on a vouched-for origin
  could carry an address to another.
- **The app's provider is `email`**, an issuer and a client id like any other
  (`OIDC_EMAIL_ISSUER`, `OIDC_EMAIL_CLIENT_ID`, scope `openid email profile`).
  The ID token carries the verified address, the name the person gave, and
  `amr` in Kratos's words — `code`, `password`, `oidc` — not RFC 8176's.
- **The ways in, on the broker's pages:** an emailed six-digit code, signing up
  or in (`passwordless_enabled`); recovery and verification by an emailed code.
  Google, by the operator's one client, configured once on the broker for
  every app (`plugins/broker/release.cue` mounts Kratos's providers from Secret Manager; `google.jsonnet` takes
  the address only when Google says it verified it); further social
  providers join it there, behind the app's one "more ways" entry, never as
  buttons of their own.
- **Straight to the provider the app named.** An app's "Continue with
  Google" names it (`provider=google`), so Hydra's login starts at the
  broker's own step (`start.ts`), which starts Kratos's flow in the browser
  and posts that provider's method, rather than Ory's page asking again.
- **The issuer has no slash after its host** (`https://id.bonisoft3.com`), as
  the apps name the broker, since discovery is compared exactly.
- **No password yet.** A password set at sign-up would outlive the address's
  owner proving it later by a code: the code signs in to the identity the
  password was made for, so two people would share the account. A password is
  added once the address is proven — in settings, by a person signed in by a
  code — which needs that flow designed and the registration method off; until
  then the method is off altogether. Kratos has no switch that keeps a method
  out of registration alone.
- **No address change yet.** The address is what a code signs in by, and
  Kratos keeps a changed one before it is proven, so its owner could later
  sign in to the same identity; profile settings are off until a change
  proves the new address before keeping it.

## Built and live

- **Local integration stack (`identity/ory/compose.yaml`) and tests (`identity/ory/broker.integration.test.ts`)**: Mailpit catching courier mail; mecha's auth service signing users in through Hydra + Kratos by emailed code with pairwise subjects and verified email claims.
- **Pronto broker service (`plugins/broker`) on GCP Cloud Run**: `ory-broker` serving `https://id.bonisoft3.com` alongside Cloud SQL `broker-db` (`kratos` and `hydra` databases), mailing codes as `sign-in@id.bonisoft3.com` via Cloudflare Email Sending, and serving themed self-service UI screens (`/login`, `/registration`, `/recovery`, `/verification`, `/settings`, `/error`) with operator-vouched `AppBrand` customization.
- **App configuration (`identity.#Signin`)**: Apps declare `email` (and/or brokered social providers) in `identity_signin.cue`, registering per-release pairwise clients via `identity/register.ts`.

## Remaining

- **Additional social providers through Kratos** (beyond Google and email codes) and SMS/WhatsApp once Twilio/Meta templates are ready.
- **Password and email-change flows in `/settings`**, gated until re-verification before keeping a changed address is wired safely.
