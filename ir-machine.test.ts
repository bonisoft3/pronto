import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";
import { type Program, renderIr } from "./ir-render.ts";
import { declarations, irIds } from "./objects.ts";

async function render(code: string) {
  const compiled = await cue(["export", "-", "-e", '{program: app, sql: out["services/database/migrations/010_machines.sql"].text}'], code);
  assertEquals(compiled.success, true, compiled.stderr);
  const { program, sql } = JSON.parse(compiled.stdout) as { program: Program; sql: string };
  assertEquals(sql.length > 0, true);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/ir.html`, '<html><head></head><body><section id="Payment" data-kind="entity"><h2>Payment</h2></section><section id="board" data-kind="screen"><h2>Board</h2></section></body></html>');
    const sources: string[] = [];
    const draw = (source: string) => {
      sources.push(source);
      return Promise.resolve("<svg/>");
    };
    const facts = { read_mode: [{ entity: "Payment", mode: "eager" }] };
    await renderIr(dir, "ir.html", program, facts, draw);
    const html = await Deno.readTextFile(`${dir}/ir.html`);
    const ids = irIds(html);
    for (const declaration of declarations(program).filter((d) => d.kind === "machine" || d.kind === "effect")) {
      assertEquals(ids.get(declaration.kind)?.filter((id) => id === declaration.id).length, 1, declaration.where);
    }
    assertEquals(await renderIr(dir, "ir.html", program, facts, draw), false);
    assertEquals(html.includes("undefined"), false);
    return { html, sources, sql };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("IR resolves a machine's table alias for both its card and the screen's machine field", async () => {
  const { html, sources } = await render(paymentProgram().replace('entity: "Payment"', 'entity: "payment"'));
  assertStringIncludes(html, 'data-kind="machine" id="PaymentMachine" data-of="Payment"');
  assertStringIncludes(html, 'data-kind="effect" id="charge" data-of="PaymentMachine"');
  assertStringIncludes(html, "<b>writers</b> machine:PaymentMachine update");
  assertEquals(sources.some((s) => s.includes('"status": "string" {constraint: machine}')), true);
});

Deno.test("a SQL hatch is linked from its machine and prevents a derived delivery guarantee", async () => {
  const { html, sql } = await render(paymentProgram() + `
app: {
  state: machines: PaymentMachine: states: pending: entry: hatch: {name: "billing", call: "bill", args: [{raw: "NEW.id"}]}
  capabilities: hatches: billing: {ir: "billing-sql", kind: "sql", files: ["services/database/migrations/020_billing.sql"], note: "the billing function owns the write"}
}`);
  assertStringIncludes(sql, "PERFORM bill(NEW.id)");
  assertStringIncludes(html, 'href="#billing-sql"');
  assertStringIncludes(html, "the billing function owns the write");
  assertEquals(html.split("<b>delivery</b> unspecified").length - 1, 3);
});

Deno.test("IR renders lifecycle reducers with their timing and actions without inventing a statechart", async () => {
  const normal = paymentProgram();
  const reducer = normal.slice(0, normal.indexOf("    machines:")) + `
    machines: PaymentMachine: {
      name: "PaymentMachine", entity: "Payment"
      on: {
        insert: assign: failure: "fresh"
        update: [{assign: {failure: "changed"}}, {raise: {notify: "payments", payload: "NEW.id"}}]
        delete: effect: {op: "delete", table: "audit", where: {payment_id: "OLD.id"}}
      }
    }
  }
` + normal.slice(normal.indexOf("  capabilities:"));
  for (const timing of [undefined, "BEFORE"]) {
    const { html, sources, sql } = await render(reducer + (timing === undefined ? "" : `\napp: state: machines: PaymentMachine: timing: "${timing}"`));
    const effective = timing ?? "AFTER";
    assertStringIncludes(sql, `${effective} INSERT OR UPDATE OR DELETE`);
    for (const event of ["insert", "update", "delete"]) assertStringIncludes(html, `<th>${effective} ${event}</th>`);
    for (const action of ["fresh", "changed", "payments", "audit", "OLD.id"]) assertStringIncludes(html, action);
    assertStringIncludes(html, "<b>delivery</b> exactly-once");
    assertEquals(sources.every((s) => !s.includes("start ->") && !s.includes("constraint: machine")), true);
  }
});

Deno.test("IR covers every invoking state's effect and a separate lifecycle machine's emitted actions", async () => {
  const code = paymentProgram({ machine: `
    pending: on: pay: "charging"
    charging: invoke: {src: "charge", onDone: "refunding", onError: "failed"}
    refunding: invoke: {src: "refund", onDone: "settled", onError: "failed"}
    settled: type: "final"
    failed: type: "final"
  ` }) + `
app: state: {
  machines: PaymentLifecycle: {entity: "Payment", on: insert: raise: {notify: "payment_created", payload: "NEW.id"}}
  effects: refund: {
    input: {amount: "NEW.total"}
    sink: {origin: "https://api.acquirer.example", idempotent: false}
    reentry: "unknown"
    note: "a refund must be issued at most once"
  }
}`;
  const { html, sources, sql } = await render(code);
  assertEquals(html.split("<b>delivery</b> exactly-once · at-most-once").length - 1, 2);
  for (const [id, delivery] of [["charge", "exactly-once"], ["refund", "at-most-once"]]) {
    const paragraph = html.match(new RegExp(`<p[^>]+id="${id}"[^>]*>[\\s\\S]*?</p>`))?.[0];
    assertStringIncludes(paragraph!, `<b>delivery</b> ${delivery}`);
  }
  assertStringIncludes(html, "a refund must be issued at most once");
  assertStringIncludes(sql, "payment_created");
  assertStringIncludes(sql, "trg_payment_PaymentLifecycle_reducer");
  assertStringIncludes(html, 'data-kind="machine" id="PaymentLifecycle"');
  assertStringIncludes(html, "<th>AFTER insert</th>");
  assertStringIncludes(html, "payment_created");
  assertEquals(sources.some((s) => s.includes("invoke charge") && s.includes("invoke refund")), true);
});

Deno.test("IR links lifecycle guards independently from their actions", async () => {
  const { html } = await render(paymentProgram() + `
app: state: machines: PaymentRules: {
  entity: "Payment"
  guards: positive: {
    ir: "positive-payment"
    src: "shell/validations/positive.js"
    note: "payments must have a positive total"
    edges: []
    module: {statements: "", completion: "(state, event) => event.row.total > 0"}
  }
  on: insert: {
    guard: "positive"
    actions: raise: {notify: "payment_created", payload: "NEW.id"}
  }
}`);
  assertStringIncludes(html, '<th>guards</th><th>actions</th>');
  assertStringIncludes(html, 'href="#positive-payment"');
  assertStringIncludes(html, 'payment_created');
});
