// The broker's first step of every sign-in, where Hydra sends a reader to log
// in: an app's "Continue with Google" names its provider (`provider=google`,
// as it did to the hand-written broker), so a reader who chose Google there
// goes straight on to Google, not to a page asking again. The page starts
// Kratos's login flow for Hydra's challenge in the browser, which holds the
// flow's CSRF cookie, and posts that provider's method; Kratos answers with
// Google's door. A sign-in naming no provider Kratos signs in with goes to
// Ory's pages, as it would without this step.

export type Start = { hydra: string; kratos: string; providers: readonly string[]; fetcher?: typeof fetch };

type LoginRequest = { request_url: string; skip: boolean };

export function start(p: Start): (req: Request) => Promise<Response> {
  const fetcher = p.fetcher ?? fetch;
  return async (req) => {
    const url = new URL(req.url);
    const challenge = url.searchParams.get("login_challenge");
    if (!challenge) return new Response("login_challenge required", { status: 400 });
    const flow = `${p.kratos}/self-service/login/browser?login_challenge=${encodeURIComponent(challenge)}`;
    const res = await fetcher(`${p.hydra}/admin/oauth2/auth/requests/login?login_challenge=${encodeURIComponent(challenge)}`);
    // The path and status alone: the query carries the live challenge.
    if (!res.ok) throw new Error(`GET /admin/oauth2/auth/requests/login: ${res.status}`);
    const asked = await res.json() as LoginRequest;
    const provider = new URL(asked.request_url).searchParams.get("provider");
    // Signed in already, or no provider of Kratos's named: Kratos's own flow.
    if (asked.skip || provider === null || !p.providers.includes(provider)) {
      return new Response(null, { status: 302, headers: { location: flow, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    const nonce = crypto.randomUUID();
    return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing in</title></head>
<body><noscript><a href="${flow.replaceAll("&", "&amp;")}">Continue</a></noscript>
<script nonce="${nonce}">
(async () => {
  const flow = ${JSON.stringify(flow)};
  const res = await fetch(flow, { headers: { accept: "application/json" }, credentials: "include" });
  const body = await res.json();
  // A reader Kratos already knows is sent on without a provider.
  if (body.redirect_browser_to) return location.assign(body.redirect_browser_to);
  if (!res.ok || !body.ui) return location.assign(flow);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = body.ui.action;
  const fields = { method: "oidc", provider: ${JSON.stringify(provider)}, csrf_token: body.ui.nodes.find((n) => n.attributes.name === "csrf_token").attributes.value };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
})();
</script></body></html>
`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  };
}
