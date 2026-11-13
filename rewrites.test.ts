import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const rewritten = (rewrites: string, targets = "[]") =>
  paymentProgram().replace("    effects: charge:", `    rewrites: ${rewrites}\n    effects: charge:`).replace("targets: []", `targets: ${targets}`);

// The program with its whole emission kept, as an app's own package keeps it:
// a target's refusal is the emitter's, beside the files.
async function refusal(program: string): Promise<string> {
  const res = await cue(["vet", "-c", "-"], `${program}\n_whole: pronto.#emit & {code: app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}\n`);
  assertEquals(res.success, false);
  return res.stderr;
}

Deno.test("a rewrite is the door asking crud for the destination, as /crud itself asks", async () => {
  const files = await emitFiles(rewritten(`{
      "payment-list": {source: "/expense/payments", destination: "/crud/payment_list"}
      "payment-detail": {source: "/expense/payments/:id", destination: "/crud/payment_list?id=eq.:id&select=codigo:id,total::text", methods: ["GET", "HEAD"]}
      "payment-line": {source: "/expense/payments/:id/lines/:idx", destination: "/crud/rpc/payment_line?idx=:idx&id=:id", methods: ["GET"]}
      "payment-approve": {source: "/expense/payments/:id/approve", destination: "/crud/rpc/payment_approve", methods: ["POST"]}
    }`));
  const door = files["docker/Caddyfile"].text;
  assertStringIncludes(door, `  @rewrite_payment_detail {
    method GET HEAD
    path_regexp rewrite_payment_detail ^/expense/payments/([A-Za-z0-9._~-]+)$
  }
  handle @rewrite_payment_detail {
    route {
      @rewrite_payment_detail_post method POST
      request_header @rewrite_payment_detail_post Prefer "return=representation,resolution=ignore-duplicates"
      request_header X-Rewrite-Path {http.request.uri.path}
      rewrite * /payment_list?id=eq.{re.rewrite_payment_detail.1}&select=codigo:id,total::text&{query}
      reverse_proxy {$PRONTO_UPSTREAM_CRUD:crud:3000} {
        header_up dapr-app-id crud
        import bounded-crud
      }
    }
  }
`);
  // No `methods` is every method, and no parameter the request's query alone.
  assertStringIncludes(door, "  @rewrite_payment_list {\n    path_regexp rewrite_payment_list ^/expense/payments$\n  }\n");
  assertStringIncludes(door, "      rewrite * /payment_list?{query}\n");
  // A parameter is placed by its name, wherever the destination puts it; one
  // name beginning another is not it, nor is the column PostgREST's alias
  // names after a colon.
  assertStringIncludes(door, "      rewrite * /rpc/payment_line?idx={re.rewrite_payment_line.2}&id={re.rewrite_payment_line.1}&{query}\n");
  assertStringIncludes(door, "      rewrite * /rpc/payment_approve?{query}\n");
  // Nothing of the request's credential is touched.
  assertEquals(door.includes("request_header -Authorization\n      rewrite"), false);
  // The rewrites stand ahead of the platform's tail, inside the app's door.
  assertEquals(door.indexOf("  @rewrite_payment_detail {") < door.indexOf("  handle /health {"), true);
});

Deno.test("what Next.js's rewrites allow and this subset does not is refused, not ignored", async () => {
  const good = `list: {source: "/expense/payments", destination: "/crud/payment_list"}`;
  for (const [rewrites, targets, error] of [
    // A destination is crud's alone: no other upstream, no other origin.
    [`{list: {source: "/expense/payments", destination: "/auth/session"}}`, "[]", `rewrites.list.destination: invalid value "/auth/session"`],
    [`{list: {source: "/expense/payments", destination: "https://example.com/x"}}`, "[]", `rewrites.list.destination: invalid value`],
    // The door's own paths stay the door's.
    [`{list: {source: "/crud/payment", destination: "/crud/payment_list"}}`, "[]", `rewrites.list.source: invalid value "/crud/payment"`],
    // Wildcards, patterns and conditions.
    [`{list: {source: "/expense/:path*", destination: "/crud/payment_list"}}`, "[]", `rewrites.list.source: invalid value "/expense/:path*"`],
    [`{list: {source: "/expense/:id(\\\\d+)", destination: "/crud/payment_list"}}`, "[]", `rewrites.list.source: invalid value`],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "header", key: "x"}]}}`, "[]", `rewrites.list.has: field not allowed`],
    // A parameter the destination names and the source does not, or names twice.
    [`{list: {source: "/expense/:id", destination: "/crud/payment_list?id=eq.:key"}}`, "[]", "rewrite list: the destination names :key, which the source does not"],
    [`{list: {source: "/expense/:id/:id", destination: "/crud/payment_list"}}`, "[]", "rewrite list: the source names a parameter twice"],
    // One request, two rewrites: parameters are told apart by position alone.
    [`{a: {source: "/expense/:id", destination: "/crud/payment_list"}, b: {source: "/expense/:key", destination: "/crud/payment", methods: ["GET"]}}`, "[]", "rewrites a and b: both answer /expense/:"],
    [`{a: {source: "/expense/payments/:id", destination: "/crud/payment_list"}, b: {source: "/expense/payments/summary", destination: "/crud/payment"}}`, "[]", "rewrites a and b: both answer /expense/payments/summary"],
    // The page and the edge do not apply one yet.
    [`{${good}}`, `["cloudflare"]`, "_rewriteTargets.cloudflare: conflicting values false and true"],
    [`{${good}}`, `["pages"]`, "_rewriteTargets.pages: conflicting values false and true"],
  ]) assertStringIncludes(await refusal(rewritten(rewrites, targets)), error, rewrites);
  // The same path under methods that do not meet is two rewrites.
  await emitFiles(rewritten(`{a: {source: "/expense/:id", destination: "/crud/payment_list", methods: ["GET"]}, b: {source: "/expense/:id", destination: "/crud/payment", methods: ["PATCH", "DELETE"]}}`));
});
