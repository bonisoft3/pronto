# Identity

How a reader of a pronto app becomes someone: what the app shows, the ways
in it offers, what a session carries, and where each piece runs. Most of it
is built; [More ways in](#more-ways-in) and [Recovery and step-up](#recovery-and-step-up) are the plan, marked as such. The
token contract, the device cookie and the provider settings are mecha's
[auth service reference](https://github.com/bonisoft3/mecha/blob/v0.32.0/services/auth/README.md);
the classes, copy keys and `data-auth-action` controls an app may style or
place are omnishell's [guide](https://github.com/bonisoft3/omnishell/blob/v0.30.0/GUIDE.md#signing-in). An app
never draws its own sign-in: the terminal does, the same in every app.

## What the reader sees

One account per browser. Three postures, one control at the nav's end:

| Posture | The control | Its panel |
| --- | --- | --- |
| **Visitor** | Sign in | "Continue with" each provider, then Passkey |
| **Guest** | "Guest" (Visitante), "This device", an open lock | "Signed in as guest" over "Keep it with" the same ways, then Sign out |
| **Person** | their name, the provider's address or "Passkey", a closed lock | their page, Rename, Sign out |

- **A guest** is minted on the first visit of an app that keeps tables, and
  shown once it writes — a favourite, a card — or at once when Sign in is
  tapped on a device nobody signed in on: it asks nothing. Signing out of a
  guest forgets it and its work.
- **Passkey** opens onto the accounts this device signed in to, as faces (the
  most recent first, as many as the panel holds), and one field. A face asks
  for its own passkey alone, so no browser list opens. The field holds the
  browser's passkey autofill, which offers every passkey it has for the site;
  a name typed in it with Enter or → makes a passkey and its account. × on a
  face forgets it on this device only.
- **Nobody sees their own handle.** A handle is a name and four hex digits
  that keep it unique (`davi-91c0`); a guest's is a fruit and an animal
  (`mango-capybara-3fa2`). Both are for others — bylines, a details page,
  addresses. The reader sees their name, or "Guest"; the password manager
  shows the passkey under the name too. A name filled in as an address
  (`davi@example.com`) keeps only what precedes the `@`, so an address never
  becomes public.
- **A guest's work goes with it.** A guest that wrote is promoted by its first
  sign-in, keeping its id and every row. One whose sign-in finds an account
  already made is never merged: the panel names the account and offers
  "Switch to it" or "Stay here". A guest that wrote nothing has nothing to
  lose and simply becomes the account it reached.
- **In place.** Signing in, switching and signing out redraw the page with no
  reload, except in an app that requires a sign-in, which reloads into its
  gate.

## The ways in today

| Way | Where it runs | Release modes |
| --- | --- | --- |
| **Guest** | mecha's auth service mints it | every mode with tables |
| **Passkey** | mecha's auth service, the passkey bound to the app's own domain | every mode on a secure origin |
| **Identity providers** (Google; Apple where an app names it) | the identity broker, through mecha's auth service as an OpenID Connect provider | edge, container and cloud tiers; refused on `pages` |

**Passkeys** are discoverable credentials, one per account, named by the
person's name. The browser is asked to lead with this device
(`hints: ["client-device"]`). A passkey the server no longer holds is
reported to the device (WebAuthn's Signal API), which drops it where its
password manager honours the signal — Google's does; iCloud Keychain, reached
from Chrome, does not. Attestation is not requested: synced passkeys carry
none.

**The identity broker** lets an app offer social sign-in with no client,
secret or provider console of its own. One operator runs it in front of the
providers; every app signs in through it as its own tenant. The app side is
configuration: mecha's auth service signs in through any OpenID issuer put in
a provider's place, and `identity.#Signin` fills the program's providers
(`capabilities.auth.providers`, `capabilities.auth.provider`, see
[compiler](compiler.md)) with the broker, as defaults a deployment's
`OIDC_<NAME>_*` overrides:

```cue
import "github.com/bonisoft3/pronto/identity"

identity.#Signin & {signin: providers: ["google"]}
```

No code of `identity/` runs in the app, and the terminal never sees the
broker's settings. Adding it is the
[pronto-identity skill](../skills/pronto-identity/SKILL.md).

- **Tenants.** A tenant is an app's origin, which is also its client id: a
  public client with PKCE and one exact redirect per provider,
  `<origin>/auth/oidc/<provider>/callback`. The subject is pairwise (a keyed
  hash of tenant, provider and the provider's subject), so one person is a
  stranger to every other app. A tenant that publishes the HMAC TXT record
  `identity/serve.sh txt` mints at `_pronto-identity.<host>` skips the
  broker's confirmation page and receives the requested `profile` and verified
  `email`; any other sees the page naming its origin first and receives `sub`
  alone. `identity/broker/core.ts` decides all of it apart from the network.
- **On Ory Hydra.** Hydra issues, signs and redeems every code and ID token.
  The front (`identity/hydra/front.ts`) keeps what Hydra leaves to a login
  app: the leg through the social provider and the pairwise subject. It
  registers a tenant on its first sign-in and passes only Hydra's public
  routes; the admin API is never public. Hand-written protocol code was the
  alternative: its own code store in memory and its own token signing, where
  Hydra holds both in a store that outlives a restart.
- **Local stacks sign in by what needs no one else.** An app's `launch` and
  `integrate` run no broker and turn on no provider (`OIDC_PROVIDERS` is
  the deployment's, empty there): a person comes in as a guest or with a
  passkey. A release turns on the providers its program offers, and the
  terminal draws only those the auth service names (`GET /auth/oidc`), so a
  way in shows where it works and nowhere else. Provider sign-in is tested
  against the broker in the auth service's and the broker's own suites, and
  end to end by an app's `verify` against its release. A local run against
  the release broker would need it to trust a `localhost` app, which it
  does not.

| Where | How | Broker |
| --- | --- | --- |
| an app's `launch` / `integrate` | none | none: guest and passkey |
| the operator's machine | `identity/serve.sh` | Hydra on SQLite |
| Cloud Run / k8s / Cloudflare | `identity/serve.sh release` (operator), `release@gcp` / `release@k8s` / `release@cloudflare` (apps) | Hydra on PostgreSQL, admin API private; apps connect as the `origin` public client or a direct `OIDC_<NAME>_CLIENT_ID` |
| `pages` | refused at compile time (`_authTargetRefusal`) | the browser tier runs guest sessions; providers need edge, container or cloud |

**Native hosts** (the Android and iOS apps) sign in through the same
service with what a browser has and an app lacks: Android passkeys verify
against the app's signing key (`ANDROID_APK_KEY_HASHES`), a provider's
sign-in returns to the app's own scheme with a one-time ticket the app
redeems with its PKCE verifier (`NATIVE_SCHEMES`), and every session comes
with a rotating refresh token in place of the browser's device session.
A guest signing in follows the browser's rule: an account that already
holds the subject is offered, never merged, the app showing it from the
ticket's `login_required` answer and switching with the ticket that answer
carries. Merging a guest's rows into an account needs the app's own say in
what merges, which no app declares yet. The contract
is mecha's [auth README](https://github.com/bonisoft3/mecha/blob/v0.32.0/services/auth/README.md).
No screen draws a sign-in: a native host has no terminal chip, so its
projection (`project-native.ts`) writes the account sheet its rail or bar
opens from the program's `auth` — a passkey, each provider, the way out and
deleting the account. An app names its hosts (`native: ["android", "ios"]`);
an iOS host ships on the App Store, which requires Sign in with Apple beside
any other provider (App Review Guideline 4.8), so a program with an `ios`
host and a provider but not `apple` is refused. Apple's sign-in needs a paid
Apple developer account, so an app without an iOS host need not offer it.

**Deleting an account** is the account panel's last row: the first press
asks, the second deletes the account and every row it owns
(`DELETE /auth/account`, which cascades), forgets it on this device, and
signs the device out.

An app names the operator's broker (`signin: broker: <url>`) and runs none
of its own.

## What a session says

Sessions speak OpenID Connect's claims, not a vocabulary of pronto's own, so
any relying party reads them. Every value below is a standard one:

| Claim | Values | From |
| --- | --- | --- |
| `acr` | `"0"` for a guest; `phr` for a passkey; a provider's own for its sign-in | OpenID Connect Core (`0`), OpenID EAP ACR values (`phr`, `phrh`) |
| `amr` | `pop` for a passkey, a proof of possession of its key (where the key lives is unattested), plus `mfa` where it verified its person; a provider's own | RFC 8176's registry |
| `auth_time` | when the person last proved themselves, kept across renewals; absent where a provider does not say | OpenID Connect Core |

A policy for people asks for an `acr` other than `"0"`; an
app with sensitive actions asks for more (`mfa` in `amr`, a recent
`auth_time`) and refuses with RFC 9470's step-up error otherwise. `phrh` is
never claimed: it needs attested hardware, and the browser's flags are not
attestation.

The browser keeps the session in `localStorage`, every tab the same reader,
and the auth service keeps it in an HttpOnly cookie that brings it back when
the token lapses or storage is cleared — the
[device session](https://github.com/bonisoft3/mecha/blob/v0.32.0/services/auth/README.md#device-session).
What only the device knows of its guest (that it wrote, that it was shown)
outlives the token the cookie renews. The faces are the device's own list
(`pronto-device-accounts`), never the server's.

## More ways in

*Planned, not built.* Google and Passkey stay the first choices; a third row,
**⋯ More ways**, opens a step in the same panel listing what else the app
declares. An app declares its ways and their order in CUE; a check before
release refuses a way the release mode cannot serve.

**Every way here is the broker's.** These ways are offered only in release
modes that run it, where Ory Kratos already holds them — passwords, one-time
codes, recovery, rate limits, the sending — so mecha's auth service gains no
second implementation of any of them. Without the broker an app offers guest,
passkey and its identity providers, as today.

| Method (pronto's name) | Channels | `amr` (standard) | Notes |
| --- | --- | --- | --- |
| **`sim`** — the SIM card holds the number | SMS, WhatsApp, voice | `sms`; `otp` for WhatsApp, which RFC 8176 does not name; `tel` for voice | One way: every channel confirms the same SIM. WhatsApp through Meta's authentication templates, whose autofill spares typing the code. Later, the operator's own check of the SIM with no code at all (GSMA Open Gateway / CAMARA Number Verification), where carriers offer it. |
| **`email`** | one message carrying a link and a code | `otp` | The link signs in where the sign-in started — the flow is bound to that browser — with nothing to copy; opened elsewhere, the message's code is typed where the sign-in waits. |
| **`password`** | — | `pwd` | With or without a way back. Without one it is the burner account: a username and a password, nothing to verify. Following NIST SP 800-63B-4: no composition rules, a check against known-breached passwords. Right after a password sign-in the browser may add a passkey with no prompt (WebAuthn conditional create), so a password is an on-ramp to passkeys. |

- **The code step is the terminal's**, the same for `sim` and `email`:
  - **One field drawn as six boxes**, never six inputs, so autofill, paste and
    screen readers each meet one field: `inputmode="numeric"`,
    `autocomplete="one-time-code"`, six digits at most. Paste keeps the
    digits of whatever it is given.
  - **A full code submits itself**; a wrong one clears the boxes and keeps
    the focus. Resending waits out a countdown, and `sim` switches channel in
    place ("Send by SMS instead").
  - **The code arrives filled in where the platform can:**
    - **SMS** ends in an origin-bound line, `@<host> #<code>` (WICG's
      origin-bound one-time codes): Safari offers it above the keyboard,
      and Chrome on Android reads it through the WebOTP API with one tap.
    - **WhatsApp** sends Meta's authentication template: one tap on
      Android, and, by Meta's account, the iOS notification from iOS 26.
    - **Email**: Safari offers codes from Apple Mail; anywhere else the
      message's link is the no-typing path.
    - **Native hosts**, later: Android's SMS User Consent and Retriever
      APIs.
- **Any way may be the only one.** None is "the recovery method": getting back
  in is signing in by another way the account has. A person's panel gains
  **Ways to sign in**, to add or remove one while signed in; accounts are
  still never merged.
- **Assurance.** NIST SP 800-63B-4 classes delivery over the phone network as
  its one *restricted* authenticator, and an emailed code is no second factor.
  Both are sound first ways in at ordinary assurance; an app's sensitive
  actions ask for `phr` or a strong provider (gov.br for esocial) through the
  claims above.
- **Contact.** Signing in with a phone or an address verifies a contact point
  (`phone_number_verified`, `email_verified`); it is not consent to anything
  beyond the account's own notices. When an app later wants to market, a way
  that verified a contact point needs only the reader's consent, while the
  others need the contact collected first — a shorter funnel an app may weigh
  when it orders its ways.
- **Left out.** Facebook, and Instagram, which offers no OpenID Connect: its
  login is OAuth for professional accounts managing their own presence.

## Recovery and step-up

*Planned, not built.*

### Recovery

Getting back in is signing in by another way the account has, then adding a
way to replace the one lost — NIST SP 800-63B-4's account recovery through a
bound authenticator. Two things join the ways in for it:

- **Recovery codes** — NIST's saved recovery codes: a handful of single-use
  codes the person downloads or prints, each replaced once used. They are the
  way back for an account with no email or phone, a burner's included.
  Kratos keeps them (its *lookup secrets*), so they are the broker's, as the
  other ways under ⋯ are.
- **A waiting period** for recovering the strongest way when only weaker ones
  remain: the new way works after a day, every other way is told at once, and
  any of them may cancel. A takeover is seen, not silent. (Apple's and
  Google's account recovery wait the same way; no standard sets the delay.)

An account is as strong as its weakest way in, so the rules sit where that
matters:

- **Signing in**: any of the account's ways. The session says which (`amr`,
  `acr`), and what needs more asks for more — step-up, below.
- **Adding a way** needs a recent sign-in at that way's level or above: an SMS
  session may add an email or a password, not a passkey or Google — else a SIM
  taken over would buy a passkey. Kratos's `privileged_session_max_age` holds
  the "recent" for the broker's ways.
- **Every way added or removed is told to the account's other ways**, through
  a channel independent of the one used, as NIST requires, and to other
  systems as OpenID Shared Signals events: CAEP's credential change, RISC's
  recovery information changed. Kratos's hooks after settings and recovery
  are where they leave from; Ory sends no Shared Signals of its own.
- **Removing a way** follows the adding rule; the last way goes only with the
  account.

**Set up recovery** is asked in the panel when a reader **returns** — a
session taken up again from the device, a face tapped — to an account that has
**had an external effect** (an effect of level 4, through the airlock: a
payment, an order, a message), which the airlock stamps on the account so
every device knows it. Not now backs off exponentially — a day, two, four, …
up to about two months — on the account, reset when recovery is set up. It
stops for good once the account is **recoverable**: two ways or more, or one
and recovery codes. A burner — one password, by choice — dismisses it and is
asked less and less.

### Step-up

An effect that needs more than being signed in asks for it first, in the
panel, and the auth service refuses it otherwise with RFC 9470's
`insufficient_user_authentication`. What it needs is said in three
dimensions every platform shares — **how** the person proves it, **how
recently**, and whether the proof is **tied to this action** — as four
levels:

| Level | Means | Web | Android (native hosts) | iOS (native hosts) |
| --- | --- | --- | --- | --- |
| `session` | signed in at all | the session | — | — |
| `recent` | a way that verifies the person, within `maxAge` | a passkey limited to the reader's own (`allowCredentials`) with user verification required; `amr` `mfa` and a fresh `auth_time` | BiometricPrompt, a Class 2 biometric or the device credential; a key usable for `maxAge` after it | LocalAuthentication, biometrics or passcode, reused at most 5 minutes |
| `strong` | phishing-resistant, verified by a biometric | as `recent`, its `acr` `phr` | a Class 3 biometric only, no credential fallback — Android's Identity Check for sensitive surfaces away from trusted places | biometrics only |
| `transaction` | a proof over this action's contents, used once | Secure Payment Confirmation for a payment; else a passkey over a challenge that hashes the action | BiometricPrompt with a CryptoObject, a key valid per use | a biometric over a Keychain key, no reuse |

- **User verification (UV)** is the authenticator saying it checked *who* —
  fingerprint, face, PIN, screen lock — not only that someone touched it
  (user presence, UP). `userVerification: "required"` asks for it, the server
  refuses a response whose UV flag is off, and `amr` carries `mfa` exactly
  when it was set.
- **Secure Payment Confirmation** (W3C) is the web's transaction proof: the
  browser itself shows the payment — amount, payee, instrument — and the
  passkey signs over exactly that, PSD2's dynamic linking. Chrome and Edge
  have it, Safari does not, and its passkeys are registered with its payment
  extension, so it suits a payment an app takes itself. Elsewhere a challenge
  over the action's hash ties the proof to it without the browser showing
  what is signed.
- **Between the app and the broker** step-up is plain OpenID Connect: the app
  asks with `max_age`, `acr_values` or `prompt=login`, which Hydra hands its
  login page; Kratos re-authenticates (`refresh=true`, `aal`) and Hydra's
  login accept carries `acr` and `amr` into the ID token.

**Defaults:** external effects `recent` within 10 minutes; a payment
`transaction` where Secure Payment Confirmation exists, `strong` elsewhere;
adding or removing a way `strong`, with the waiting period where no strong
way is left.

### How an app opts in

Recovery and step-up are one mechanism — the terminal compares what is
required with what is present and asks in the panel, as a step of its own:
step-up blocks before an effect, recovery asks after its trigger and may be
dismissed. An app reaches it at three depths:

1. **Defaults, nothing written**: Set up recovery wherever a program has
   external effects; step-up off.
2. **A declaration** tunes them — `auth: recovery: {…}`,
   `auth: stepUp: external: {level: "strong", maxAge: "5m"}` — under which
   the terminal steps up before every external effect by itself.
3. **A machine step** for an app's own moments — a checkout done, a deck
   published. A chart's effects are a closed vocabulary the terminal owns
   (`create`, `update`, `delete`, `upsert`, answered `sync_ack` or
   `refused`); one word joins it, `identity`, answered the same way:
   `{op: "identity", stepup: {level, maxAge?}}` → `identified` or `refused`,
   and `{op: "identity", recovery: {}}` → `identified` or `declined`.

**Open questions.** Kratos's documentation shows recovery by SMS, while
community reports say its schema refuses it; the pinned version decides.

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

## On a developer's machine

Every app and worktree on one machine shares the `localhost` relying party,
and each `launch` starts its database afresh, so the browser accumulates
passkeys for accounts that no longer exist, and other apps' besides. Picking
one is refused, and the device is told to drop it, which only Google's
password manager honours. Clearing them is the password manager's: Chrome's
`chrome://password-manager/passwords` and the macOS Passwords app. A
per-app, per-worktree host (`<app>.<worktree>.localhost`) would give each its
own passkeys; Chrome and Firefox resolve such names themselves, Safari needs
an `/etc/hosts` line.
