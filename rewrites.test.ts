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
      "payment-by": {source: "/expense/by", methods: ["GET"], has: [{type: "query", key: "column"}], destination: "/crud/payment_list?select=:column"}
      "payment-export": {source: "/exports/:kind", methods: ["GET"], has: [{type: "query", key: "token"}, {type: "query", key: "job.id", value: "(?<job_id>[0-9a-f-]{36})(?:\\\\.(?<ext>pdf|xlsx))?"}, {type: "query", key: "v", value: "2"}], destination: "/crud/rpc/payment_export?kind=:kind&job_id=:job_id&ext=:ext&token=:token"}
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
  // A `has` item is a condition of the matcher: the key's decoded value, there
  // and not empty, matched in full, and the key sent once however it is
  // escaped. A key of letters alone and a value's named groups are placed as
  // the source's parameters are.
  assertStringIncludes(door, "    path_regexp rewrite_payment_export ^/exports/([A-Za-z0-9._~-]+)$\n    expression `path_regexp('rewrite_payment_export_path', r\"^/exports/([A-Za-z0-9._~-]+)$\") && !{http.regexp.rewrite_payment_export_path.1}.matches(");
  assertStringIncludes(door, ") && vars_regexp('rewrite_payment_export_has0', '\\x7bhttp.request.uri.query.token}', r\"(?s)^(.+)$\") && {http.request.uri.query.token} != \"\" && !{http.request.uri.query}.matches(r\"(?:^|&)(?:t|%(?i:74))(?:o|%(?i:6f))(?:k|%(?i:6b))(?:e|%(?i:65))(?:n|%(?i:6e))(?:=[^&]*)?&(?:.*&)?(?:t|%(?i:74))(?:o|%(?i:6f))(?:k|%(?i:6b))(?:e|%(?i:65))(?:n|%(?i:6e))(?:[=&]|$)\") && ");
  assertStringIncludes(door, " && vars_regexp('rewrite_payment_export_has1', '\\x7bhttp.request.uri.query.job.id}', r\"^(?:(?<job_id>[0-9a-f-]{36})(?:\\.(?<ext>pdf|xlsx))?)$\") && ");
  assertStringIncludes(door, "(?:j|%(?i:6a))(?:o|%(?i:6f))(?:b|%(?i:62))(?:\\.|%(?i:2e))(?:i|%(?i:69))(?:d|%(?i:64))(?:[=&]|$)\") && ");
  assertStringIncludes(door, " && vars_regexp('rewrite_payment_export_has2', '\\x7bhttp.request.uri.query.v}', r\"^(?:2)$\") && ");
  assertStringIncludes(door, "      rewrite * /rpc/payment_export?kind={re.rewrite_payment_export.1}&job_id={re.rewrite_payment_export_has1.job_id}&ext={re.rewrite_payment_export_has1.ext}&token={re.rewrite_payment_export_has0.1}\n");
  // What a function's destination places is no PostgREST operand, which would
  // filter what the function returns and leave it uncalled with the value: each
  // parameter of the path and each group placed is held to that, the path's read
  // by the expression's own match of it, and one the destination leaves out is
  // not. A table or view is sent an operand as the filter it is.
  const operand = String.raw`.matches(r"^(?:not\.|in\.|is\.|isdistinct\.|(?:fts|plfts|phfts|wfts)(?:\([\pL0-9_ $]+\))?\.|(?:neq|cs|cd|ov|sl|sr|nxr|nxl|adj)\.|(?:eq|gte|gt|lte|lt|like|ilike|match|imatch)(?:\((?:any|all)\))?\.)")`;
  for (const group of ["rewrite_payment_export_path.1", "rewrite_payment_export_has0.1", "rewrite_payment_export_has1.job_id", "rewrite_payment_export_has1.ext"]) assertStringIncludes(door, ` && !{http.regexp.${group}}${operand}`);
  assertStringIncludes(door, "    path_regexp rewrite_payment_line ^/expense/payments/([A-Za-z0-9._~-]+)/lines/([A-Za-z0-9._~-]+)$\n    expression `path_regexp('rewrite_payment_line_path', r\"^/expense/payments/([A-Za-z0-9._~-]+)/lines/([A-Za-z0-9._~-]+)$\") && !{http.regexp.rewrite_payment_line_path.1}" + operand + " && !{http.regexp.rewrite_payment_line_path.2}" + operand + "`\n  }\n");
  assertEquals(door.split(operand).length - 1, 6);
  assertStringIncludes(door, "      rewrite * /payment_list?select={re.rewrite_payment_by_has0.1}&{query}\n");
  // A function that places no parameter, and a table or view, state no such condition.
  assertEquals(door.match(/    expression `/g)?.length, 3);
  // No backslash stands before a brace in what is emitted: the import of the snippet would take it.
  assertEquals(/\\[{}]/.test(door), false);
  // What the client asked is set on the upstream request, where neither its
  // own header nor its Connection reaches: the method it used and the target
  // as it sent it, as forward_auth states them.
  assertEquals(door.match(/        header_up X-Forwarded-Method \{http\.request\.orig_method\}\n        header_up X-Forwarded-Uri \{http\.request\.orig_uri\}\n/g)?.length, 6);
  assertEquals(door.includes("request_header X-Forwarded"), false);
  // PostgREST calls a function by GET or POST alone, so the door asks a PUT,
  // PATCH or DELETE of one as a POST, the method the client used stated beside
  // it; a table or view answers those itself and is asked them as they came.
  assertStringIncludes(door, `      request_header -X-Blob-Path
      @rewrite_payment_approve_call method PUT PATCH DELETE
      method @rewrite_payment_approve_call POST
      @rewrite_payment_approve_post method POST
`);
  assertEquals(door.match(/_call method PUT PATCH DELETE\n/g)?.length, 3);
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
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", missing: [{type: "query", key: "x"}]}}`, "[]", `rewrites.list.missing: field not allowed`],
    // Of `has`, the query alone, in an expression the door takes and its file reads as one.
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "header", key: "x"}]}}`, "[]", `rewrites.list.has.0.type: conflicting values "query" and "header"`],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "a b"}]}}`, "[]", `invalid value "a b" (out of bound =~"^[A-Za-z0-9_.-]+$")`],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "x", value: "a(?=b)"}]}}`, "[]", "error parsing regexp: invalid or unsupported Perl syntax: `(?=`"],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "x", value: "a\\"b"}]}}`, "[]", `invalid value "a\\"b" (out of bound`],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "x", value: "a{host}"}]}}`, "[]", `invalid value "a{host}" (out of bound`],
    // A brace escaped by a backslash loses it where the door's snippet is imported, and would count what it was to spell.
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "x", value: "a\\\\{2\\\\}b"}]}}`, "[]", `(out of bound`],
    [`{list: {source: "/expense/payments", destination: "/crud/payment_list", has: [{type: "query", key: "x", value: "a\\\\}"}]}}`, "[]", `(out of bound`],
    // A key's own parameter is Next.js's, the key's letters: the refusal says what the source and \`has\` give.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "job_id"}], destination: "/crud/rpc/download?job_id=:job_id"}}`, "[]", "rewrite list: the destination names :job_id, where the source and \`has\` give :jobid"],
    [`{list: {source: "/exports/:kind", methods: ["GET"], has: [{type: "query", key: "page2"}, {type: "query", key: "Token"}, {type: "query", key: "42"}, {type: "query", key: "v", value: "(?<major>[0-9]+)"}], destination: "/crud/rpc/download?page=:page2"}}`, "[]", "rewrite list: the destination names :page2, where the source and \`has\` give :kind, :page, :Token, :major"],
    // A name is given once: Next.js would have the later replace the earlier, \`has\` after the source, unseen.
    [`{list: {source: "/reports/:kind/:id", has: [{type: "query", key: "kind"}], destination: "/crud/payment_list?id=eq.:id"}}`, "[]", "rewrite list: \`has\` and the source both give :kind, where Next.js would have the one of \`has\` replace the source's: name one of them by a group of its value, (?<name>…)"],
    [`{list: {source: "/reports/pdf", has: [{type: "query", key: "page1"}, {type: "query", key: "page2"}], destination: "/crud/payment_list"}}`, "[]", "rewrite list: \`has\` gives :page twice, where Next.js would have the later replace the earlier: name one of them by a group of its value, (?<name>…)"],
    [`{list: {source: "/reports/pdf", has: [{type: "query", key: "job_id"}, {type: "query", key: "jobId", value: "(?<jobid>[0-9]+)"}, {type: "query", key: "job-id"}], destination: "/crud/payment_list"}}`, "[]", "rewrite list: \`has\` gives :jobid twice"],
    [`{list: {source: "/reports/pdf", has: [{type: "query", key: "x", value: "a.*"}, {type: "query", key: "x", value: ".*b"}], destination: "/crud/payment_list"}}`, "[]", "rewrite list: two \`has\` items name the key x, and one item states all a key's value meets"],
    // A key that states a value gives its groups and no parameter of its own.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "job", value: "j-.+"}], destination: "/crud/rpc/download?job_id=:job"}}`, "[]", "rewrite list: the destination names :job, where the source and \`has\` give no parameter"],
    [`{list: {source: "/exports/pdf", has: [{type: "query", key: "x", value: "(?<_job>.+)"}], destination: "/crud/payment_list"}}`, "[]", "rewrite list: a \`has\` value names the group _job, and a parameter is a letter, then letters, digits and _"],
    // A function's argument is one parameter whole: beside other text the value may be PostgREST's filter.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?scope=eq.:token"}}`, "[]", "rewrite list: a function's destination places :token within scope=eq.:token, and a parameter is the whole value of its argument: beside other text PostgREST may read it as a filter on what the function returns"],
    [`{list: {source: "/exports/:kind", methods: ["GET"], destination: "/crud/rpc/payment_rows?scope=:kind.pdf"}}`, "[]", "rewrite list: a function's destination places :kind within scope=:kind.pdf"],
    [`{list: {source: "/exports/:a/:b", methods: ["GET"], destination: "/crud/rpc/payment_rows?scope=:a:b"}}`, "[]", "rewrite list: a function's destination places :a within scope=:a:b"],
    [`{list: {source: "/exports/:a", methods: ["GET"], destination: "/crud/rpc/payment_rows?:a"}}`, "[]", "rewrite list: a function's destination places :a within :a"],
    // Nor is it placed under a key PostgREST keeps for itself, or reads as more than a name.
    ...["select", "columns", "on_conflict", "order", "limit", "offset", "and", "or", "not.and", "not.or", "rows.order", "rows.scope", "scope->a", "sc-ope"].map((key) =>
      [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?${key}=:token"}}`, "[]", `rewrite list: a function's destination places :token under ${key}, which PostgREST does not read as an argument's name`]),
    // PostgREST takes the last of an argument named twice, so a function's destination names each once, as it is read.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?scope=:token&scope=fixed"}}`, "[]", "rewrite list: a function's destination names scope twice, and PostgREST takes the last, so the one before it is never the argument"],
    [`{list: {source: "/exports/pdf", methods: ["GET"], destination: "/crud/rpc/payment_rows?scope=own&asked=x&scope=all"}}`, "[]", "rewrite list: a function's destination names scope twice"],
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?scope=:token&%73cope=fixed"}}`, "[]", "rewrite list: a function's destination writes the key %73cope with an escape, and a key is written as PostgREST reads it, so that one named twice is seen"],
    // A group name is declared once: of two, the door gives the parameter of the one that took no part, empty.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token", value: "(?<token>own)|(?<token>all)"}], destination: "/crud/rpc/payment_rows?scope=:token"}}`, "[]", "rewrite list: a \`has\` value declares the group token more than once, and each group name is declared once: the door would give the parameter of the one that took no part, empty"],
    [`{list: {source: "/exports/pdf", has: [{type: "query", key: "token", value: "(?P<kind>a)(?:-(?<kind>b))?"}], destination: "/crud/payment_list"}}`, "[]", "rewrite list: a \`has\` value declares the group kind more than once"],
    // The parameters a value gives are the groups its expression has, not what reads like one.
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token", value: "[(?<scope>)]"}], destination: "/crud/rpc/payment_rows?scope=:scope"}}`, "[]", "rewrite list: the destination names :scope, where the source and \`has\` give no parameter"],
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token", value: "a\\\\(?<scope>b"}], destination: "/crud/rpc/payment_rows?scope=:scope"}}`, "[]", "rewrite list: the destination names :scope, where the source and \`has\` give no parameter"],
    [`{list: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token", value: "[a\\\\](?<scope>b)]+"}], destination: "/crud/rpc/payment_rows?scope=:scope"}}`, "[]", "rewrite list: the destination names :scope, where the source and \`has\` give no parameter"],
    // Two rewrites of one path and method are refused whatever \`has\` tells them apart: their order is no one's to state.
    [`{a: {source: "/exports/pdf", has: [{type: "query", key: "x"}], destination: "/crud/payment_list"}, b: {source: "/exports/pdf", destination: "/crud/payment"}}`, "[]", "rewrites a and b: both answer /exports/pdf"],
    // A function's arguments from \`has\` are a destination's query like any other, GET and HEAD's alone.
    [`{list: {source: "/exports/pdf", methods: ["POST"], has: [{type: "query", key: "job"}], destination: "/crud/rpc/download?job_id=:job"}}`, "[]", "rewrite list: a function's destination has a query, which is its arguments under GET and HEAD alone"],
    // A parameter the destination names and the source does not, or names twice.
    [`{list: {source: "/expense/:id", destination: "/crud/payment_list?id=eq.:key"}}`, "[]", "rewrite list: the destination names :key, where the source and \`has\` give :id"],
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
  // A group is one wherever the expression has it: after an escaped backslash, beside a class, nested.
  const grouped = (await emitFiles(rewritten(`{a: {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "token", value: "[(]\\\\\\\\(?<scope>b(?P<inner>c)?)"}], destination: "/crud/rpc/payment_rows?scope=:scope&inner=:inner"}}`)))["docker/Caddyfile"].text;
  assertStringIncludes(grouped, "      rewrite * /rpc/payment_rows?scope={re.rewrite_a_has0.scope}&inner={re.rewrite_a_has0.inner}\n");
  // A literal the author writes is the author's, an operand or a reserved key among them, and a table's destination composes as it will.
  await emitFiles(rewritten(`{a: {source: "/exports/:kind", methods: ["GET"], destination: "/crud/rpc/payment_rows?scope=:kind&select=scope&order=scope.desc&asked=eq.all"}, b: {source: "/exports/:kind/list", methods: ["GET"], destination: "/crud/payment_list?status=eq.:kind&or=(id.eq.:kind,status.in.(:kind))&order=:kind"}}`));
  // Next.js's names: a key's letters, its case kept and whatever else it holds dropped, one with no
  // letter giving none.
  const named = (await emitFiles(rewritten(`{
      a: {source: "/exports/:kind", methods: ["GET"], has: [{type: "query", key: "job_id"}, {type: "query", key: "dlToken"}, {type: "query", key: "page2"}, {type: "query", key: "Token"}, {type: "query", key: "42"}], destination: "/crud/rpc/download?job_id=:jobid&token=:dlToken&page=:page&t=:Token&kind=:kind"}
    }`)))["docker/Caddyfile"].text;
  assertStringIncludes(named, "      rewrite * /rpc/download?job_id={re.rewrite_a_has0.1}&token={re.rewrite_a_has1.1}&page={re.rewrite_a_has2.1}&t={re.rewrite_a_has3.1}&kind={re.rewrite_a.1}\n");
  // A brace that counts, and one a class spells, are the expression's as written.
  await emitFiles(rewritten(`{a: {source: "/exports/pdf", has: [{type: "query", key: "x", value: "[0-9a-f]{8}[{][}]\\\\x7B"}], destination: "/crud/payment_list"}}`));
  // The same path under methods that do not meet is two rewrites.
  await emitFiles(rewritten(`{a: {source: "/expense/:id", destination: "/crud/payment_list", methods: ["GET"]}, b: {source: "/expense/:id", destination: "/crud/payment", methods: ["PATCH", "DELETE"]}}`));
});
