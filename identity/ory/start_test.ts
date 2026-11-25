// deno test --no-config identity/ory/start_test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { start } from "./start.ts";

const hydra = (request_url: string, skip = false) => (async () => Response.json({ request_url, skip })) as unknown as typeof fetch;
const serve = (request_url: string, skip = false) =>
  start({ hydra: "http://hydra.test", kratos: "https://id.test", providers: ["google"], fetcher: hydra(request_url, skip) });
const at = new Request("https://id.test/start?login_challenge=c1");
const flow = "https://id.test/self-service/login/browser?login_challenge=c1";

Deno.test("a reader who chose Google in the app goes straight on to Google's door", async () => {
  // Regression: Ory's pages asked again which way in, after the app's own
  // "Continue with Google" had asked once.
  const res = await serve("https://id.test/oauth2/auth?client_id=a&provider=google")(at);
  assertEquals(res.status, 200);
  const page = await res.text();
  assertStringIncludes(page, JSON.stringify(flow));
  assertStringIncludes(page, `provider: "google"`);
});

Deno.test("a sign-in naming no provider of Kratos's, or one Kratos knows already, goes to Kratos's own flow", async () => {
  for (const res of [
    await serve("https://id.test/oauth2/auth?client_id=a&provider=email")(at),
    await serve("https://id.test/oauth2/auth?client_id=a")(at),
    await serve("https://id.test/oauth2/auth?client_id=a&provider=google", true)(at),
  ]) assertEquals([res.status, res.headers.get("location")], [302, flow]);
});
