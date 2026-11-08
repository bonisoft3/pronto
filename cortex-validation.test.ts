import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

Deno.test("one backend function cannot span multiple source migrations", async () => {
  const program = paymentProgram({ entity: `
    Alpha: {table: "alpha", durability: "server", fields: [{name: "id", type: "string", pk: true}, {name: "status", type: "string"}]}
    Beta: {table: "beta", durability: "server", fields: [{name: "id", type: "string", pk: true}, {name: "status", type: "string"}]}` }) + `
app: state: cortex: {
  AlphaMachine: {config: {id: "alpha", initial: "idle", meta: {host: "mecha", entity: "Alpha", field: "status", function: "advance_jobs", migration: "019_jobs.sql", watch: ["Alpha"]}, invoke: {src: "facts"}, states: {idle: {}}}, setup: {actors: {facts: {via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM alpha"}}, guards: {}, actions: {}}}
  BetaMachine: {config: {id: "beta", initial: "idle", meta: {host: "mecha", entity: "Beta", field: "status", function: "advance_jobs", migration: "020_jobs.sql", watch: ["Beta"]}, invoke: {src: "facts"}, states: {idle: {}}}, setup: {actors: {facts: {via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM beta"}}, guards: {}, actions: {}}}
}`;
  const result = await cue(["export", "-", "-e", "app"], program);
  assertEquals(result.success, false);
  assertStringIncludes(result.stderr, "Cortex function advance_jobs spans migrations");
  const sameGroup = await cue(["export", "-", "-e", "app"], program.replace('migration: "020_jobs.sql"', 'migration: "019_jobs.sql"'));
  assertEquals(sameGroup.success, true, sameGroup.stderr);
});

Deno.test("backend query emits a source migration and rejects browser actors", async () => {
  const { emitFiles } = await import("./effects-fixtures.ts");
  const { compileCortexSources } = await import("./cortex-sources.ts");
  const program = paymentProgram() + `
app: state: cortex: PaymentFlow: {
  config: {id: "payment_flow", initial: "idle", meta: {host: "mecha", entity: "Payment", field: "failure", function: "advance_payment", migration: "019_payment.sql", watch: ["Payment"]}, invoke: {src: "facts"}, states: {idle: {on: {facts: {}}}}}
  setup: {actors: {facts: {via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM payment"}}, guards: {}, actions: {}}
}`;
  for (const host of ["mech", "omnishell"]) {
    const invalid = await cue(["export", "-", "-e", "app"], program.replace('host: "mecha"', `host: "${host}"`));
    assertEquals(invalid.success, false, `query chart with host ${host} must not silently omit its migration`);
  }
  const inferred = await emitFiles(program.replace('host: "mecha", ', ""));
  assertEquals("services/database/migrations/019_payment.sql" in inferred, true);
  const files = await emitFiles(program) as unknown as Record<string, { format: string; data: { charts: Parameters<typeof compileCortexSources>[0]; entities: Parameters<typeof compileCortexSources>[1] }; text: string }>;
  const source = files["services/database/migrations/019_payment.sql"];
  assertEquals(source.format, "cortex-sql");
  assertStringIncludes(compileCortexSources(source.data.charts, source.data.entities), "advance_payment");
  assertStringIncludes(files["services/database/migrations/010_machines.sql"].text, "@PRONTO_XSTATE");
  const lifecycle = await emitFiles(program + '\napp: state: mecha: rows: Audit: {entity: "Payment", on: insert: actions: [{assign: {failure: ""}}]}') as unknown as Record<string, { data: { machines: Record<string, { on?: unknown; states?: unknown }> } }>;
  assertEquals(lifecycle[".pronto/check-inputs.json"].data.machines.Audit.states, undefined);
  assertEquals(typeof lifecycle[".pronto/check-inputs.json"].data.machines.Audit.on, "object");
  const rejected = await cue(["export", "-", "-e", "app"], program.replace('via: "query", event: "facts", select:', 'via: "observe", event: "facts", select:'));
  assertEquals(rejected.success, false);
});

Deno.test("raw baselines replace machine and Cortex emissions without duplicating their names", async () => {
  const { emitFiles } = await import("./effects-fixtures.ts");
  const program = paymentProgram() + `
app: state: cortex: PaymentFlow: {
  config: {id: "payment_flow", initial: "idle", meta: {host: "mecha", entity: "Payment", field: "failure", function: "advance_payment", migration: "019_payment.sql", watch: ["Payment"]}, invoke: {src: "facts"}, states: {idle: {on: {facts: {}}}}}
  setup: {actors: {facts: {via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM payment"}}, guards: {}, actions: {}}
}
app: state: rawMigrations: [
  {name: "003_rls.sql", src: "baseline/003.sql"},
  {name: "005_create_tables.sql", src: "baseline/005.sql"},
  {name: "010_machines.sql", src: "baseline/010.sql"},
  {name: "019_payment.sql", src: "baseline/019.sql"},
]
`;
  const files = await emitFiles(program) as unknown as Record<string, { src?: string; text?: string; data?: unknown }>;
  // 005 too: a live baseline keeps the tables it applied, and a later column is a migration's.
  for (const [name, src] of [["003_rls.sql", "baseline/003.sql"], ["005_create_tables.sql", "baseline/005.sql"], ["010_machines.sql", "baseline/010.sql"], ["019_payment.sql", "baseline/019.sql"]]) {
    const file = files[`services/database/migrations/${name}`];
    assertEquals(file.src, src);
    assertEquals(file.text, undefined);
    assertEquals(file.data, undefined);
  }
  const listed = await cue(["export", "-", "-e", "_cluster.state.migrations", "--out", "json"], program);
  assertEquals(listed.success, true, listed.stderr);
  const names = JSON.parse(listed.stdout) as string[];
  for (const name of ["003_rls.sql", "005_create_tables.sql", "010_machines.sql", "019_payment.sql"]) assertEquals(names.filter((path) => path.endsWith(`/${name}`)).length, 1);
  const duplicate = await cue(["export", "-", "-e", "app.state", "--out", "json"], program.replace('{name: "019_payment.sql", src: "baseline/019.sql"}', '{name: "010_machines.sql", src: "baseline/019.sql"}'));
  assertEquals(duplicate.success, false);
  assertStringIncludes(duplicate.stderr, "UniqueItems");
});
