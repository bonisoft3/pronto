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
      request_header -X-Signal-Path
      request_header -X-Blob-Path
      @rewrite_payment_detail_post method POST
      request_header @rewrite_payment_detail_post Prefer "return=representation,resolution=ignore-duplicates"
      rewrite * /payment_list?id=eq.{re.rewrite_payment_detail.1}&select=codigo:id,total::text&{query}
      reverse_proxy {$PRONTO_UPSTREAM_CRUD:crud:3000} {
        header_up dapr-app-id crud
        header_up X-Forwarded-Method {http.request.orig_method}
        header_up X-Forwarded-Uri {http.request.orig_uri}
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
  // A function takes the destination's query and none of the request's, which
  // it reads from X-Forwarded-Uri; a bare `?` is Caddy's for no query, where a
  // path alone would keep the request's.
  assertStringIncludes(door, "      rewrite * /rpc/payment_line?idx={re.rewrite_payment_line.2}&id={re.rewrite_payment_line.1}\n");
  assertStringIncludes(door, "      rewrite * /rpc/payment_approve?\n");
  // What the client asked is set on the upstream request, where neither its
  // own header nor its Connection reaches: the method it used and the target
  // as it sent it, as forward_auth states them.
  assertEquals(door.match(/        header_up X-Forwarded-Method \{http\.request\.orig_method\}\n        header_up X-Forwarded-Uri \{http\.request\.orig_uri\}\n/g)?.length, 4);
  assertEquals(door.includes("request_header X-Forwarded"), false);
  // PostgREST calls a function by GET or POST alone, so the door asks a PUT,
  // PATCH or DELETE of one as a POST, the method the client used stated beside
  // it; a table or view answers those itself and is asked them as they came.
  assertStringIncludes(door, `      request_header -X-Blob-Path
      @rewrite_payment_approve_call method PUT PATCH DELETE
      method @rewrite_payment_approve_call POST
      @rewrite_payment_approve_post method POST
`);
  assertEquals(door.match(/_call method PUT PATCH DELETE\n/g)?.length, 2);
  assertEquals(door.includes("X-Rewrite-Path"), false);
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
    // A parameter first would answer the door's own /health and the shell's files.
    [`{list: {source: "/:slug", destination: "/crud/payment_list?id=eq.:slug"}}`, "[]", "rewrite list: the source begins with a parameter, and its first segment is a word"],
    // A function called by POST, as a PUT, PATCH or DELETE calls it too, takes no argument from a query; no methods is every one.
    [`{list: {source: "/expense/:id/total", destination: "/crud/rpc/payment_total?id=:id", methods: ["GET", "POST"]}}`, "[]", "rewrite list: a function's destination has a query, which is its arguments under GET and HEAD alone, so its methods name no other; under any other the function reads the path and query from X-Forwarded-Uri"],
    [`{list: {source: "/expense/:id", destination: "/crud/rpc/payment_settle?id=:id", methods: ["DELETE"]}}`, "[]", "rewrite list: a function's destination has a query, which is its arguments under GET and HEAD alone"],
    [`{list: {source: "/expense/:id/sum", destination: "/crud/rpc/payment_total?id=:id"}}`, "[]", "rewrite list: a function's destination has a query, which is its arguments under GET and HEAD alone"],
    // One request, two rewrites: parameters are told apart by position alone.
    [`{a: {source: "/expense/:id", destination: "/crud/payment_list"}, b: {source: "/expense/:key", destination: "/crud/payment", methods: ["GET"]}}`, "[]", "rewrites a and b: both answer /expense/:"],
    [`{a: {source: "/expense/payments/:id", destination: "/crud/payment_list"}, b: {source: "/expense/payments/summary", destination: "/crud/payment"}}`, "[]", "rewrites a and b: both answer /expense/payments/summary"],
    // The page and the edge do not apply one yet.
    [`{${good}}`, `["cloudflare"]`, "_rewriteTargets.cloudflare: conflicting values false and true"],
    [`{${good}}`, `["pages"]`, "_rewriteTargets.pages: conflicting values false and true"],
  ]) assertStringIncludes(await refusal(rewritten(rewrites, targets)), error, rewrites);
  // A function's query is its arguments under GET and HEAD; a function without
  // one answers every method, and a table's query is PostgREST's under every one.
  await emitFiles(rewritten(`{a: {source: "/expense/:id/total", destination: "/crud/rpc/payment_total?id=:id", methods: ["GET", "HEAD"]}, b: {source: "/expense/:id/sum", destination: "/crud/rpc/payment_total"}, c: {source: "/expense/:id", destination: "/crud/payment?id=eq.:id", methods: ["PATCH", "DELETE"]}, d: {source: "/expense/:id/all", destination: "/crud/payment?id=eq.:id"}}`));
  // The same path under methods that do not meet is two rewrites.
  await emitFiles(rewritten(`{a: {source: "/expense/:id", destination: "/crud/payment_list", methods: ["GET"]}, b: {source: "/expense/:id", destination: "/crud/payment", methods: ["PATCH", "DELETE"]}}`));
});
