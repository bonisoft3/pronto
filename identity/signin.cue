// Sign-in through the identity broker beside the passkey, on mecha's own auth
// service. The operator runs one broker (hydra/front.ts on Ory Hydra) in front
// of the social providers, registered once; an application gets it with no
// client, secret or console of its own.
//
// mecha's auth service signs in through any OpenID issuer a deployment puts in
// a provider's place (mecha's services/auth/README.md#provider-sign-in), so the
// application side is configuration alone: the program names the providers
// (capabilities.auth.providers) and the broker in their place, as defaults a
// deployment overrides. A release turns them on (OIDC_PROVIDERS); a local
// launch and integrate leave them off, so a person comes in as a guest or with
// a passkey, the ways that need no one else (docs/identity.md). No code of this
// package runs in the application.
//
// Each application is its own tenant: its client id is its origin, its one
// redirect per provider that origin's /auth/oidc/<provider>/callback, and the
// subject the broker vouches for is pairwise, so no two applications share a
// user. An app embeds it in its own package (docs/identity.md):
//
//	import "github.com/bonisoft3/pronto/identity"
//	identity.#Signin & {signin: {broker: "https://id.example.com", providers: ["google"]}}
package identity

#Url: string & =~"^https?://[A-Za-z0-9.-]+(:[0-9]+)?$"

#Signin: {
	let S = self
	signin: {
		// The operator's broker as readers reach it, which is also its issuer.
		broker?: #Url
		// The providers the app offers: each one the broker offers, or, with
		// no broker, each signed in directly by the app's own client. Bluesky
		// is neither's: AT Protocol's client is the app's origin, so it needs
		// no client and no broker.
		providers: *["google"] | [string & =~"^[a-z][a-z0-9]*$", ...string & =~"^[a-z][a-z0-9]*$"]
		// With no broker, the app's own client at each provider; `credential`
		// signs Google in by its own button (Identity Services, FedCM where
		// the browser has it), for a client registered to the app's origins.
		clients?: [string]: {client: string, credential?: true}
	}

	code: {
		...
		capabilities: {
			...
			auth: {
				...
				service:   "/auth"
				providers: S.signin.providers
				provider: {
					...
					for p in S.signin.providers if p == "bluesky" {
						(p): {}
					}
					for p in S.signin.providers if p != "bluesky" {
						if S.signin.broker != _|_ {
							(p): {
								...
								issuer: S.signin.broker
								client: "origin"
								scope:  "openid profile email"
								params: "provider=\(p)"
							}
						}
						if S.signin.broker == _|_ {
							(p): S.signin.clients[p]
						}
					}
				}
			}
		}
	}
	...
}
