import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { readCheckInputs } from "./check-inputs.ts";
import { identitiesOf } from "./identity.ts";
import { typeTable } from "./type-table.ts";

const inputs = { version: 1 as const, types: typeTable(), entities: {}, reducers: {}, hatches: {}, rawMigrations: [], duckstreams: {} };

Deno.test("checker inputs require generation and reject unsupported or malformed output", async () => {
  const app = await Deno.makeTempDir();
  try {
    await assert.rejects(() => readCheckInputs(app), Deno.errors.NotFound);
    await Deno.mkdir(`${app}/.pronto`);
    for (const value of [null, {}, { ...inputs, version: 2 }, { ...inputs, types: null }, { ...inputs, types: {} }, { ...inputs, entities: [] }, { ...inputs, hatches: null }, { ...inputs, reducers: [] }, { ...inputs, rawMigrations: {} }, { ...inputs, duckstreams: [] }]) {
      await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, JSON.stringify(value));
      await assert.rejects(() => readCheckInputs(app), { message: /regenerate the application/ });
    }
    await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, "{");
    await assert.rejects(() => readCheckInputs(app), SyntaxError);
    await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, JSON.stringify(inputs));
    assert.deepEqual(await readCheckInputs(app), inputs);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("identity and SQL checks read generation without permission to evaluate CUE", async () => {
  const app = await Deno.makeTempDir();
  const run = async (checker: string, args: string[]) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", fileURLToPath(new URL(checker, import.meta.url)), ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.deepEqual(output.success, true, new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout));
  };
  try {
    await Deno.mkdir(`${app}/.pronto`);
    const row = { name: "Row", table: "row", id: "0xc75ee275aaa2d971", fields: [{ name: "id", type: "text", ordinal: 1 }] };
    await Deno.writeTextFile(`${app}/.pronto/identity.json`, JSON.stringify(identitiesOf([row])));
    await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, JSON.stringify({
      ...inputs,
      entities: { Row: row },
      hatches: { trusted: { kind: "sql", files: ["trusted.sql"], note: "external schema" } },
    }));
    await Deno.writeTextFile(`${app}/trusted.sql`, "invalid SQL withheld by the declared hatch");
    await Deno.writeTextFile(`${app}/ir.html`, "");
    assert.deepEqual(await run("identity.ts", ["check", app]), []);
    assert.deepEqual(await run("check-sql.ts", [app]), []);
    await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, JSON.stringify({
      ...inputs, entities: { Row: { ...row, fields: [] } },
    }));
    const changed = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", fileURLToPath(new URL("identity.ts", import.meta.url)), "check", app],
      stdout: "piped", stderr: "piped",
    }).output();
    assert.deepEqual(changed.code, 1);
    assert.match(JSON.parse(new TextDecoder().decode(changed.stdout))[0].message, /lost ordinal 1/);
    await Deno.writeTextFile(`${app}/.pronto/check-inputs.json`, JSON.stringify({
      ...inputs, hatches: { trusted: { kind: "sql", files: ["trusted.sql"], note: "external schema" } },
    }));
    await Deno.remove(`${app}/trusted.sql`);
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", fileURLToPath(new URL("check-sql.ts", import.meta.url)), app],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.deepEqual(output.code, 1);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(output.stdout))[0].message, "hatch withholds trusted.sql, which the app does not have");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("one Mecha namespace keeps reducer and row-machine contracts distinct", async () => {
  const { cue, paymentProgram } = await import("./effects-fixtures.ts");
  const program = paymentProgram() + `
app: state: mecha: reducers: counter: {
  rules: "machines/counter.js"
  machine: {
    config: {initial: "ready", states: ready: {}}
    setup: {
      version: 1
      types: {
        context: {type: "object", fields: {}}
        view: {type: "object", fields: {}}
        events: {}
      }
    }
  }
}
`;
  const result = await cue(["export", "-", "-e", 'out[".pronto/check-inputs.json"].data', "--out", "json"], program);
  assert.equal(result.success, true, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data.reducers), ["counter"]);
  assert.deepEqual(Object.keys(data.machines), ["PaymentMachine"]);
  assert.equal(data.reducers.counter.name, "counter");
  assert.equal(data.machines.PaymentMachine.entity, "Payment");
  const parent = await cue(["export", "-", "-e", "app"], program + `
app: state: cortex: root: {
  config: {id: "root", initial: "active", states: active: {meta: screen: "board", invoke: src: "counter"}}
  setup: actors: counter: {machine: "counter", via: "local", handler: "machines/counter.js"}
}
`);
  assert.equal(parent.success, false);
  assert.match(parent.stderr, /counter has no initializer/);
  for (const extra of [
    "app: state: hybrids: {}",
    "app: state: machines: {}",
    'app: state: mecha: reducers: counter: entity: "Payment"',
    'app: state: mecha: reducers: counter: level: "external"',
    'app: state: mecha: reducers: counter: unknown: true',
    'app: state: mecha: reducers: neither: {}',
    'app: state: mecha: counter: {}',
  ]) {
    const invalid = await cue(["export", "-", "-e", "app"], program + extra);
    assert.equal(invalid.success, false, extra);
  }
  for (const [source, required] of [
    [program.replace('rules: "machines/counter.js"', ""), "rules"],
    [program.replace('initial: "ready", states: ready: {}', ""), "initial"],
  ]) {
    const invalid = await cue(["export", "-", "-e", "app"], source);
    assert.equal(invalid.success, false, required);
    assert.match(invalid.stderr, new RegExp(required));
  }
});
