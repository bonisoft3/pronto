# Identity

Social sign-in beside the passkey, for an app that has no client, secret or
provider console of its own. One operator runs the identity broker in front
of the social providers; every app signs in through it as its own tenant, on
mecha's own auth service. The code is `identity/`; adding it to an app is
the [pronto-identity skill](../skills/pronto-identity/SKILL.md).

## The app side is configuration

mecha's auth service signs in through any OpenID issuer a deployment puts in a
provider's place, and a program already names its providers
(`capabilities.auth.providers`) and each one's settings
(`capabilities.auth.provider`, see [compiler](compiler.md)). `identity.#Signin`
fills both with the broker, as defaults a deployment's `OIDC_<NAME>_*`
overrides. The app embeds it at its package's root:

```cue
import "github.com/bonisoft3/pronto/identity"

identity.#Signin & {signin: providers: ["google"]}
```

No code of `identity/` runs in the app, and the terminal never sees the
broker's settings. An import, not a file a generator writes: the broker's pins
move with pronto's version, and there is no `do not edit` copy in the app to
drift from them.

## Tenants

A tenant is an app's origin, which is also its client id: a public client with
PKCE and one exact redirect per provider, mecha's
`<origin>/auth/oidc/<provider>/callback`. The subject the broker vouches for is
pairwise (a keyed hash of tenant, provider and the provider's subject), so one
person is a stranger to every other app. `identity/broker/core.ts` decides all
of it apart from the network.

## The broker on Ory Hydra

Hydra issues, signs and redeems every code and ID token. The front
(`identity/hydra/front.ts`) keeps what Hydra leaves to a login app: the leg
through the social provider and the pairwise subject. It registers a tenant
in Hydra on its first sign-in and passes only Hydra's public routes; the admin
API is never public. The issuer, the provider's redirect and the subject are
the pre-Hydra broker's (`identity/broker/main.ts`), so a person keeps the
subject each app already linked.

Hand-written protocol code was the alternative: it carried its own code store
in memory (one instance, a code lost on restart) and its own token signing.
Hydra holds those, with a store that can outlive a restart.

## Where it runs

| Where | How | Broker |
| --- | --- | --- |
| an app's `launch@local` | `identity-hydra` and `identity` as host processes via mise and Deno directly | Hydra in memory; Google with the operator's `broker.env`, else a stand-in signing in `tester` |
| an app's `launch` | the same two services from their pinned base images | as above, the stand-in unless `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set |
| the operator's machine | `identity/serve.sh` | Hydra on SQLite |
| Cloud Run / k8s | `identity/serve.sh release` (operator), `release@gcp` / `release@k8s` (apps) | Hydra backed by PostgreSQL with private admin API; apps connect via `origin` public client |
| `pages` / `cloudflare` | refused at compile time (`_authTargetRefusal`) | browser tier runs guest sessions; social providers require container/cloud tiers |

An app naming `signin: broker: <url>` runs no local broker. Pronto publishes no custom runtime image: local runs use the host's Deno and Hydra binaries, and Docker launches use pinned base images.
