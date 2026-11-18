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
person is a stranger to every other app. An operator-owned tenant that publishes
the HMAC TXT record `identity/serve.sh txt` mints at `_pronto-identity.<host>`
skips the broker's confirmation page, `302`-redirects straight to the
provider, and receives requested `profile` and verified `email` claims;
unverified origins see the origin-naming confirmation page first and receive
`sub` alone.
`identity/broker/core.ts` decides all of it apart from the network.

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
| an app's `launch@host` | `identity-hydra` and `identity` as host processes via mise and Deno directly | Hydra in memory; Google with the operator's `broker.env`, else a stand-in signing in `tester` |
| an app's `launch` | the same two services from their pinned base images | as above, the stand-in unless `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set |
| the operator's machine | `identity/serve.sh` | Hydra on SQLite |
| Cloud Run / k8s / Cloudflare | `identity/serve.sh release` (operator), `release@gcp` / `release@k8s` / `release@cloudflare` (apps) | Hydra backed by PostgreSQL with private admin API; apps connect via `origin` public client or direct `OIDC_<NAME>_CLIENT_ID` |
| `pages` | refused at compile time (`_authTargetRefusal`) | browser tier runs guest sessions; social providers require edge, container or cloud tiers |

An app naming `signin: broker: <url>` runs no local broker. Pronto publishes no custom runtime image: local runs use the host's Deno and Hydra binaries, and Docker launches use pinned base images.


## Token roles and trusted issuers

Another system can call an app's API as a named database role, with tokens
from an OAuth2 or OpenID issuer the release trusts. Two pieces make that, one
the program's and one the release's.

**The program declares the role.** Beside the cluster's own `anon`,
`app_user` and `service`, a program names the roles a token may name:

```cue
state: tokenRoles: residual_bot: note: "the expense automation, which derives an advance payment's residual"
```

Each is PostgreSQL's NOLOGIN role, granted to PostgREST's login as the
cluster's own are, so a token naming it is switched to it, with a request's
bounds; on Kubernetes it is among the token roles CloudNativePG keeps
granted. It holds nothing else: no table, no function, no default privilege,
never BYPASSRLS. What it may do is the app's own SQL in `state.rawMigrations`
or a migration, `GRANT EXECUTE` on a function or a policy naming it
([access](access.md#declared-token-roles)); a
[rewrite](rewrites.md#a-path-another-system-calls) can keep the path the caller
already calls. A role declared after a database was built reaches it on the
next release, ahead of that release's migrations, which may then grant it.
A role removed is refused from the release that removes it: crud is told
the roles the program declares (`PGRST_APP_SETTINGS_TOKEN_ROLES`, which
PostgREST sets in every request and no client can), and the floor admits a
registered role only while crud is told it, so a crud told nothing admits none.
The database is cleaned up behind it: the release leaves the role out of
`mecha.token_role` and revokes it from PostgREST's login, on a migrate step.
An app with no migrations of its own runs one only where it says `state:
tokenRoles: {}`, and generating one that deletes `tokenRoles` outright warns.
A token naming no issuer stays `anon`'s once the app has trusted one, since a
crud not yet restarted, or an operator's key set, may still hold the issuer's
keys. A database whose `app_pre_request` predates
this check keeps the older function until a migrate step restates the floor;
token roles shipped only with this floor's previous revision, so no deployed
database holds one.

**The release trusts an issuer.** PostgREST fetches no JWKS, so a release
gives crud the key set it verifies by, `PGRST_JWKS`: the stack's own secret as
an `oct` key beside the issuer's published public keys, which
[`trusted-keys.ts`](../trusted-keys.ts) composes from `PGRST_JWT_SECRET` and
`TRUSTED_JWKS`, refusing a private part, a symmetric key, a key without a
`kid` and one not for signatures. crud then holds a token naming an audience
to its own, `TRUSTED_AUDIENCE`, else `<origin>/crud`. The role is the token's
`role` claim, the one the stack's own tokens carry (PostgREST's
`jwt-role-claim-key` is not moved, or every `app_user` token would lose its
role).

| Where | crud's keys |
| --- | --- |
| docker appliance | the operator runs `trusted-keys.ts` with the appliance's `PGRST_JWT_SECRET`, the issuer's `TRUSTED_JWKS` and `TRUSTED_ISSUER`, and starts it with the output as `PGRST_JWKS` |
| k8s | `release@k8s` with `TRUSTED_JWKS` and `TRUSTED_ISSUER` set: it composes the set from the cluster's own secret into `<app>-trusted-keys`, through stdin, never a manifest, and rolls crud when the issuer's keys change |
| a local launch | none: it trusts no issuer, and [`dev-token.ts`](../dev-token.ts) gives a token for a declared role instead |
| gcp | not yet: crud there verifies the stack's own tokens alone |
| pages, cloudflare | a declared role is refused at compile time: neither has a role a token may switch to |

**An issuer's token is a declared role's alone, and the stack's are the
cluster's.** Every token the stack signs names the stack's own issuer,
`iss: "mecha:stack"` (mecha's `services/auth/jwt.ts`, and the floor's
`mecha.stack_issuer()`): the auth service's people and guests, the edge's,
and the service token in every release and in the development stack. The
tenancy floor's `app_pre_request` lets the cluster's own roles, `anon`,
`app_user`, `service` and any other it holds, act only on a token naming that
issuer, and a role listed in `mecha.token_role`, the declared ones the release
writes there, only on one naming another issuer and an audience; anything else
is refused (`42501`), whatever role the token wrote. A token another issuer
signed names its issuer, as OpenID's tokens and RFC 9068's access tokens
always do, Hydra's among them, so it reaches a declared role and nothing else;
one that leaves its issuer out reaches no role but `anon`. A release refuses
to trust an issuer that names itself as the stack does: `TRUSTED_ISSUER`, the
issuer's `issuer` as its discovery document states it, is required beside
`TRUSTED_JWKS`, and `trusted-keys.ts` refuses `mecha:stack`.

Tokens the stack signed before it named its issuer carry none. Such a token is
believed while the app trusts no other issuer, where only the stack's secret
verifies anything, so no deployed app's sessions or service token change:
an app trusts an issuer only through a declared token role, which no deployed
app has. Once an app declares one, a token naming no issuer acts as `anon`,
signed out, whatever role it wrote, and its people sign in again; every
release restates its service token, which then names the stack's issuer.

The residual is the issuer's key: PostgREST does not say which key verified a
token, so an outside issuer whose key signed a token naming the stack's issuer
would reach the cluster's roles. The issuer's keys are trusted that far.

Within the declared roles the issuer is trusted, so it puts a `role` claim only
in a token it issues to a client the operator registered for that role, never
one the client chose. A token naming its issuer must name an audience too,
which the floor refuses it without (`42501`), since PostgREST holds a token to
crud's audience only if it names one. A person's token from the same issuer
names no role and no audience of crud's: an ID token's audience is its app's
origin, never `<origin>/crud`.

Hydra, the broker's issuer, holds to it so. Its token hook asks the front
(`hydra/front.ts`, `POST /hooks/token`, behind `HYDRA_HOOK_SECRET`) for a
client credentials token's role, and the front answers it from the `role` the
operator wrote in the client's metadata when registering it, through the
admin API that is never public; dynamic registration stays off. It answers a
client credentials grant alone, refuses a role of the cluster's own and a
token naming no audience, and Hydra signs a client's token as a JWT only
where the client says so (`access_token_strategy: jwt`): a person's access
token stays opaque. The client's id is the token's `sub`, which the tenancy
floor reads as a subject: register it under a name, never a uuid a person
could hold. Registering one is the operator's, on Hydra's admin API, the
secret made there and handed to the caller out of band, never into a program,
a manifest or a log:

```sh
hydra create oauth2-client --endpoint http://127.0.0.1:28455 \
  --id residual_bot --grant-type client_credentials --token-endpoint-auth-method client_secret_basic \
  --access-token-strategy jwt --audience https://expense.example/crud --metadata '{"role":"residual_bot"}'
```

and the caller, with what it was handed:

```sh
curl -u residual_bot:$SECRET https://id.example/oauth2/token \
  -d grant_type=client_credentials -d audience=https://expense.example/crud
```

**On a local launch** no issuer is trusted and no key set composed. A
function a declared role alone may execute is called with a token
`dev-token.ts` signs with the stack's development secret, as the cluster's own
development service token is, naming an issuer of its own (`mecha:dev-token`,
never the stack's) and crud's audience (`TRUSTED_AUDIENCE`, else the origin's
`/crud`):

```sh
TOKEN=$(ORIGIN=https://localhost:<port> deno run --allow-read --allow-env plugins/pronto/dev-token.ts residual_bot apps/expense)
curl -X POST -H "Authorization: Bearer $TOKEN" https://localhost:<port>/expense/advance-payment/<id>/residual
```

It names only a role the app declares, and signs with the development secret
alone: a stack given its own `PGRST_JWT_SECRET`, as every release is, refuses
it, and the tool refuses to sign with any other secret.

**Rotation.** Hydra signs with the newest key of its set the moment one is
added, so a new key reaches crud first: make the pair outside Hydra as a JWK
with its own `kid`, add its public half to `TRUSTED_JWKS` and release, then
import it into Hydra (`hydra import jwk hydra.jwt.access-token key.jwk.json`,
which keeps that `kid` and signs with it from then on), and drop the old
public key once the last token it signed has expired. Without a staged key, a
token Hydra signs before the release is refused until it lands.

A [signal](signals.md) does not fit here: it is public and untrusted, one event
to one row. A token whose role the operator chose does.
