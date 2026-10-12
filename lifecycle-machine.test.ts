import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const lifecycle = `
app: state: machines: PaymentRules: {
  entity: "Payment"
  guards: positive: {
    src: "shell/validations/positive.js"
    note: "payments have positive totals"
    edges: []
    module: {statements: "", completion: "(state, event) => event.row.total > 0"}
  }
  on: {
    insert: guard: "positive"
    update: {guard: ["positive"], actions: {raise: {notify: "payments", payload: "NEW.id::text"}}}
  }
}
`;

Deno.test("lifecycle guards derive the entity's operation-specific predicates", async () => {
  const result = await cue(["export", "-", "-e", "app.state.entities.Payment.validations", "--out", "json"], paymentProgram() + lifecycle);
  assertEquals(result.success, true, result.stderr);
  const guards = JSON.parse(result.stdout);
  assertEquals(guards.positive.machine, "PaymentRules");
  assertEquals(guards.positive.on, ["insert", "update"]);
});

Deno.test("the lifecycle interpreter checks guards before relational actions", async () => {
  const files = await emitFiles(paymentProgram() + lifecycle);
  const predicates = files["services/database/migrations/009_validations.sql"].text;
  const machines = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(predicates, "DROP TRIGGER IF EXISTS payment_validate");
  assertEquals(predicates.includes("CREATE TRIGGER payment_validate"), false);
  const update = machines.slice(machines.indexOf('CREATE OR REPLACE FUNCTION "trg_payment_PaymentRules_reducer"'));
  assertStringIncludes(update, "payment_validation_positive");
  assertEquals(update.indexOf("payment_validation_positive") < update.indexOf("pg_notify"), true);
  assertStringIncludes(update, "AFTER INSERT OR UPDATE OR DELETE");
});

Deno.test("lifecycle guards refuse missing ownership, unsafe timing and unused declarations", async () => {
  for (const program of [
    paymentProgram() + lifecycle.replace('insert: guard: "positive"', 'insert: guard: "missing"'),
    paymentProgram() + lifecycle + '\napp: state: machines: PaymentRules: timing: "BEFORE"',
    paymentProgram() + lifecycle.replaceAll('guard: "positive"', 'actions: {}').replace('guard: ["positive"], ', ''),
    paymentProgram() + '\napp: state: entities: Payment: validations: orphan: {src: "predicate.js", note: "unowned"}',
    paymentProgram() + lifecycle + '\napp: state: machines: PaymentRules: on: insert: actions: assign: total: 1',
  ]) {
    const result = await cue(["export", "-", "-e", "out", "--out", "json"], program);
    assertEquals(result.success, false, program);
  }
});

Deno.test("browser lifecycle guards inherit durability and emit no SQL interpreter", async () => {
  const program = paymentProgram({ entity: 'Draft: {table: "draft", durability: "tab", fields: [{name: "id", type: "uuid", pk: true}]}' }) + lifecycle.replace('entity: "Payment"', 'entity: "Draft"').replace(', actions: {raise: {notify: "payments", payload: "NEW.id::text"}}', '');
  const files = await emitFiles(program);
  assertEquals(files["services/database/migrations/010_machines.sql"].text.includes("PaymentRules"), false);
  const projected = await cue(["export", "-", "-e", "app.state.machines.PaymentRules.level", "--out", "json"], program);
  assertEquals(projected.success, true, projected.stderr);
  assertEquals(JSON.parse(projected.stdout), "ephemeral");
});

Deno.test("guard ordering follows trigger names and each transition's declared order", async () => {
  const second = '{src: "shell/validations/second.js", note: "second predicate", edges: [], module: {statements: "", completion: "() => false"}}';
  const program = paymentProgram() + lifecycle.replace('insert: guard: "positive"', 'insert: guard: ["second", "positive"]') + `
app: state: machines: PaymentRules: guards: second: ${second}
app: state: machines: PaymentRules_A: {
  entity: "Payment"
  guards: other: ${second}
  on: insert: guard: "other"
}
`;
  const result = await cue(["export", "-", "-e", "app.state.entities.Payment.validations", "--out", "json"], program);
  assertEquals(result.success, true, result.stderr);
  const guards = JSON.parse(result.stdout);
  // PostgreSQL sorts the whole trigger name: the suffix puts PaymentRules_A
  // before PaymentRules, even though the shorter machine name sorts first.
  assertEquals(guards.other.order.insert[0] < guards.second.order.insert[0], true);
  assertEquals(guards.second.order.insert[1], 0);
  assertEquals(guards.positive.order.insert[1], 1);
  const files = await emitFiles(program);
  const sql = files["services/database/migrations/010_machines.sql"].text;
  const branch = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION "trg_payment_PaymentRules_reducer"'));
  assertEquals(branch.indexOf("payment_validation_second") < branch.indexOf("payment_validation_positive"), true);
});
