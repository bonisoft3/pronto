import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getQuickJS } from "npm:@tootallnate/quickjs-emscripten@0.23.0";

const directory = new URL(".", import.meta.url);
const fixture = new URL("xstate-host-fixture.ts", directory);
const container = Deno.env.get("CORTEX_NATIVE_PG_CONTAINER");

type Input = { snapshot: unknown; event?: unknown };
type Result = { snapshot: { value: string; context: { count: number } }; effects: { type: string; params: any }[] };
type Step = (input: Input) => Promise<Result>;

async function run(cmd: string, args: string[], stdin?: string, cwd?: URL) {
  const process = new Deno.Command(cmd, { args, cwd, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await process.output();
  return { ...result, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

async function withBundle<T>(test: (bundle: string) => Promise<T>): Promise<T> {
  const path = await Deno.makeTempFile({ suffix: ".js" });
  try {
    const result = await run(Deno.execPath(), ["bundle", "--platform", "browser", fileURLToPath(fixture), "-o", path], undefined, directory);
    if (!result.success) throw new Error(result.stderr);
    const bundle = await Deno.readTextFile(path);
    return await test(`var console = { log: () => { throw new Error("unexpected logger"); } };\n${bundle}`);
  } finally {
    await Deno.remove(path);
  }
}

async function scenarios(step: Step) {
  const names = (result: Result) => result.effects.map((effect) => effect.type === "effect" ? effect.params.name : effect.type);
  let result = await step({ snapshot: null });
  assert.deepEqual(names(result), ["enter-idle"]);
  const initial = JSON.parse(JSON.stringify(result.snapshot));
  assert.deepEqual(names(await step({ snapshot: initial, event: { type: "GO", allow: false } })), ["exit-idle", "first"]);
  assert.deepEqual(names(await step({ snapshot: initial, event: { type: "GO", note: "O'Reilly \\ 'quoted'" } })), ["exit-idle", "fallback"]);
  result = await step({ snapshot: initial, event: { type: "GO", allow: true } });
  assert.equal(result.snapshot.value, "active");
  assert.equal(result.snapshot.context.count, 1);
  assert.deepEqual(result.effects[2].params, { event: { type: "INTERNAL" } });
  assert.deepEqual(names(result), ["exit-idle", "second", "xstate.raise", "enter-active", "internal"]);
  result = await step({ snapshot: JSON.parse(JSON.stringify(result.snapshot)), event: { type: "STAY" } });
  assert.equal(result.snapshot.context.count, 2);
  assert.deepEqual(names(result), ["stay"]);
  result = await step({ snapshot: result.snapshot, event: { type: "SELF" } });
  assert.deepEqual(names(result), ["exit-active", "self", "enter-active"]);
  const active = result.snapshot;
  result = await step({ snapshot: active, event: { type: "BACK" } });
  assert.equal(result.snapshot.value, "idle");
  assert.deepEqual(names(result), ["exit-active", "back", "enter-idle"]);
  return active;
}

async function withQuickJS<T>(bundle: string, test: (step: Step) => Promise<T>): Promise<T> {
  const quickjs = await getQuickJS();
  const vm = quickjs.newContext();
  try {
    const evaluate = (code: string) => {
      const result = vm.evalCode(code);
      if (result.error) {
        const message = JSON.stringify(vm.dump(result.error));
        result.error.dispose();
        throw new Error(message);
      }
      const value = vm.dump(result.value);
      result.value.dispose();
      return value;
    };
    evaluate(bundle);
    return await test(async (input) => JSON.parse(evaluate(`JSON.stringify(globalThis.xstateHost(${JSON.stringify(input)}))`)));
  } finally {
    vm.dispose();
  }
}

Deno.test("XState pure transitions in QuickJS", async () => {
  await withBundle((bundle) => withQuickJS(bundle, async (step) => {
    const active = await scenarios(step);
    await assert.rejects(step({ snapshot: active, event: { type: "FAIL" } }), /guard failed/);
  }));
});

Deno.test({
  name: "XState pure transitions and rollback in native PLV8",
  ignore: !container,
  fn: async () => {
    await withBundle(async (bundle) => {
      const database = `xstate_host_${Deno.pid}`;
      const sql = (db: string, query: string) => run("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", db, "-XAt", "-v", "ON_ERROR_STOP=1"], query);
      const execSql = async (db: string, query: string) => {
        const result = await sql(db, query);
        if (!result.success) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
      await execSql("postgres", `CREATE DATABASE ${database};`);
      try {
        await execSql(database, `CREATE EXTENSION plv8;
CREATE FUNCTION xstate_host(input jsonb) RETURNS jsonb LANGUAGE plv8 AS $xstatehost$
${bundle}
return globalThis.xstateHost(input);
$xstatehost$;
CREATE TABLE changes (n integer NOT NULL);
INSERT INTO changes VALUES (0);`);
        const active = await withQuickJS(bundle, (quickStep) => scenarios(async (input) => {
          const native = JSON.parse(await execSql(database, `SELECT xstate_host(${literal(input)});`));
          assert.deepEqual(native, await quickStep(input));
          return native;
        }));
        const failed = await sql(database, `BEGIN; UPDATE changes SET n = 1; SELECT xstate_host(${literal({ snapshot: active, event: { type: "FAIL" } })}); COMMIT;`);
        assert.equal(failed.success, false);
        assert.match(failed.stderr, /guard failed/);
        assert.equal(await execSql(database, "SELECT n FROM changes;"), "0");
      } finally {
        await execSql("postgres", `DROP DATABASE ${database} WITH (FORCE);`);
      }
    });
  },
});
