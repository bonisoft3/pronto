// Sign-in through the identity broker beside the passkey, on mecha's own auth
// service. The operator runs one broker (hydra/front.ts on Ory Hydra) in front
// of the social providers, registered once; an application gets it with no
// client, secret or console of its own.
//
// mecha's auth service signs in through any OpenID issuer a deployment puts in
// a provider's place (mecha's services/auth/README.md#provider-sign-in), so the
// application side is configuration alone: the program names the providers
// (capabilities.auth.providers), the terminal draws their way in, and the
// program's settings for each (capabilities.auth.provider) put the broker in
// its place, as defaults a deployment overrides with its own broker. No code of
// this package runs in the application.
//
// Each application is its own tenant: its client id is its origin, its one
// redirect per provider that origin's /auth/oidc/<provider>/callback, and the
// subject the broker vouches for is pairwise, so no two applications share a
// user. An app embeds it in its own package (docs/identity.md):
//
//	import "github.com/bonisoft3/pronto/identity"
//	identity.#Signin & {signin: providers: ["google"]}
package identity

import bayt "github.com/bonisoft3/bayt/core:bayt"

#Url: string & =~"^https?://[A-Za-z0-9.-]+(:[0-9]+)?$"

// The broker's release: the front's image (official denoland/deno, or
// published under mecha's roster), and Hydra's.
runtime:    "0.1.0"
frontImage: *"denoland/deno:distroless-2.5.0@sha256:5c4530d4babe37ded3566803e9498e2b5d643b915cce701d8b7b82f87a86629e" | string
hydraImage: "oryd/hydra:v26.2.0@sha256:ff67c7fb5f95074fa53374d41151713554960504b340cd3f95b09e65deaea2a9"

// The broker a local launch runs, whose issuer an app names by default.
localBroker: "http://localhost:28443"

#Signin: S={
	signin: {
		// The broker as readers reach it, which is also its issuer: the
		// operator's, so an application names nothing.
		broker: *localBroker | #Url
		// The broker as the cluster reaches it: the local broker's service
		// (below) by its name in compose, which the host projection reads as
		// loopback. The slash ends the port where bayt's rewrite looks for an
		// end (the auth service drops it): inside a `${VAR:-…}` default, `}`
		// would follow.
		brokerInternal: *[if S._local {"http://identity:28443/"}, broker][0] | #Url | =~"^https?://[A-Za-z0-9.-]+(:[0-9]+)?/$"
		// The providers the app offers, each one the broker offers.
		providers: *["google"] | [string & =~"^[a-z][a-z0-9]*$", ...string & =~"^[a-z][a-z0-9]*$"]
	}

	// An operator's broker elsewhere is that operator's to run.
	_local: S.signin.broker == localBroker

	// Sign-in through the broker is the auth plane's own: there is none
	// without it.
	code: capabilities: auth: {
		service:   "/auth"
		providers: S.signin.providers
		provider: {for p in S.signin.providers {(p): {
			issuer:   S.signin.broker
			internal: S.signin.brokerInternal
			client:   "origin"
			scope:    "openid"
			params:   "provider=\(p)"
		}}}
	}

	// The broker itself, for a local test: Hydra and the front as two of the
	// cluster's own services, from the front's image. On the host
	// (launch@local) each runs hydra/local.sh from its files, which signs in
	// through Google with the operator's ~/.config/pronto-identity/broker.env
	// and through a stand-in that signs in test people without it; in docker
	// (launch) each runs its image, the stand-in unless GOOGLE_CLIENT_ID and
	// GOOGLE_CLIENT_SECRET are set. A release names the operator's broker
	// instead.
	if S._local {
		cluster: surface: targets: {
			// A docker launch brings up what its aggregate waits on, which is
			// mecha's plane alone: the broker joins it.
			launch: compose: depends_on: identity: {condition: "service_healthy", restart: true}
			"identity-hydra": bayt.healthcheck.http & {
				cmd: builtin: null
				activate: ""
				healthcheck: url: "http://127.0.0.1:28453/health/ready"
				// Fixed on the host as in a container: the front reaches them so.
				expose: {public: port: 28453, admin: port: 28455}
				"process-compose": activate: ""
				entrypoint: {
					do:    _hydraCmd
					shell: "sh"
					dockerfile: {do: "hydra serve all --dev", shell: "exec"}
					env: compose.environment
				}
				dockerfile: from: name: hydraImage
				compose: environment: {
					DSN:                                     "memory"
					SECRETS_SYSTEM:                          "pronto-identity-local-launch-hydra-0000"
					LOG_LEVEL:                               "warn"
					URLS_SELF_ISSUER:                        S.signin.broker
					URLS_LOGIN:                              "\(S.signin.broker)/login"
					URLS_CONSENT:                            "\(S.signin.broker)/consent"
					SERVE_PUBLIC_PORT:                       "28453"
					SERVE_ADMIN_PORT:                        "28455"
					OAUTH2_PKCE_ENFORCED_FOR_PUBLIC_CLIENTS: "true"
					TTL_ID_TOKEN:                            "5m"
				}
			}
			identity: bayt.healthcheck.http & {
				cmd: builtin: null
				activate: ""
				healthcheck: url: "http://127.0.0.1:28443/health"
				// The broker's issuer, which the browser and Google's redirect name.
				expose: http: port: 28443
				"process-compose": activate: ""
				entrypoint: {
					do:    _frontCmd
					shell: "sh"
					dockerfile: {do: "deno run --no-config --allow-net --allow-env /app/hydra/front.ts", shell: "exec"}
					env: compose.environment
					after: "identity-hydra": "healthy"
				}
				dockerfile: from: name: frontImage
				compose: {
					ports: ["28443:28443"]
					environment: {
						BROKER_ISSUER:        S.signin.broker
						BROKER_SECRET:        "${BROKER_SECRET:-pronto-identity-local-launch-secret-0000}"
						BROKER_FAKE_GOOGLE:   "1"
						GOOGLE_CLIENT_ID:     "${GOOGLE_CLIENT_ID:-}"
						GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET:-}"
						HYDRA_PUBLIC:         "http://identity-hydra:28453"
						HYDRA_ADMIN:          "http://identity-hydra:28455"
						PORT:                 "28443"
					}
				}
			}
		}
	}
	...
}

// On the host, hydra runs directly via mise and the front directly under deno,
// with no custom container image needed.
_hydraCmd: "exec mise x github:ory/hydra@26.2.0 -- hydra serve all --dev"
_frontCmd: """
	p="${PRONTO_DIR:-}"
	if [ -z "$p" ]; then
		if [ -f "plugins/pronto/identity/hydra/front.ts" ]; then
			p="plugins/pronto"
		elif [ -f "identity/hydra/front.ts" ]; then
			p="."
		else
			p="$(mise where github:bonisoft3/pronto 2>/dev/null || true)"
		fi
	fi
	exec deno run --no-config --allow-net --allow-env "$p/identity/hydra/front.ts"
"""
