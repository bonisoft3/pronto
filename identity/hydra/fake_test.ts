// The stand-in for Google speaks the code flow the front's leg needs: a test
// person picked on its page comes back as a code, which redeems once, with
// the client's secret and redirect, for an ID token the front verifies.
import { randomToken, verifyIdToken } from "../oidc.ts";
import { fakeGoogle } from "./fake.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const ISSUER = "http://localhost:28443";
const REDIRECT = `${ISSUER}/callback/google`;

Deno.test("the fake Google signs in the test person picked, once", async () => {
  const { provider, handle } = await fakeGoogle(ISSUER);
  const call = async (url: string, init?: RequestInit) => (await handle(new Request(url, init), new URL(url)))!;
  const nonce = randomToken(8), state = randomToken(8);
  const q = new URLSearchParams({ client_id: provider.clientId, redirect_uri: REDIRECT, response_type: "code", scope: "openid", state, nonce });
  const shown = await call(`${provider.authUrl}?${q}`);
  const html = await shown.text();
  assertEquals(html.includes("This is not Google"), true, "says what it is");
  const approve = html.match(/href="([^"]+who=tester-2)"/)![1].replace(/&#38;/g, "&");
  const back = new URL((await call(approve)).headers.get("location")!);
  assertEquals([`${back.origin}${back.pathname}`, back.searchParams.get("state")], [REDIRECT, state]);
  const redeem = () => call(provider.tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: provider.clientId, client_secret: provider.clientSecret, redirect_uri: REDIRECT }),
  });
  const t = await redeem();
  assertEquals(t.status, 200);
  const claims = await verifyIdToken((await t.json()).id_token, { alg: "RS256", issuers: provider.issuers, audience: provider.clientId, nonce, keys: provider.keys });
  assertEquals(claims.sub, "tester-2");
  assertEquals((await redeem()).status, 400, "a code redeems once");
  const again = await call(approve);
  assertEquals(again.status, 400, "an approval is spent once");
  await again.body?.cancel();
});
