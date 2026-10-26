import { fileURLToPath } from "node:url";
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.11";
import { renderMachines } from "./edge-machines.ts";
import {
  compileMechaReducer,
  type MechaReducerMachine,
} from "../mecha-reducer.ts";
import { executeHybrid } from "../hybrid-local.ts";
import { evaluateCaged } from "../../omnishell/interpreter/jessie.js";
import { fuelMeter, instrument } from "../../omnishell/instrument.ts";

const terminal = { instrument, ses: await Deno.readTextFile(new URL("../../omnishell/interpreter/vendor/ses.umd.min.js", import.meta.url)) };
import {
  fixture,
  initial,
  request,
  ROOT,
} from "../testdata/hybrid-fixtures.ts";

async function edgeMachine(spec: MechaReducerMachine, rules: string) {
  const dir = await Deno.makeTempDir({ prefix: "edge-machine-parity-" });
  try {
    await Deno.writeTextFile(`${dir}/rules.js`, rules);
    const source = await renderMachines(
      "parity",
      dir,
      fileURLToPath(new URL("plugins/omnishell", ROOT)),
      {
        [spec.name]: {
          reducer: spec as unknown as Record<string, unknown> & {
            name: string;
            fuel: number;
          },
          rules: "rules.js",
        },
      },
    );
    const module = await import(
      `data:text/javascript,${encodeURIComponent(source)}`
    );
    return module.default[spec.name] as { execute(input: unknown): unknown };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("edge steps initialize rules and spend initialization fuel on every invocation like plv8", async () => {
  const { spec, rules } = await fixture();
  const stateful = `let count = 0; for (let i = 0; i < 3; i++) count++;\n${
    rules.replace(
      "play: (state, event, context) => putCard(state, event.payload.card, context.now)",
      "play: (state, event, context) => putCard(state, event.payload.card, ++count)",
    )
  }`;
  const compiled = await compileMechaReducer(spec, stateful, terminal);
  const input = () => ({
    state: initial(),
    event: request(0).event,
    context: { actor: "a", tier: "omnishell", now: 0 },
    viewers: ["a"],
  });
  const meter = fuelMeter(spec.fuel);
  const run = await evaluateCaged(compiled.source, meter.endowments);
  const expected = JSON.parse(run(JSON.stringify(input())));
  const required = meter.consumed();
  assert(required > 3);
  const edge = await edgeMachine({ ...spec, fuel: required }, stateful);
  for (let i = 0; i < 2; i++) {
    assertEquals(edge.execute(input()), expected);
    assertEquals(
      await executeHybrid(compiled.source, required, input()),
      expected,
    );
  }
  const short = await edgeMachine({ ...spec, fuel: required - 1 }, stateful);
  for (let i = 0; i < 2; i++) {
    assertThrows(() => short.execute(input()), RangeError, "fuel exhausted");
    await assertRejects(
      () => executeHybrid(compiled.source, required - 1, input()),
      Error,
      "fuel limit exceeded",
    );
  }
});

Deno.test("a projection cannot catch fuel exhaustion and return a successful edge step", async () => {
  const { spec, rules } = await fixture();
  const catches = rules.replace(
    "project: (state, viewer) => ({",
    "project: (state, viewer) => { try { while (true) {} } catch {} return ({",
  ).replace(/\}\),\n\};\s*$/, "}); },\n};");
  const limited = { ...spec, fuel: 30 };
  const compiled = await compileMechaReducer(limited, catches, terminal);
  const edge = await edgeMachine(limited, catches);
  const input = () => ({
    state: initial(),
    event: null,
    context: { tier: "mecha", now: 0 },
    viewers: ["a"],
  });
  assertThrows(() => edge.execute(input()), RangeError, "fuel exhausted");
  await assertRejects(
    () => executeHybrid(compiled.source, limited.fuel, input()),
    Error,
    "fuel limit exceeded",
  );
});
