// A token for a declared token role on a local launch, which trusts no
// issuer: signed with the stack's development secret, as the cluster's own
// development service token is (mecha's #DevServiceJwt), so a function a
// declared role alone may execute can be called without an issuer.
//
//   deno run --allow-read --allow-env dev-token.ts residual_bot [app dir]
//
// It signs with that secret and no other: a stack given its own
// PGRST_JWT_SECRET, every release, refuses what this makes, and this
// refuses to sign with it. A declared role is another issuer's, so the
// token names an issuer of its own, ISSUER, never the stack's, and crud's
// audience, TRUSTED_AUDIENCE or the origin's /crud; and a role the app's
// .pronto/cluster.json declares.
//
//   deno run --allow-read --allow-env dev-token.ts residual_bot [app dir] [audience]

/** mecha's _devJwtSecret, the default every development stack's crud verifies by. */
export const DEV_SECRET = "mecha-dev-secret-please-override-32ch";
/** The issuer a dev token names: another than the stack's (mecha's STACK_ISSUER). */
export const ISSUER = "mecha:dev-token";

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export async function devToken(role: string, declared: readonly string[], audience: string, secret = DEV_SECRET, now = Date.now()): Promise<string> {
  if (!audience) throw new Error("no audience: give crud's, TRUSTED_AUDIENCE or the origin's /crud");
  if (secret !== DEV_SECRET) throw new Error("PGRST_JWT_SECRET is not the development secret: a dev token is for a local launch alone");
  if (!declared.includes(role)) throw new Error(`${role} is no token role the app declares (state.tokenRoles): ${declared.join(", ") || "none"}`);
  const text = new TextEncoder();
  const part = (v: unknown) => base64url(text.encode(JSON.stringify(v)));
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: ISSUER, aud: audience, role, sub: role, exp: Math.floor(now / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(body))))}`;
}

if (import.meta.main) {
  const [role, dir = ".", given] = Deno.args;
  if (!role) throw new Error("usage: dev-token.ts <role> [app dir] [audience]");
  const facts = JSON.parse(await Deno.readTextFile(`${dir}/.pronto/cluster.json`));
  const origin = Deno.env.get("ORIGIN");
  const audience = given || Deno.env.get("TRUSTED_AUDIENCE") || (origin ? `${origin}/crud` : "");
  console.log(await devToken(role, facts.declaredRoles ?? [], audience, Deno.env.get("PGRST_JWT_SECRET") || DEV_SECRET));
}
