import { assertEquals, assertStringIncludes } from '@std/assert';
import { cue, emitFiles, paymentProgram } from './effects-fixtures.ts';

const placed = (steps: string) => paymentProgram() + `\napp: state: steps: {${steps}}\n`;
const all = 'machines: "062", graphile: "060", airlock: "061", note: "the steps below 060 write no payment rows"';

async function databaseSteps(code: string): Promise<string[]> {
  const result = await cue(['export', '-', '-e', '_cluster.surface.targets.database.dockerfile.copy', '--out', 'json'], code);
  if (!result.success) throw new Error(result.stderr);
  return (JSON.parse(result.stdout) as { dst: string; from?: unknown }[]).filter((c) => c.from !== undefined).map((c) => c.dst);
}

// golaberto held 010-012 and 016 with its own steps before adopting machines and
// effects; its program states where the framework's go instead.
Deno.test('a program places the framework steps where it writes them, and only then', async () => {
  const defaults = await emitFiles(paymentProgram());
  assertEquals(Object.keys(defaults).filter((f) => f.startsWith('services/database/migrations/01')), ['services/database/migrations/010_machines.sql']);
  assertEquals(await databaseSteps(paymentProgram()), ['/docker-entrypoint-initdb.d/899_role_passwords.sh', '/docker-entrypoint-initdb.d/011_graphile_worker.sql', '/docker-entrypoint-initdb.d/012_airlock.sql']);
  assertEquals((defaults['.pronto/cluster.json'] as unknown as { data: { steps?: unknown } }).data.steps, undefined);

  const files = await emitFiles(placed(all));
  assertEquals(files['services/database/migrations/010_machines.sql'], undefined);
  assertStringIncludes(files['services/database/migrations/062_machines.sql'].text, 'trg_payment_status_machine');
  assertEquals(await databaseSteps(placed(all)), ['/docker-entrypoint-initdb.d/899_role_passwords.sh', '/docker-entrypoint-initdb.d/060_graphile_worker.sql', '/docker-entrypoint-initdb.d/061_airlock.sql']);
  assertEquals((files['.pronto/cluster.json'] as unknown as { data: { steps: unknown } }).data.steps, { graphile: '060_graphile_worker.sql', airlock: '061_airlock.sql', note: 'the steps below 060 write no payment rows' });
});

Deno.test('a placement is refused out of order, out of range, unexplained or on taken digits', async () => {
  const refused = async (code: string) => assertEquals((await cue(['export', '-', '-e', 'out', '--out', 'json'], code)).success, false, code);
  const clusterRefused = async (code: string) => assertEquals((await cue(['export', '-', '-e', '_cluster.surface.targets', '--out', 'json'], code)).success, false, code);
  // The airlock's tables need the ledger's schema before them.
  await refused(placed('graphile: "061", airlock: "060", note: "n"'));
  await refused(placed('graphile: "013", note: "n"'));
  // 000-009 are the schema's own steps through validations; 800-899 the framework's; 900 the seed.
  await refused(placed('machines: "009", note: "n"'));
  await refused(placed('machines: "810", note: "n"'));
  await refused(placed('machines: "900", note: "n"'));
  await refused(placed('machines: "62", note: "n"'));
  await refused(placed('machines: "062"'));
  await refused(placed('machines: "062", note: ""'));
  // Two steps on one set of digits, as initdb would run them in no stated order.
  await clusterRefused(placed(all) + '\napp: state: rawMigrations: [{name: "060_game_days.sql", src: "sql/060_game_days.sql"}]\n');
});
