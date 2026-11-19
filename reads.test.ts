// Reads: an external effect that is an HTTP GET, invoked by a state. Entering
// it counts the row's entry and enqueues the request with no claim; only the
// airlock's answer to that entry moves the row; and the nonsense a GET cannot
// mean is refused at vet.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { bridgedReadProgram, cue, emitFiles, paymentProgram, RATE, readProgram } from "./effects-fixtures.ts";

// The hatch `vendor` as an Activepieces runner, whose actions take a POST.
const ACTIVEPIECES = `
app: capabilities: hatches: vendor: activepieces: {
  lock: "./pieces/integrations.lock"
  pieces: rates: {local: "./pieces/rates", export: "rates"}
  actions: quote: {
    piece: "rates", action: "quote"
    inputSchema: "./pieces/rates/quote.input.schema.json"
    outputSchema: "./pieces/rates/quote.output.schema.json"
    fixedProps: {}
    idempotencyKeyProp: "requestKey"
  }
}
`;

async function refusal(code: string): Promise<string> {
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, false, "the program was not refused");
  return res.stderr;
}

Deno.test("entering a read's state counts the entry and enqueues the request with no claim, and only the answer to that entry leaves the state", async () => {
  const files = await emitFiles(readProgram());
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(
    sql,
    `        IF current_setting('role', true) = 'anon' THEN
          RAISE EXCEPTION 'read % is asked by a signed-in writer, and the request names none', 'rate' USING ERRCODE = 'insufficient_privilege';
        END IF;
        NEW."pricings" := coalesce(NEW."pricings", 0) + 1;
        read_input := jsonb_build_object('currency', NEW."failure", 'day', '2026-11-16');
        PERFORM graphile_worker.add_job('external_read', json_build_object('effect', 'rate', 'row', jsonb_build_object('id', NEW."id"), 'n', NEW."pricings", 'incarnation', NEW."lineage", 'key', 'rate:' || NEW."id"::text || ':' || NEW."lineage" || ':' || NEW."pricings", 'input', read_input, 'digest', md5(read_input::text)), max_attempts => 5);`,
  );
  // No ledger row, no idempotency key: a GET is safe.
  assertEquals(sql.includes("external_effect_ledger"), false);
  // The answer is believed only from the airlock's own session, for this row,
  // and for the entry the row still waits on; an earlier entry's is skipped.
  assertStringIncludes(sql, `IF session_user = (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'airlock') THEN\n        outcome := nullif(current_setting('airlock.read', true), '')::jsonb;`);
  assertStringIncludes(sql, `outcome->>'effect' IS DISTINCT FROM 'rate' OR outcome->'row' IS DISTINCT FROM jsonb_build_object('id', OLD."id") OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN`);
  assertStringIncludes(sql, `IF outcome->>'n' IS DISTINCT FROM OLD."pricings"::text OR outcome->>'incarnation' IS DISTINCT FROM OLD."lineage"::text THEN\n        RETURN NULL;`);
  assertStringIncludes(sql, `NEW."failure" := outcome->'data'->>'usd';`);
  // What the request read stays until the answer lands, and so does the row.
  assertStringIncludes(sql, `IF TG_OP = 'UPDATE' AND OLD."status" = 'pricing' AND (OLD."failure" IS DISTINCT FROM NEW."failure" OR OLD."id" IS DISTINCT FROM NEW."id") THEN`);
  assertStringIncludes(sql, `IF OLD."status" IN ('pricing') THEN\n      RAISE EXCEPTION '% in % awaits an outcome and is not deleted'`);
  assertStringIncludes(sql, "BEFORE INSERT OR UPDATE OR DELETE");
  // The count and the incarnation are the machine's: a row starts at zero
  // under a new incarnation, and no write sets either.
  assertStringIncludes(sql, `  IF TG_OP = 'INSERT' THEN\n    NEW."lineage" := gen_random_uuid();\n  ELSIF NEW."lineage" IS DISTINCT FROM OLD."lineage" THEN`);
  assertStringIncludes(sql, `  IF TG_OP = 'INSERT' THEN\n    NEW."pricings" := 0;\n  ELSIF NEW."pricings" IS DISTINCT FROM OLD."pricings" THEN`);
});

Deno.test("the airlock is handed each read's request and where its answer lands, and no handler", async () => {
  const files = await emitFiles(readProgram());
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data, {
    effects: {},
    reads: {
      rate: {
        request: { method: "GET", path: "/rates/{currency}{?day}" },
        invoke: { table: "payment", field: "status", state: "pricing", onDone: "settled", onError: "failed", row: ["id"], count: "pricings", incarnation: "lineage" },
        cacheControl: "max-age=3600",
        got: { retry: { limit: 1 }, timeout: { request: 3000 } },
        credential: { header: "Authorization", scheme: "Bearer", secret: "RATES_KEY" },
      },
    },
  });
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/dapr/rate.yaml"])).data.spec.baseUrl, "https://rates.example");
  assertEquals(files["effects/rate.js"], undefined);
  // A read is asked by a row, so the door has no route to it.
  assertEquals(files["docker/Caddyfile"].text.includes("/read/"), false);
});

Deno.test("a cluster with a read runs its airlock as any effect's, with no handler", async () => {
  const res = await cue(["export", "-", "-e", "_cluster.state.effects", "--out", "json"], readProgram());
  if (!res.success) throw new Error(res.stderr);
  const effects = JSON.parse(res.stdout) as Record<string, unknown>[];
  assertEquals(effects.map((e) => [e.name, e.read, e.handler, e.secrets]), [["rate", true, undefined, ["RATES_KEY"]]]);
  const targets = await cue(["export", "-", "-e", "_build.project.targets", "--out", "json"], readProgram());
  if (!targets.success) throw new Error(targets.stderr);
  const t = JSON.parse(targets.stdout);
  assertEquals(Object.keys(t.airlock.compose.networks).sort(), ["airlock", "airlock-wake"]);
  assertEquals(t.airlock.dockerfile.copy.length, 1, "the manifest alone: a read has no handler");
});

// A bridge is a read's sink as it is a write's: the endpoint is the bridge's
// container, and the manifest says where the airlock finds it deployed.
Deno.test("a read's sink may be a bridge, its own or the one it names for a target, and the airlock is told where the bridge runs", async () => {
  const emitted = async (code: string) => {
    const files = await emitFiles(code);
    return {
      bridge: JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.reads.rate.bridge,
      credential: JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.reads.rate.credential,
      compose: JSON.parse(JSON.stringify(files["services/airlock/dapr/rate.yaml"])).data.spec.baseUrl,
      k8s: JSON.parse(JSON.stringify(files[".pronto/cluster.json"])).data.endpoints.k8s.rate,
    };
  };
  // The vendor's origin everywhere but the compose stack, which calls the
  // bridge's simulator with the same request and the same header.
  assertEquals(await emitted(bridgedReadProgram()), {
    bridge: { name: "rates", targets: ["cloudflare", "k8s"], simulated: true },
    credential: { header: "Authorization", scheme: "Bearer", secret: "RATES_KEY" },
    compose: "http://vendor:3000",
    k8s: "https://rates.example",
  });
  // The bridge as the read's own sink, on every target.
  assertEquals(await emitted(bridgedReadProgram({ sink: `sink: {bridge: "rates"}` })), {
    bridge: { name: "rates", targets: [], simulated: true },
    credential: undefined,
    compose: "http://vendor:3000",
    k8s: "http://vendor:3000",
  });
  // No simulator: the local stack runs no container for it, and the airlock
  // settles the read not deployed there.
  assertEquals((await emitted(bridgedReadProgram({ bridge: `{container: "vendor", port: 3000}` }))).bridge, { name: "rates", targets: ["cloudflare", "k8s"], simulated: false });
  assertEquals(
    (await emitted(bridgedReadProgram({ sink: `sink: {bridge: "rates"}`, bridge: `{container: "vendor", port: 3000, targets: ["k8s"]}` }).replace("targets: []", `targets: ["k8s"]`))).bridge,
    { name: "rates", targets: ["k8s"], simulated: false },
  );
  // An isolate hatch's bridge is handed the request as its module is any.
  const isolate = readProgram({ rate: RATE.replace(/sink: \{.*\}\}/, `sink: {bridge: "rates"}`) }) +
    `\napp: capabilities: hatches: quotes: {kind: "isolate", note: "answers rates from a table", entrypoint: "isolates/quotes/main.ts", files: ["isolates/quotes/main.ts"]}\napp: state: bridges: rates: {isolate: "quotes", simulator: {}}\n`;
  assertEquals((await emitted(isolate)).bridge, { name: "rates", targets: [], simulated: true });
});

Deno.test("a cluster runs a read's bridge as a write's: the daprd waits on its simulator, and the credential it is sent is a fake with a default", async () => {
  const res = await cue(["export", "-", "-e", "_cluster.state.effects", "--out", "json"], bridgedReadProgram());
  if (!res.success) throw new Error(res.stderr);
  const effects = JSON.parse(res.stdout) as Record<string, unknown>[];
  assertEquals(effects.map((e) => [e.name, e.read, e.bridge, e.simulated, e.secrets]), [["rate", true, "rates", true, ["RATES_KEY"]]]);
  const targets = await cue(["export", "-", "-e", "_build.project.targets", "--out", "json"], bridgedReadProgram());
  if (!targets.success) throw new Error(targets.stderr);
  const t = JSON.parse(targets.stdout);
  assertEquals([t.airlock.compose.environment.AIRLOCK_TARGET, t.airlock.compose.environment.RATES_KEY], ["local", "${RATES_KEY:-simulator}"]);
  assertEquals(t["airlock-mesh"].compose.depends_on, { "test-effects-vendor": { condition: "service_started" } });
  assertEquals(Object.keys(t.vendor.compose.networks).sort(), ["airlock-out", "bridge-rates-egress"]);
});

Deno.test("what a GET cannot mean is refused at vet, with the reason", async () => {
  const sink = `sink: {origin: "https://rates.example", credential: {scheme: "Bearer", secret: "RATES_KEY"}}`;
  const refusals: [string, string][] = [
    [readProgram({ rate: RATE.replace(`path: "/rates/{currency}{?day}"`, `path: "/rates/{currency}{?day}", body: {x: 1}`) }), "effect rate is a GET, which carries no body"],
    [readProgram({ rate: RATE.replace("cacheControl:", `note: "safe"\n      cacheControl:`) }), "effect rate is a read and declares note"],
    [readProgram({ rate: RATE.replace("cacheControl:", `attempts: 3\n      cacheControl:`) }), "effect rate is a read and declares attempts"],
    [readProgram({ rate: RATE.replace("cacheControl:", `key: ["id"]\n      cacheControl:`) }), "effect rate is a read and declares key"],
    [readProgram({ rate: RATE.replace("cacheControl:", `reentry: "unknown"\n      cacheControl:`) }), "effect rate is a read and declares reentry"],
    [readProgram({ rate: RATE.replace(sink, sink.replace("}}", "}, idempotent: true}")) }), "effect rate is a read and declares idempotent"],
    [readProgram({ rate: RATE.replace("cacheControl:", `secrets: ["OTHER_KEY"]\n      cacheControl:`) }), "effect rate is a read and declares secrets"],
    [readProgram({ rate: RATE.replace(sink, `sink: {ai: "text"}`) }), "effect rate is a GET on the AI gateway"],
    [bridgedReadProgram({ sink: `sink: {bridge: "rates", credential: {secret: "RATES_KEY"}}` }), "effect rate declares a credential or content type for a sink that is no origin"],
    [bridgedReadProgram({ sink: `sink: {bridge: "rates", idempotent: false}` }), "effect rate is a read and declares idempotent"],
    [bridgedReadProgram({ sink: `sink: {origin: "https://rates.example", targets: docker: bridge: "absent"}` }), "effect rate reaches undeclared bridge: absent"],
    [bridgedReadProgram({ sink: `sink: {bridge: "rates"}`, bridge: `{container: "vendor", action: "quote"}` }) + ACTIVEPIECES, "effect rate is a GET on bridge rates, whose Activepieces action answers only what is posted to it"],
    [bridgedReadProgram({ bridge: `{container: "vendor", action: "quote"}` }) + ACTIVEPIECES, "effect rate is a GET on bridge rates, whose Activepieces action answers only what is posted to it"],
    [readProgram({ rate: RATE.replace(`day: "2026-11-16"`, `day: "2026-11-16", extra: "x"`) }), "effect rate's input extra is sent nowhere"],
    [readProgram({ rate: RATE.replace(`{?day}`, `{?day,limit}`) }), "effect rate's path names limit, which its input does not"],
    [readProgram({ rate: RATE.replace(`"max-age=3600"`, `"private, max-age=3600"`) }), "effect rate declares its answers private"],
    [readProgram({ rate: RATE.replace(`currency: "NEW.failure"`, `currency: "OLD.failure"`) }), "effect rate's input currency reads OLD.failure"],
    [readProgram({ rate: RATE.replace(`currency: "NEW.failure"`, `currency: "NEW.status"`) }), "effect rate's input currency reads NEW.status"],
    [readProgram({ rate: RATE.replace(`currency: "NEW.failure"`, `currency: "NEW.pricings"`) }), "effect rate's input currency reads NEW.pricings"],
    [readProgram({ rate: RATE.replace(`day: "2026-11-16"`, `day: [1]`) }), "effect rate's input day is no string, number or boolean"],
    [readProgram({ count: `{name: "lineage", type: "uuid"},` }), "effect rate counts its entries in pricings, which is no int32 field of Payment"],
    [readProgram({ count: `{name: "pricings", type: "int32"},` }), "effect rate names its row's incarnation lineage, which is no uuid field of Payment"],
    [readProgram({ count: `{name: "pricings", type: "int32"},\n          {name: "lineage", type: "string"},` }), "effect rate names its row's incarnation lineage, which is no uuid field"],
    [readProgram({ rate: RATE.replace(`currency: "NEW.failure"`, `currency: "NEW.lineage"`) }), "effect rate's input currency reads NEW.lineage"],
    [readProgram({ count: `{name: "pricings", type: "string"},\n          {name: "lineage", type: "uuid"},` }), "effect rate counts its entries in pricings, which is no int32 field of Payment"],
    [readProgram({ rate: RATE.replace(`count: "pricings"`, `count: "status"`) }), "effect rate counts its entries in status, which is no int32 field of Payment"],
    [readProgram({ count: `{name: "pricings", type: "int32", generated: "0"},\n          {name: "lineage", type: "uuid"},` }), "effect rate counts its entries in pricings, which is generated"],
    [readProgram({ rate: RATE.replace(`count: "pricings"\n`, "") }), "count"],
    [readProgram().replace("targets: []", `targets: ["cloudflare"]`), "effect rate is a read, which the edge's airlock does not perform"],
    [readProgram({ auth: false }), "effect rate is a read, and the app declares no auth"],
    [readProgram({ rate: `${RATE}\n    ${RATE.replace("rate: {", "spare: {")}` }), "effect spare is invoked by no state"],
    [readProgram({ rate: `${RATE}\n    ${RATE.replace("rate: {", "phased: {")}`, count: `{name: "pricings", type: "int32"},\n          {name: "lineage", type: "uuid"},\n          {name: "phase", type: "string"},` })
      .replace("    mecha: rows: PaymentMachine: {", `    mecha: rows: PhaseMachine: {name: "PhaseMachine", entity: "Payment", field: "phase", initial: "idle", states: {idle: on: check: "checking", checking: invoke: {src: "phased", onDone: "idle", onError: "idle"}}}\n    mecha: rows: PaymentMachine: {`),
      "effects phased and rate count their entries in pricings, and two machines invoke them"],
    [readProgram({ rate: `${RATE}\n    ${RATE.replace("rate: {", "phased: {").replace(`count: "pricings"`, `count: "phasings"`)}`, count: `{name: "pricings", type: "int32"},\n          {name: "phasings", type: "int32"},\n          {name: "lineage", type: "uuid"},\n          {name: "phase", type: "string"},` })
      .replace("    mecha: rows: PaymentMachine: {", `    mecha: rows: PhaseMachine: {name: "PhaseMachine", entity: "Payment", field: "phase", initial: "idle", states: {idle: on: check: "checking", checking: invoke: {src: "phased", onDone: "idle", onError: "idle"}}}\n    mecha: rows: PaymentMachine: {`),
      "effects phased and rate name their row's incarnation in lineage, and two machines invoke them"],
  ];
  const missed = [];
  for (const [code, why] of refusals) {
    const err = await refusal(code);
    if (!err.includes(why)) missed.push(`${why}\n  got: ${err.split("\n")[0]}`);
  }
  assertEquals(missed, []);
});

Deno.test("a read's input may be an expression over the row, whose columns it holds, and /read is any rewrite's", async () => {
  const held = async (day: string) => {
    const sql = (await emitFiles(readProgram({ rate: RATE.replace(`day: "2026-11-16"`, `day: {raw: ${JSON.stringify(day)}}`) })))["services/database/migrations/010_machines.sql"].text;
    return sql.match(/IF TG_OP = 'UPDATE' AND OLD."status" = 'pricing' AND \(([^\n]*)\) THEN/)![1].match(/OLD\."(\w+)"/g)!.map((c) => c.slice(5, -1));
  };
  // No row read: the input's own columns and the key; a string naming none.
  assertEquals(await held("to_char(now(), 'YYYY-MM-DD')"), ["failure", "id"]);
  assertEquals(await held("'new.example'"), ["failure", "id"]);
  // NEW in any case, a name folded or quoted.
  assertEquals(await held(`lower(new.Total::text) || NEW."id"`), ["failure", "id", "total"]);
  // The whole row: every field but the machine's state and count.
  assertEquals(await held("row_to_json(NEW)::text"), ["failure", "id", "total"]);
  const code = paymentProgram().replace("    effects: charge:", `    rewrites: legacy: {source: "/read/:id", destination: "/crud/payment?id=eq.:id"}\n    effects: charge:`);
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, true, res.stderr);
});
