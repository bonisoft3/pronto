// The consent step answers from the identity Hydra's request names, whatever
// the browser holds. deno test --no-config --allow-net identity/ory/consent_test.ts
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { claimsOf, consent } from "./consent.ts";

/** Hydra's and Kratos's admin APIs, as far as consent reaches them. */
function admins(
  asked: {
    subject: string;
    subject_type?: string;
    sector_identifier_uri?: string;
    skip_consent?: boolean;
    scope: string[];
    redirect_uris?: string[];
    client_name?: string;
    logo_uri?: string;
    metadata?: { brand?: unknown };
  },
  trustedOrigins: string[] = [],
  publicOrigin?: string,
) {
  const answered: { verdict: string; body: Record<string, unknown> }[] = [];
  const registered: Record<string, unknown>[] = [];
  const identities: Record<string, unknown> = {
    ada: { traits: { email: "ada@example.test", name: "Ada" }, verifiable_addresses: [{ value: "ada@example.test", verified: true }] },
    eve: { traits: { email: "eve@example.test", name: "Eve" }, verifiable_addresses: [{ value: "eve@example.test", verified: true }] },
  };
  const client = {
    subject_type: asked.subject_type ?? "pairwise",
    sector_identifier_uri: asked.sector_identifier_uri,
    skip_consent: asked.skip_consent,
    redirect_uris: asked.redirect_uris,
    client_name: asked.client_name,
    logo_uri: asked.logo_uri,
    metadata: asked.metadata,
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/admin/oauth2/auth/requests/consent") {
      return Response.json({ subject: asked.subject, requested_scope: asked.scope, requested_access_token_audience: [], client });
    }
    if (url.pathname === "/admin/oauth2/auth/requests/login") {
      return Response.json({ client });
    }
    const verdict = url.pathname.match(/\/consent\/(accept|reject)$/)?.[1];
    if (verdict) {
      answered.push({ verdict, body: JSON.parse(String(init?.body)) });
      return Response.json({ redirect_to: `https://broker.test/after-${verdict}` });
    }
    if (url.pathname === "/admin/clients" && init?.method === "POST") {
      registered.push(JSON.parse(String(init.body)));
      return Response.json({ client_id: `reg-${registered.length}` }, { status: 201 });
    }
    const id = url.pathname.match(/^\/admin\/identities\/(.+)$/)?.[1];
    if (id && identities[id]) return Response.json(identities[id]);
    if (url.href === "https://snapcards.bonisoft3.com/shell/favicon.svg") {
      return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8" } });
    }
    if (url.href === "https://snapcards.bonisoft3.com/custom.png") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("unknown", { status: 404 });
  }) as typeof fetch;
  const trusted = (origin: string) => Promise.resolve(trustedOrigins.includes(origin));
  return { serve: consent({ hydra: "http://hydra.test", kratos: "http://kratos.test", publicOrigin, fetcher, trusted }), answered, registered };
}

Deno.test("an app is given the address and name of the identity the login was accepted for, as its scopes ask", async () => {
  const { serve, answered } = admins({ subject: "ada", skip_consent: true, scope: ["openid", "email", "profile"], redirect_uris: ["https://app.test/auth/oidc/email/callback"] });
  // Regression: Ory's UI read the claims from the browser's session cookie,
  // so a reader who switched to another account mid-flow carried that one's
  // address in; this step reads no cookie at all.
  const res = await serve(new Request("https://consent.test/consent?consent_challenge=c1", { headers: { cookie: "ory_kratos_session=eve's" } }));
  assertEquals([res.status, res.headers.get("location")], [302, "https://broker.test/after-accept"]);
  assertEquals(answered[0].body.session, { id_token: { email: "ada@example.test", email_verified: true, name: "Ada" } });
  assertEquals(answered[0].body.grant_scope, ["openid", "email", "profile"]);
});

Deno.test("an app whose origin the operator's TXT record vouches for is told the address without a word", async () => {
  const { serve, answered } = admins({ subject: "ada", scope: ["openid", "email"], redirect_uris: ["https://app.test/auth/oidc/email/callback"] }, ["https://app.test"]);
  const res = await serve(new Request("https://consent.test/consent?consent_challenge=c1"));
  assertEquals(res.headers.get("location"), "https://broker.test/after-accept");
  assertEquals(answered[0].body.session, { id_token: { email: "ada@example.test", email_verified: true } });
});

Deno.test("any other app is named to the person, refuses GET mutation, requires POST + CSRF, and tells it only a subject of its own", async () => {
  // Registration is open to anyone, as the hand-written broker served anyone:
  // an app no record vouches for never learns the address.
  const { serve, answered } = admins({ subject: "ada", scope: ["openid", "email", "profile"], redirect_uris: ["https://stranger.test/auth/oidc/email/callback"] });
  const asked = await serve(new Request("https://consent.test/consent?consent_challenge=c1&go=1"));
  assertEquals(asked.status, 200);
  const text = await asked.text();
  assertEquals([text.includes("stranger.test"), text.includes("ada@example.test"), text.includes('<form method="post" action="/consent">')], [true, false, true]);
  assertEquals(answered, []);

  const cookie = asked.headers.get("set-cookie")?.split(";")[0] ?? "";
  assertEquals(/^__Host-broker_consent_csrf_[A-Za-z0-9_-]{16}=/.test(cookie), true);
  const csrf = text.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";
  assertEquals(csrf.length > 0, true);

  // Missing cookie, wrong CSRF token, or foreign Origin are refused.
  const noCookie = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    body: new URLSearchParams({ consent_challenge: "c1", csrf, go: "1" }),
  }));
  assertEquals(noCookie.status, 403);
  const badCsrf = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ consent_challenge: "c1", csrf: "wrong", go: "1" }),
  }));
  assertEquals(badCsrf.status, 403);
  const foreignOrigin = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie, origin: "https://evil.test" },
    body: new URLSearchParams({ consent_challenge: "c1", csrf, go: "1" }),
  }));
  assertEquals(foreignOrigin.status, 403);
  assertEquals(answered, []);

  const went = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie, origin: "https://consent.test" },
    body: new URLSearchParams({ consent_challenge: "c1", csrf, go: "1" }),
  }));
  assertEquals(went.headers.get("location"), "https://broker.test/after-accept");
  assertEquals(went.headers.get("set-cookie")?.includes("Max-Age=0"), true);
  assertEquals(answered[0].body, { grant_scope: ["openid"], grant_access_token_audience: [] });
});

Deno.test("a client whose callbacks span origins is refused, since no one origin answers for it", async () => {
  // Regression: registration takes callbacks on any hosts, so one on a
  // vouched-for origin beside one of the registrant's own would carry the
  // address to the registrant.
  const { serve, answered } = admins({ subject: "ada", scope: ["openid", "email"], redirect_uris: ["https://app.test/cb", "https://evil.test/cb"] }, ["https://app.test"]);
  const res = await serve(new Request("https://consent.test/consent?consent_challenge=c1&go=1"));
  assertEquals(res.headers.get("location"), "https://broker.test/after-reject");
  assertEquals(answered.map((a) => a.verdict), ["reject"]);

  const firstPartyMulti = admins({ subject: "ada", skip_consent: true, scope: ["openid", "email"], redirect_uris: ["https://app.test/cb", "https://evil.test/cb"] });
  const fpRes = await firstPartyMulti.serve(new Request("https://consent.test/consent?consent_challenge=c2"));
  assertEquals(fpRes.headers.get("location"), "https://broker.test/after-reject");
  assertEquals(firstPartyMulti.answered.map((a) => a.verdict), ["reject"]);
});

Deno.test("claims follow the scopes, and an address is verified only where Kratos says so", () => {
  const identity = { traits: { email: "ada@example.test", name: "Ada" }, verifiable_addresses: [{ value: "ada@example.test", verified: false }] };
  assertEquals(claimsOf(identity, ["openid"]), {});
  assertEquals(claimsOf(identity, ["openid", "email"]), { email: "ada@example.test", email_verified: false });
  assertEquals(claimsOf(identity, ["openid", "profile"]), { name: "Ada" });
});

Deno.test("/broker-api/brand trusts DCR brand only for skip_consent clients and falls back to host for open-DCR and untrusted clients", async () => {
  const firstParty = admins({
    subject: "ada",
    skip_consent: true,
    scope: ["openid", "email"],
    redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
    client_name: "Snapcards",
    logo_uri: "https://snapcards.bonisoft3.com/shell/favicon.svg",
    metadata: { brand: { colors: { accent: "#B45309", bad: "url(evil)" } } },
  });
  const resFirstParty = await firstParty.serve(new Request("https://consent.test/broker-api/brand?login_challenge=lc1"));
  assertEquals(resFirstParty.status, 200);
  assertEquals(await resFirstParty.json(), {
    trusted: true,
    origin: "https://snapcards.bonisoft3.com",
    brand: {
      name: "Snapcards",
      logo: "/broker-api/logo?login_challenge=lc1",
      colors: { accent: "#B45309" },
    },
  });

  const openDcrTrusted = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
    client_name: "Spoofed Name",
    logo_uri: "https://snapcards.bonisoft3.com/shell/favicon.svg",
    metadata: { brand: { colors: { accent: "#000000" } } },
  }, ["https://snapcards.bonisoft3.com"]);
  const resOpenTrusted = await openDcrTrusted.serve(new Request("https://consent.test/broker-api/brand?login_challenge=lc2"));
  assertEquals(resOpenTrusted.status, 200);
  assertEquals(await resOpenTrusted.json(), {
    trusted: true,
    origin: "https://snapcards.bonisoft3.com",
    brand: { name: "snapcards.bonisoft3.com" },
  });

  // Arbitrary callback paths or query strings on a TXT-vouched origin cannot gain trusted auto-consent.
  for (const redirect_uris of [
    ["https://snapcards.bonisoft3.com/open-redirect"],
    ["https://snapcards.bonisoft3.com/auth/oidc/email/callback?next=evil"],
  ]) {
    const arbitraryPath = admins({
      subject: "ada",
      scope: ["openid", "email"],
      redirect_uris,
    }, ["https://snapcards.bonisoft3.com"]);
    const brandRes = await arbitraryPath.serve(new Request("https://consent.test/broker-api/brand?login_challenge=lc_bad"));
    assertEquals(brandRes.status, 200);
    assertEquals((await brandRes.json()).trusted, false);
    const consentRes = await arbitraryPath.serve(new Request("https://consent.test/consent?consent_challenge=c_bad"));
    assertEquals(consentRes.status, 200);
    const consentHtml = await consentRes.text();
    assertEquals([consentHtml.includes("snapcards.bonisoft3.com"), consentHtml.includes("ada@example.test")], [true, false]);
    assertEquals(arbitraryPath.answered, []);
  }

  const untrusted = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://stranger.test/auth/oidc/email/callback"],
    client_name: "Fake Google",
    logo_uri: "https://stranger.test/logo.svg",
    metadata: { brand: { colors: { accent: "#000000" } } },
  });
  const resUntrusted = await untrusted.serve(new Request("https://consent.test/broker-api/brand?login_challenge=lc3"));
  assertEquals(resUntrusted.status, 200);
  assertEquals(await resUntrusted.json(), {
    trusted: false,
    origin: "https://stranger.test",
    brand: { name: "stranger.test" },
  });

  const missing = await firstParty.serve(new Request("https://consent.test/broker-api/brand"));
  assertEquals(missing.status, 400);
});

Deno.test("/broker-api/logo proxies verified same-origin logos with sandbox CSP, requires src for open-DCR, and refuses cross-origin or untrusted clients", async () => {
  const firstParty = admins({
    subject: "ada",
    skip_consent: true,
    scope: ["openid", "email"],
    redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
    client_name: "Snapcards",
    logo_uri: "https://snapcards.bonisoft3.com/shell/favicon.svg",
  });

  const def = await firstParty.serve(new Request("https://consent.test/broker-api/logo?login_challenge=lc1"));
  assertEquals(def.status, 200);
  assertEquals(def.headers.get("content-type"), "image/svg+xml");
  assertEquals(def.headers.get("cache-control"), "no-store");
  assertEquals(def.headers.get("x-content-type-options"), "nosniff");
  assertEquals(def.headers.get("content-security-policy"), "sandbox");
  assertEquals(await def.text(), "<svg/>");

  const openDcrTrusted = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
    client_name: "Spoofed Name",
    logo_uri: "https://snapcards.bonisoft3.com/shell/favicon.svg",
  }, ["https://snapcards.bonisoft3.com"]);

  const openDcrDefault = await openDcrTrusted.serve(new Request("https://consent.test/broker-api/logo?login_challenge=lc1"));
  assertEquals(openDcrDefault.status, 404);

  const custom = await openDcrTrusted.serve(new Request(
    `https://consent.test/broker-api/logo?login_challenge=lc1&src=${encodeURIComponent("https://snapcards.bonisoft3.com/custom.png")}`,
  ));
  assertEquals(custom.status, 200);
  assertEquals(custom.headers.get("content-type"), "image/png");
  assertEquals(new Uint8Array(await custom.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const crossOrigin = await openDcrTrusted.serve(new Request(
    `https://consent.test/broker-api/logo?login_challenge=lc1&src=${encodeURIComponent("https://evil.test/logo.png")}`,
  ));
  assertEquals(crossOrigin.status, 404);

  const untrusted = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://stranger.test/auth/oidc/email/callback"],
    logo_uri: "https://stranger.test/logo.png",
  });
  const refused = await untrusted.serve(new Request("https://consent.test/broker-api/logo?login_challenge=lc2"));
  assertEquals(refused.status, 404);
  const refusedSrc = await untrusted.serve(new Request(
    `https://consent.test/broker-api/logo?login_challenge=lc2&src=${encodeURIComponent("https://stranger.test/logo.png")}`,
  ));
  assertEquals(refusedSrc.status, 404);
});

Deno.test("consent rejects non-pairwise clients and supports Cancel (go=0) on untrusted apps", async () => {
  const pub = admins({
    subject: "ada",
    subject_type: "public",
    scope: ["openid", "email"],
    redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
  }, ["https://snapcards.bonisoft3.com"]);
  const rejected = await pub.serve(new Request("https://consent.test/consent?consent_challenge=c1"));
  assertEquals(rejected.headers.get("location"), "https://broker.test/after-reject");
  assertEquals(pub.answered[0].verdict, "reject");

  const stranger = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://stranger.test/auth/oidc/email/callback"],
  });
  const prompt = await stranger.serve(new Request("https://consent.test/consent?consent_challenge=c1"));
  const html = await prompt.text();
  const cookie = prompt.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";
  assertEquals(html.includes('name="go" value="0"'), true);
  const cancelled = await stranger.serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie, origin: "https://consent.test" },
    body: new URLSearchParams({ consent_challenge: "c1", csrf, go: "0" }),
  }));
  assertEquals(cancelled.headers.get("location"), "https://broker.test/after-reject");
  assertEquals(cancelled.headers.get("set-cookie")?.includes("Max-Age=0"), true);
  assertEquals(stranger.answered[0].verdict, "reject");
});

Deno.test("/broker-api/logo cancels oversized streamed logos before buffering the full response", async () => {
  let pulls = 0;
  let cancelled = false;
  const fetcher = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/admin/oauth2/auth/requests/login") {
      return Promise.resolve(Response.json({
        client: {
          subject_type: "pairwise",
          skip_consent: true,
          redirect_uris: ["https://snapcards.bonisoft3.com/auth/oidc/email/callback"],
          logo_uri: "https://snapcards.bonisoft3.com/huge.png",
        },
      }));
    }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() {
        cancelled = true;
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "image/png" } }));
  }) as typeof fetch;

  const { consent } = await import("./consent.ts");
  const serve = consent({ hydra: "http://hydra.test", kratos: "http://kratos.test", fetcher, trusted: () => Promise.resolve(true) });
  const res = await serve(new Request("https://consent.test/broker-api/logo?login_challenge=lc1"));
  assertEquals(res.status, 502);
  assertEquals(cancelled, true);
  assertEquals(pulls, 3);
});

Deno.test("publicOrigin validates HTTPS browser Origin and Secure cookies even when reverse proxy forwards http", async () => {
  const { serve, answered } = admins(
    { subject: "ada", scope: ["openid", "email"], redirect_uris: ["https://stranger.test/auth/oidc/email/callback"] },
    [],
    "https://id.bonisoft3.com",
  );
  const getRes = await serve(new Request("http://127.0.0.1:4456/consent?consent_challenge=c_proxy", {
    headers: { host: "id.bonisoft3.com", "x-forwarded-proto": "http" },
  }));
  assertEquals(getRes.status, 200);
  const setCookie = getRes.headers.get("set-cookie") ?? "";
  assertEquals([setCookie.startsWith("__Host-broker_consent_csrf_"), setCookie.includes("; Secure;")], [true, true]);
  const cookie = setCookie.split(";")[0];
  const html = await getRes.text();
  const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";

  const wrongScheme = await serve(new Request("http://127.0.0.1:4456/consent", {
    method: "POST",
    headers: { host: "id.bonisoft3.com", "x-forwarded-proto": "http", cookie, origin: "http://id.bonisoft3.com" },
    body: new URLSearchParams({ consent_challenge: "c_proxy", csrf, go: "1" }),
  }));
  assertEquals(wrongScheme.status, 403);
  assertEquals(answered, []);

  const okPost = await serve(new Request("http://127.0.0.1:4456/consent", {
    method: "POST",
    headers: { host: "id.bonisoft3.com", "x-forwarded-proto": "http", cookie, origin: "https://id.bonisoft3.com" },
    body: new URLSearchParams({ consent_challenge: "c_proxy", csrf, go: "1" }),
  }));
  assertEquals([okPost.status, okPost.headers.get("location")], [302, "https://broker.test/after-accept"]);
  assertEquals(answered.length, 1);
});

Deno.test("consent rejects clients that set sector_identifier_uri and brand excludes them", async () => {
  const { serve, answered } = admins(
    {
      subject: "ada",
      sector_identifier_uri: "https://evil.test/sector.json",
      skip_consent: true,
      scope: ["openid", "email"],
      redirect_uris: ["https://app.test/auth/oidc/email/callback"],
    },
    ["https://app.test"],
  );
  const brandRes = await serve(new Request("https://consent.test/broker-api/brand?login_challenge=lc_sec"));
  assertEquals((await brandRes.json()).trusted, false);
  const res = await serve(new Request("https://consent.test/consent?consent_challenge=c_sec"));
  assertEquals(res.headers.get("location"), "https://broker.test/after-reject");
  assertEquals(answered.map((a) => a.verdict), ["reject"]);
});

Deno.test("two concurrent consent challenges keep independent CSRF cookies", async () => {
  const { serve, answered } = admins({
    subject: "ada",
    scope: ["openid", "email"],
    redirect_uris: ["https://stranger.test/auth/oidc/email/callback"],
  });
  const get1 = await serve(new Request("https://consent.test/consent?consent_challenge=tab1"));
  const get2 = await serve(new Request("https://consent.test/consent?consent_challenge=tab2"));
  const cookie1 = (get1.headers.get("set-cookie") ?? "").split(";")[0];
  const cookie2 = (get2.headers.get("set-cookie") ?? "").split(";")[0];
  const csrf1 = (await get1.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";
  const csrf2 = (await get2.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";
  const jar = `${cookie1}; ${cookie2}`;

  const post1 = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie: jar, origin: "https://consent.test" },
    body: new URLSearchParams({ consent_challenge: "tab1", csrf: csrf1, go: "1" }),
  }));
  const post2 = await serve(new Request("https://consent.test/consent", {
    method: "POST",
    headers: { cookie: jar, origin: "https://consent.test" },
    body: new URLSearchParams({ consent_challenge: "tab2", csrf: csrf2, go: "1" }),
  }));
  assertEquals([post1.status, post2.status, answered.length], [302, 302, 2]);
});

Deno.test("/broker-api/register creates only public pairwise non-skip-consent clients and rejects dangerous fields before Hydra", async () => {
  const { serve, registered } = admins({ subject: "ada", scope: ["openid"], redirect_uris: ["https://app.test/auth/oidc/email/callback"] });
  const ok = await serve(new Request("https://consent.test/broker-api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "My App",
      logo_uri: "https://app.test/logo.svg",
      redirect_uris: ["https://app.test/auth/oidc/email/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid email profile",
      subject_type: "pairwise",
    }),
  }));
  assertEquals(ok.status, 201);
  assertEquals(await ok.json(), { client_id: "reg-1" });
  assertEquals(registered[0], {
    client_name: "My App",
    logo_uri: "https://app.test/logo.svg",
    redirect_uris: ["https://app.test/auth/oidc/email/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "openid email profile",
    subject_type: "pairwise",
    skip_consent: false,
  });

  for (const bad of [
    { redirect_uris: ["https://app.test/auth/oidc/email/callback"], sector_identifier_uri: "https://127.0.0.1/sec.json" },
    { redirect_uris: ["https://app.test/auth/oidc/email/callback"], skip_consent: true },
    { redirect_uris: ["https://app.test/auth/oidc/email/callback"], metadata: { brand: {} } },
    { redirect_uris: ["https://app.test/auth/oidc/email/callback"], token_endpoint_auth_method: "client_secret_basic" },
    { redirect_uris: ["https://app.test/auth/oidc/email/callback"], subject_type: "public" },
    { redirect_uris: ["http://localhost:8080/cb"] },
    { redirect_uris: ["https://a.test/cb", "https://b.test/cb"] },
  ]) {
    const res = await serve(new Request("https://consent.test/broker-api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bad),
    }));
    assertEquals(res.status, 400);
  }
  assertEquals(registered.length, 1);
});
