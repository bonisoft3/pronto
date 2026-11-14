// An issuer whose token an application takes in exchange for a session of its
// own: a person another service has proven, for one operation. The front that
// checks the token (identity/bearer.ts), the page that reaches the issuer (its
// origin, a CSP's connect-src) and whatever guards the exchange read the same
// entry, which the application writes once:
//
//	import "github.com/bonisoft3/pronto/identity"
//
//	issuers: [Name=string]: identity.#Issuer & {name: Name}
//
// The issuer, its clients and its claims are the application's. The claims the
// token becomes are mecha's upgrade's (services/auth/README.md#upgrade):
// `operation_kind`, `operation_id`, `amr` and `idp`, signed by mecha's auth
// over the session the front was handed, never by the front.
package identity

import (
	"list"
	"regexp"
	"strings"
)

// A TCP port, 1 to 65535.
_portRange: "([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])"

// An issuer's URL: https, or http on this machine's loopback, where a local
// stand-in runs. No query, fragment or trailing slash: a token's `iss` is
// compared with it exactly.
#IssuerUrl: =~"^(https://[A-Za-z0-9.-]+|http://(localhost|127\\.0\\.0\\.1))(:\(_portRange))?(/[^/?#\\s]+)*$"

// The longest claim mecha's upgrade takes, in characters
// (services/auth/README.md#upgrade), emitted with each issuer for its check.
_claimMax: 200

// A claim mecha's upgrade takes: 1 to _claimMax printable ASCII characters, so
// a character is one by any count, a rune here or a UTF-16 unit there; amr a
// list of 1 to 8 of them.
#Claim: =~"^[ -~]+$" & strings.MaxRunes(_claimMax)
#Method: #Claim & =~"^[a-z0-9_-]+$"

// Where an operation claim comes from: one claim of the token, at any value or,
// where the issuer's words are not the application's, at one of `values`,
// each becoming the application's word for it.
#From: {
	claim!: string & !=""
	values?: [string]: #Claim
}

#Issuer: I={
	// Its name, which an upgraded session's `idp` carries.
	name!: #Claim & =~"^[a-z][a-z0-9-]*$"
	// A token the application's front checks and exchanges. A sign-in by
	// redirect is mecha's provider sign-in (capabilities.auth.provider).
	kind: "bearer"
	// The token's `iss`, exactly.
	issuer!: #IssuerUrl
	// Its OpenID discovery document, which names the key set
	// (identity/bearer.ts asks it once, and checks it names this issuer): the
	// issuer's own, never another URL, whose answer could claim any issuer.
	discovery: "\(I.issuer)/.well-known/openid-configuration"
	alg: *"RS256" | "ES256"
	// The clients a token must have been issued to (`azp`): at least one.
	azp!: [string & !="", ...string & !=""]
	// Audiences, one of which the token's `aud` must name; none checks none.
	audience: *[] | [...string & !=""]
	// Claims the token must carry, each at one of its values.
	require: [string]: [string & !="", ...string & !=""]
	// The operation the token is for, each claim from one of the token's.
	map!: {
		operation_kind!: #From
		operation_id!:   #From
	}
	// How the issuer proved the person, which an upgraded session's `amr` carries.
	amr!: [#Method, ...#Method] & list.MaxItems(8)
	// The issuer's origin, which a page that reaches it admits.
	origin: regexp.FindSubmatch("^(https?://[^/]+)", I.issuer)[1]
	// The longest operation claim its check takes from a token: the upgrade's.
	claimMax: _claimMax
}
