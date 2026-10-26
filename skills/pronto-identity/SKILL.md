---
name: pronto-identity
description: "Add social sign-in (Google, and the providers the identity broker offers) to a pronto app beside its passkey, with no client, secret or cloud console of the app's own: the app's auth service signs people in through the identity broker the framework's operator runs, each app its own tenant with its own users. Also how the operator runs that broker. Use when the user wants Google login, social login or \"Sign in with …\" on a pronto app, or to run the broker."
---

# pronto-identity

Two halves, both in pronto's `identity/` ([docs/identity.md](../../docs/identity.md)):

- **The broker**, run once by the framework's operator: Ory Hydra as the
  OpenID Connect provider, behind a front (`identity/hydra/front.ts`) in front
  of the social providers, whose clients the operator registers once. An app
  is never asked for any of it.
- **The app side**, configuration alone: the app embeds `identity.#Signin`,
  which names the providers and puts the broker in each one's place, so
  mecha's own auth service signs in through it and the terminal draws the way
  in.

## Tenants

Each application is its own tenant, and tenants are never merged:

- Its client id is its origin; it is a public client proving its code with
  PKCE, holding no secret, needing no registration.
- Its one redirect per provider is its origin's `/auth/oidc/<provider>/callback`
  (mecha's), exact. The broker refuses any other without redirecting, and an
  error goes to the redirect only once the redirect is known to be the
  tenant's.
- The subject the broker vouches for is pairwise: a keyed hash of tenant,
  provider and the provider's subject. One person is a stranger to every other
  app, and nothing else about them arrives (scope `openid`).
- A code is single-use and redeemable only by the tenant and redirect it was
  issued to; the ID token's audience is that tenant alone.

## Adding it to an app

From a pronto app whose auth plane is on (`capabilities.auth`) and whose four
verbs are green:

1. Write `identity_signin.cue` in the app's package (not `identity.cue`: sayt
   vets a file against the directory of its name):

   ```cue
   package <the app's package>

   import "github.com/bonisoft3/pronto/identity"

   identity.#Signin & {signin: providers: ["google"]}
   ```

   `signin: broker: "https://id.example.com"` names an operator's broker
   elsewhere than the default; the app then runs no local broker.
2. Add a decision for the sign-in to `ir.html`, then re-pin `meta.ir.sha256`.
3. The terminal's strip offers each provider to a guest. An app that hides the
   strip presses its `.shell-provider[data-provider=<name>]` link from its own
   bar, as it presses the passkey.
4. `./saytw generate && ./saytw lint && ./saytw test && ./saytw integrate`.

The broker's pins move with pronto's version: nothing to refresh.

## The local broker

With the default broker (`http://localhost:28443`), the app's own launch brings
it up: `identity-hydra` (Ory Hydra, in memory) and `identity` (the front), two
services of its cluster.

- `launch@local` runs each as a host process (Hydra via mise, the front directly
  under Deno). With the operator's `~/.config/pronto-identity/broker.env` it signs
  in through Google; without it, through a stand-in that says it is not Google and
  signs in a test person (`tester`, `tester-2`).
- `launch` runs their images: Hydra's (`oryd/hydra:v26.2.0`), and the front's
  (standard Deno base image, or Mecha roster), the stand-in unless
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- Its port is the operator's standalone broker's: run one or the other.

A release names the operator's broker instead (`OIDC_<NAME>_ISSUER` and
`_INTERNAL`).

## Deploy targets

- **`gcp` & `k8s`**: An app points `mecha-auth` to the operator's production broker
  via `OIDC_<NAME>_ISSUER` with client `origin`. No client secret is required.
- **`pages` & `cloudflare`**: Refused at compile time (`_authTargetRefusal`). Browser-tier
  apps run guest sessions; social provider sign-in requires container or cloud tiers.

## Running the broker (the operator, once)

1. Each provider's client, registered once by the operator: for Google, a "Web
   application" OAuth client whose only redirect URI is
   `<broker issuer>/callback/google` (`http://localhost:28443/callback/google`
   on the operator's machine). Never an app's own URL.
2. `~/.config/pronto-identity/broker.env`, mode 600, never committed:
   `BROKER_ISSUER`, `BROKER_SECRET` (32+ characters; it derives every pairwise
   subject, so rotating it gives every person a new subject in every app), and
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Ask the operator to fill the
   secrets in themselves.
3. `identity/serve.sh` serves it on Hydra at the issuer's port (28443), Hydra
   on SQLite under `~/.local/state/pronto-identity`. It speaks plain HTTP; TLS
   is the platform's.
4. `identity/serve.sh release --project P --domain D --google-client-id C`
   releases the broker to Cloud Run.

## Limits

- Google's consent screen names the operator's client, not each app; the
  broker's own page names the app's origin before leaving for Google.
- One way in per account: a passkey or a provider, never both, and a provider
  never promotes a guest.
