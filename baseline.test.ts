import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

// A live database refuses a baseline script whose bytes changed since it ran
// it, and declaring an entity rewrote every one of them: Snapcards' print
// orders could not reach production without resetting it.
const receipt = `
      Receipt: {
        table: "receipt"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "payment_id", type: "uuid"},
          {name: "note", type: "string"},
        ]
        indexes: [{on: "payment_id"}]
      }`;
const baseline = [
  "005_create_tables.sql",
  "006_policies.sql",
  "007_txid.sql",
  "008_publication.sql",
  "010_machines.sql",
].map((name) => `services/database/migrations/${name}`);

Deno.test("an entity outside the baseline leaves the baseline's bytes alone and arrives in its own migration", async () => {
  const before = await emitFiles(paymentProgram());
  const program = paymentProgram({ entity: receipt }) + `\napp: state: baseline: {entities: ["Payment"], after: "20261106"}\n`;
  const after = await emitFiles(program);
  for (const file of baseline) assertEquals(after[file]?.text, before[file]?.text, file);
  // Compose's migrate image copies each pgroll migration from its own file.
  assert("services/database/pgroll/20261106_receipt.json" in after);

  const up = await cue(["export", "-", "-e", `_cluster.state.pgroll["20261106_receipt"].operations[0].sql.up`, "--out", "text"], program);
  assert(up.success, up.stderr);
  for (const part of [
    "CREATE TABLE IF NOT EXISTS receipt (",
    "idx_receipt_payment_id",
    "CREATE TRIGGER restamp_txid BEFORE UPDATE ON receipt",
    "CREATE PUBLICATION electric_publication_default FOR TABLE receipt;",
    "ALTER TABLE receipt REPLICA IDENTITY FULL;",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON receipt TO anon;",
  ]) assertStringIncludes(up.stdout, part);
  // The publications need a WAL reader, which the edge has not.
  assert(up.stdout.indexOf("-- tier: container") < up.stdout.indexOf("CREATE PUBLICATION"));
});

Deno.test("without a baseline every entity is in the baseline scripts and none gets a migration", async () => {
  const program = paymentProgram({ entity: receipt });
  const files = await emitFiles(program);
  assertStringIncludes(files["services/database/migrations/005_create_tables.sql"].text, "CREATE TABLE IF NOT EXISTS receipt (");
  const pgroll = await cue(["export", "-", "-e", `_cluster.state.pgroll`, "--out", "json"], program);
  assert(pgroll.success, pgroll.stderr);
  assertEquals(JSON.parse(pgroll.stdout), {});
});

Deno.test("a baseline names only server entities the program declares", async () => {
  const unknown = await cue(["export", "-", "-e", "out", "--out", "json"], paymentProgram() + `\napp: state: baseline: {entities: ["Payment", "Ledger"], after: "20261106"}\n`);
  assertEquals(unknown.success, false);
});

// Production ran Snapcards' print_order migration, so the order's next fields
// rewrote it under the same name and every later release was refused; and a
// kept copy that the entity silently moved past would leave every database
// without the change.
Deno.test("a released later entity keeps its applied migration, and moves on only by a later one the app acknowledges", async () => {
  const program = (fields = "", extra = "") =>
    paymentProgram({ entity: receipt.replace(`{name: "note", type: "string"},`, `{name: "note", type: "string"},${fields}`) }) +
    `\napp: state: baseline: {entities: ["Payment"], after: "20261106"}\n${extra}`;
  const generated = async (code: string) => {
    const up = await cue(["export", "-", "-e", `_cluster.state.pgroll["20261106_receipt"].operations[0].sql.up`, "--out", "json"], code);
    assert(up.success, up.stderr);
    return JSON.parse(up.stdout) as string;
  };
  const applied = await generated(program());
  const kept = `app: state: migrations: "20261106_receipt": operations: [{sql: {onComplete: true, up: ${JSON.stringify(applied)}}}]\n`;
  // Kept and unchanged: the app's bytes are the emitter's.
  assertEquals(await generated(program("", kept)), applied);

  const moved = `\n          {name: "paid", type: "bool", required: false},`;
  const refused = await cue(["export", "-", "-e", "_cluster.state.pgroll", "--out", "json"], program(moved, kept));
  assertEquals(refused.success, false, "a kept migration the entity moved past");
  assertStringIncludes(refused.stderr, "later entity Receipt changed since its released migration 20261106_receipt");
  const digest = /carried\[\\?"20261106_receipt\\?"\] to \\?"([0-9a-f]{64})/.exec(refused.stderr)?.[1];
  assert(digest, refused.stderr);

  const carrying = `app: state: migrations: "20261107_receipt_paid": operations: [{sql: {up: "ALTER TABLE receipt ADD COLUMN paid boolean;"}}]\n`;
  const unacknowledged = await cue(["export", "-", "-e", "_cluster.state.pgroll", "--out", "json"], program(moved, kept + carrying));
  assertEquals(unacknowledged.success, false, "a carrying migration the app has not acknowledged");
  const acknowledged = `app: state: baseline: carried: "20261106_receipt": "${digest}"\n`;
  assertEquals(await generated(program(moved, kept + carrying + acknowledged)), applied, "the applied bytes stay");

  // A further change refuses again, until a migration carries it too.
  const again = await cue(["export", "-", "-e", "_cluster.state.pgroll", "--out", "json"],
    program(moved + `\n          {name: "memo", type: "string", required: false},`, kept + carrying + acknowledged));
  assertEquals(again.success, false, "a change past the acknowledged one");
});
