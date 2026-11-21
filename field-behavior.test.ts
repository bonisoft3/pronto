// Field behaviour (#Field.outputOnly, #Field.immutable), in Google AIP-203's
// words: what the schema refuses, and what a program stating it emits.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const FAILURE = `{name: "failure", type: "string"},`;
const behaved = (failure: string, extra = "") => paymentProgram().replace(FAILURE, `${failure}${extra}`);

async function refusal(code: string): Promise<string> {
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, false);
  return res.stderr;
}

Deno.test("a field behaviour is no key's, generated field's, retired field's or row machine's state field's, and a field states one", async () => {
  const cases: [string, string][] = [
    [paymentProgram().replace(`{name: "id", type: "uuid", pk: true},`, `{name: "id", type: "uuid", pk: true, immutable: true},`), "entity Payment field id is immutable, and is a primary key"],
    [paymentProgram().replace(`{name: "id", type: "uuid", pk: true},`, `{name: "id", type: "uuid", pk: true, outputOnly: true},`), "entity Payment field id is outputOnly, and is a primary key"],
    [behaved(`{name: "failure", type: "string", retired: true, outputOnly: true},`), "entity Payment field failure is outputOnly, and is retired"],
    [behaved(FAILURE, `\n          {name: "twice", type: "decimal", precision: 12, scale: 2, generated: "total * 2", immutable: true},`), "entity Payment field twice is immutable, and is generated"],
    [behaved(`{name: "failure", type: "string", outputOnly: true, immutable: true},`), "entity Payment field failure is outputOnly and immutable"],
    // A client moves a row machine by writing its state field.
    [paymentProgram().replace(`{name: "status", type: "string"},`, `{name: "status", type: "string", outputOnly: true},`), "machine PaymentMachine field Payment.status is outputOnly and cannot hold transitions: a client moves the machine by writing it"],
    [paymentProgram().replace(`{name: "status", type: "string"},`, `{name: "status", type: "string", immutable: true},`), "machine PaymentMachine field Payment.status is immutable and cannot hold transitions"],
  ];
  for (const [program, why] of cases) assertStringIncludes(await refusal(program), why);
  for (const failure of [`{name: "failure", type: "string", outputOnly: true},`, `{name: "failure", type: "string", immutable: true},`, `{name: "failure", type: "string", outputOnly: false, immutable: false},`]) {
    const res = await cue(["vet", "-c", "-"], behaved(failure));
    assertEquals(res.success, true, `${failure}\n${res.stderr}`);
  }
});

Deno.test("a form names no output-only field, and an update form no immutable one", async () => {
  const form = (action: string, field: string) => `forms: [{id: "f", entity: "Payment", action: "${action}", fields: [{name: "${field}", control: "text"}]}]`;
  const program = (action: string, field: string) => behaved(`{name: "failure", type: "string", outputOnly: true},`, `\n          {name: "code", type: "string", immutable: true},`)
    .replace("forms: []", form(action, field));
  assertStringIncludes(await refusal(program("create", "failure")), "screen board form f writes Payment.failure, which is outputOnly");
  assertStringIncludes(await refusal(program("update", "code")), "screen board form f updates Payment.code, which is immutable");
  for (const action of ["create", "upsert"]) {
    const res = await cue(["vet", "-c", "-"], program(action, "code"));
    assertEquals(res.success, true, `${action}\n${res.stderr}`);
  }
});

Deno.test("a server entity's field behaviour is a trigger of its own step, first of the table's, reapplied at every release", async () => {
  const program = behaved(`{name: "failure", type: "string", required: false, outputOnly: true, default: "'none'"},`, `\n          {name: "code", type: "json", immutable: true},`)
    .replace(`{name: "total", type: "decimal", precision: 12, scale: 2},`, `{name: "total", type: "decimal", precision: 12, scale: 2, outputOnly: true},`);
  const files = await emitFiles(program);
  const step = files["services/database/migrations/799_field_behavior.sql"].text;
  // A client is any role a token names, which authenticator may switch to,
  // but the service; the role the statement runs as says which one wrote, so
  // a SECURITY DEFINER machine's write is its owner's.
  assertStringIncludes(step, `LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$`);
  assertEquals(step.includes("SECURITY DEFINER"), false);
  assertStringIncludes(step, `IF current_user = 'service' OR to_regrole('authenticator') IS NULL THEN\n    RETURN NEW;\n  END IF;\n  IF NOT pg_has_role('authenticator', current_user, 'SET') THEN\n    RETURN NEW;`);
  // An insert takes the default, NULL where the field states none.
  assertStringIncludes(step, `IF TG_OP = 'INSERT' THEN\n    NEW."total" := NULL;\n    NEW."failure" := 'none';\n    RETURN NEW;`);
  assertStringIncludes(step, `  NEW."total" := OLD."total";\n  NEW."failure" := OLD."failure";\n`);
  // A json value has no equality operator, and is compared as the value it states.
  assertStringIncludes(step, `IF NEW."code"::jsonb IS DISTINCT FROM OLD."code"::jsonb THEN
    RAISE EXCEPTION 'payment.code is immutable: it is set when the row is created and never changed' USING ERRCODE = 'invalid_parameter_value';`);
  assertStringIncludes(step, `CREATE TRIGGER "0_payment_field_behavior"\n  BEFORE INSERT OR UPDATE ON "payment"`);
  // The page learns it, for the store and the markup check.
  const fields = files["shell/shell.json"].data.schema.payment.fields as { name: string; outputOnly?: true; immutable?: true }[];
  assertEquals(fields.filter((f) => f.outputOnly).map((f) => f.name), ["total", "failure"]);
  assertEquals(fields.filter((f) => f.immutable).map((f) => f.name), ["code"]);

  const cluster = await cue(["export", "-", "-e", "{migrations: _cluster.state.migrations, reconcile: _cluster.state.reconcile}", "--out", "json"], program);
  assertEquals(cluster.success, true, cluster.stderr);
  const { migrations, reconcile } = JSON.parse(cluster.stdout);
  assertEquals(migrations.includes("services/database/migrations/799_field_behavior.sql"), true);
  assertEquals(reconcile.field_behavior, step.trimEnd());

  // A program stating none emits no step and reconciles nothing for it.
  const plain = await cue(["export", "-", "-e", "{migrations: _cluster.state.migrations, reconcile: _cluster.state.reconcile}", "--out", "json"], paymentProgram());
  assertEquals(plain.success, true, plain.stderr);
  const unchanged = JSON.parse(plain.stdout);
  assertEquals(unchanged.migrations.some((m: string) => m.includes("field_behavior")), false);
  assertEquals("field_behavior" in unchanged.reconcile, false);
});

// A table that states no behaviour has its trigger taken off a database that
// held one, on the reconcile a release runs anyway; with none to ride, none is
// started for it.
Deno.test("a release drops the field behaviour of a table that states none", async () => {
  const audit = `Audit: {table: "audit", durability: "server", fields: [{name: "id", type: "uuid", pk: true}]}`;
  const reconcileOf = async (program: string) => {
    const res = await cue(["export", "-", "-e", "_cluster.state.reconcile", "--out", "json"], program);
    assertEquals(res.success, true, res.stderr);
    return JSON.parse(res.stdout);
  };
  const behavedAudit = await reconcileOf(paymentProgram({ entity: audit }).replace(FAILURE, `{name: "failure", type: "string", outputOnly: true},`));
  assertStringIncludes(behavedAudit.field_behavior, `CREATE TRIGGER "0_payment_field_behavior"`);
  assertStringIncludes(behavedAudit.field_behavior, `FOREACH t IN ARRAY ARRAY['audit']::text[] LOOP`);
  assertEquals(behavedAudit.field_behavior.includes("ARRAY['payment'"), false);
  // Nothing behaved, but a token role makes the release reconcile anyway.
  const riding = await reconcileOf(paymentProgram({ entity: audit }).replace("    effects: charge:", `    tokenRoles: {}\n    effects: charge:`));
  assertStringIncludes(riding.field_behavior, `FOREACH t IN ARRAY ARRAY['payment', 'audit']::text[] LOOP`);
  assertEquals("field_behavior" in await reconcileOf(paymentProgram({ entity: audit })), false);
});

Deno.test("a later entity's migration carries its field behaviour", async () => {
  const program = behaved(`{name: "failure", type: "string", outputOnly: true},`)
    .replace("    entities: {", `    baseline: {entities: [], after: "100"}\n    entities: {`);
  const res = await cue(["export", "-", "-e", "_cluster.state.pgroll", "--out", "json"], program);
  assertEquals(res.success, true, res.stderr);
  const up = JSON.parse(res.stdout)["100_payment"].operations[0].sql.up as string;
  assertStringIncludes(up, `CREATE TRIGGER "0_payment_field_behavior"`);
  assertEquals(up.indexOf(`CREATE TABLE`) < up.indexOf(`"0_payment_field_behavior"`), true);
});
