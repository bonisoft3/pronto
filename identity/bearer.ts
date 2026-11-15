// A bearer token of another issuer (identity/issuer.cue's #Issuer), checked
// for the operation it vouches for: whose it is by its `iss`, signed by that
// issuer's published keys, issued to one of its clients, and the claims the
// issuer maps to the operation's. The result is what mecha's upgrade adds to a
// session (services/auth/README.md#upgrade). No reason a token is refused
// carries any of its values.
import { type Alg, FETCH_TIMEOUT_MS, fromBase64url, jwksSource, type KeySource, Refused, signedClaims } from "./oidc.ts";

export type From = { claim: string; values?: Record<string, string> };
/** An #Issuer as identity/issuer.cue exports it. */
export type Issuer = {
  name: string;
  kind: "bearer";
  issuer: string;
  discovery: string;
  alg: Alg;
  azp: string[];
  audience: string[];
  require: Record<string, string[]>;
  map: { operation_kind: From; operation_id: From };
  amr: string[];
  /** The longest operation claim, in UTF-16 units as the upgrade counts them. */
  claimMax: number;
};
export type Operation = { operation_kind: string; operation_id: string; amr: string[]; idp: string };

// As an ID token's (verifyIdToken): the issuer's clock and this one's may differ by as much.
const LEEWAY_S = 60;
// How seldom a key no token has named before is asked of the issuer again, and
// how long a key set is trusted before the next lookup must have it again.
const KEYS_REFETCH_S = 30;
const KEYS_MAX_AGE_S = 600;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The issuer's keys: its discovery document, asked once and held to naming
 * this issuer, names the key set (jwksSource), asked again for a key it did not
 * hold or once KEYS_MAX_AGE_S old, at most every KEYS_REFETCH_S. A discovery
 * that fails, or does not answer within FETCH_TIMEOUT_MS, is asked again no
 * sooner either.
 */
export function issuerKeys(issuer: Issuer, fetcher: typeof fetch = fetch): KeySource {
  let source: Promise<KeySource> | undefined;
  let failedAt = -Infinity;
  const discover = async (): Promise<KeySource> => {
    const res = await fetcher(issuer.discovery, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${issuer.name}: discovery ${res.status}`);
    const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown } | null;
    if (doc?.issuer !== issuer.issuer) throw new Error(`${issuer.name}: discovery names another issuer`);
    if (typeof doc.jwks_uri !== "string") throw new Error(`${issuer.name}: discovery names no key set`);
    // https, but for a local stand-in: http on loopback, the discovery's own
    // host. Keys fetched over http from anywhere else are anyone's keys.
    const keys = new URL(doc.jwks_uri);
    const standIn = keys.protocol === "http:" && LOOPBACK.has(keys.hostname) &&
      keys.hostname === new URL(issuer.discovery).hostname;
    if (keys.protocol !== "https:" && !standIn) throw new Error(`${issuer.name}: key set is not https`);
    return jwksSource(keys.href, fetcher, { refetchAfterS: KEYS_REFETCH_S, maxAgeS: KEYS_MAX_AGE_S });
  };
  return async (kid) => {
    if (source === undefined) {
      if (Date.now() / 1000 - failedAt < KEYS_REFETCH_S) throw new Error(`${issuer.name}: discovery failed recently`);
      source = discover();
      source.catch(() => {
        source = undefined;
        failedAt = Date.now() / 1000;
      });
    }
    return (await source)(kid);
  };
}

/** The token's `iss`, read before its signature is checked only to choose whose keys check it. */
function unverifiedIssuer(token: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(token.split(".")[1] ?? "")))?.iss;
  } catch {
    throw new Refused("bearer malformed");
  }
}

// The value that becomes the claim is bounded, the token's own or the word it
// maps to, counted in UTF-16 units as the upgrade counts (`length`): never more
// than it takes. A mapped token value need only be one of the map's.
function operationClaim(claims: Record<string, unknown>, from: From, max: number): string {
  const v = claims[from.claim];
  if (typeof v !== "string" || v === "") throw new Refused(`bearer ${from.claim}`);
  if (from.values !== undefined && !Object.hasOwn(from.values, v)) throw new Refused(`bearer ${from.claim}`);
  const claim = from.values === undefined ? v : from.values[v];
  // issuer.cue bounds a mapped word too (#Claim, printable ASCII); an entry that slipped past, or a
  // token's own value outside it, is still no claim the upgrade takes.
  if (typeof claim !== "string" || !/^[ -~]+$/.test(claim) || claim.length > max) throw new Refused(`bearer ${from.claim}`);
  return claim;
}

/**
 * The operation a bearer token of one of `issuers` vouches for, once every
 * check holds; Refused, by its reason, otherwise. `keys` gives an issuer's
 * (issuerKeys, made once per issuer so its cache lasts).
 */
export async function verifyBearer(token: string, p: {
  issuers: readonly Issuer[];
  keys: (issuer: Issuer) => KeySource;
  now?: number;
}): Promise<Operation> {
  const iss = unverifiedIssuer(token);
  const named = p.issuers.filter((i) => i.kind === "bearer" && i.issuer === iss);
  if (named.length > 1) throw new Error(`${named[0].name} and ${named[1].name} name the same issuer`);
  const issuer = named[0];
  if (issuer === undefined) throw new Refused("bearer issuer unknown");
  const claims = await signedClaims(token, issuer.alg, p.keys(issuer), "bearer");
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer.issuer) throw new Refused("bearer issuer");
  // Finite: JSON's 1e400 is Infinity, a number no time is past.
  if (!Number.isFinite(claims.exp) || (claims.exp as number) < now - LEEWAY_S) throw new Refused("bearer expired");
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || (claims.nbf as number) > now + LEEWAY_S)) {
    throw new Refused("bearer not yet valid");
  }
  if (typeof claims.azp !== "string" || !issuer.azp.includes(claims.azp)) throw new Refused("bearer party");
  if (issuer.audience.length > 0) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!issuer.audience.some((a) => aud.includes(a))) throw new Refused("bearer audience");
  }
  for (const [claim, values] of Object.entries(issuer.require)) {
    const v = claims[claim];
    if (typeof v !== "string" || !values.includes(v)) throw new Refused(`bearer ${claim}`);
  }
  return {
    operation_kind: operationClaim(claims, issuer.map.operation_kind, issuer.claimMax),
    operation_id: operationClaim(claims, issuer.map.operation_id, issuer.claimMax),
    amr: [...issuer.amr],
    idp: issuer.name,
  };
}

/**
 * The status a caller answers a failed check with: the token's fault (Refused) is 401, anything else
 * the issuer's (its discovery or keys out of reach), 503, which the client may retry.
 */
export const failureStatus = (e: unknown): 401 | 503 => (e instanceof Refused ? 401 : 503);
