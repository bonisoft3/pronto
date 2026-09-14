// Property and chaos testing battery for Jessie handlers and validations.
//
// Combines boundary-biased constraint generation with seed corpus sampling,
// deterministic fuel metering, and deep-freeze immutability checks.

import fc from "npm:fast-check@3.23.2";
import type { ParsedExpr } from "./cel-emit.ts";
import { arbitraryHandlerInput, arbitrarySelfTest, arbitraryValidationInput, type EntityDef, type FieldDef } from "./arbitrary.ts";
import { type FuelHarness, instrumentJessie, instrumentSelfTest } from "./instrument.ts";
// The cage is the terminal's, asked for rather than rebuilt: it owns HOW app
// source runs — the ses pin, the lockdown, the bare compartment — and this file
// owns WHAT to run in it, which is the instrumented harness arbitrary.ts feeds.
// A battery that built its own compartment could measure a handler under an
// authority production never grants, and report green for it.
import { pathToFileURL } from "node:url";

const cageModule = Deno.env.get("PRONTO_CAGE_MODULE");
if (!cageModule) throw new Error("PRONTO_CAGE_MODULE must name the terminal's evaluator module");
const { evaluateCaged } = await import(cageModule.startsWith("file:") ? cageModule : pathToFileURL(cageModule).href);

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export type BatteryOptions = {
  numRuns?: number;
  fuelLimit?: number;
  seed?: number;
};

export type TestResult = {
  name: string;
  kind: "handler" | "validation";
  runs: number;
  maxFuelConsumed: number;
  ok: boolean;
  error?: string;
};

export async function testHandler(
  name: string,
  source: string,
  inputArb: fc.Arbitrary<{ state: unknown; event: unknown }>,
  options: BatteryOptions = {},
): Promise<TestResult> {
  const fuelLimit = options.fuelLimit ?? 100_000;
  // Instrumenting is about THIS module — source the rewriter cannot meter is
  // that module's defect — so it is reported as a result and the run goes on to
  // the next one. Building the cage is not: a missing compartment is a fact
  // about the environment, true of every module, and it propagates.
  let harnessSource: string;
  try {
    ({ harnessSource } = instrumentJessie(source, fuelLimit));
  } catch (err) {
    return {
      name,
      kind: "handler",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: 0,
      ok: false,
      error: (err as Error).message,
    };
  }
  const factory = await evaluateCaged(harnessSource) as (b: number) => FuelHarness;
  const harness = factory(fuelLimit);

  let maxFuel = 0;
  try {
    fc.assert(
      fc.property(inputArb, ({ state, event }) => {
        const frozenState = deepFreeze(structuredClone(state));
        const frozenEvent = deepFreeze(structuredClone(event));

        const res1 = harness.run(frozenState, frozenEvent);
        const fuel1 = harness.getConsumed();
        if (fuel1 > maxFuel) maxFuel = fuel1;

        // Invariant: Determinism (identical inputs yield identical result and fuel)
        const res2 = harness.run(frozenState, frozenEvent);
        const fuel2 = harness.getConsumed();
        if (fuel1 !== fuel2) return false;
        if (JSON.stringify(res1) !== JSON.stringify(res2)) return false;

        // Invariant: Return shape ({ updates: [...] } or primitive)
        if (typeof res1 === "object" && res1 !== null && "updates" in res1) {
          const updates = (res1 as { updates?: unknown }).updates;
          if (!Array.isArray(updates)) return false;
          for (const u of updates) {
            if (typeof u !== "object" || u === null) return false;
            const op = (u as { op?: unknown }).op;
            if (typeof op !== "string" || !["put", "patch", "delete", "insert"].includes(op)) return false;
          }
        }

        return true;
      }),
      { numRuns: options.numRuns ?? 100, seed: options.seed },
    );

    return {
      name,
      kind: "handler",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: maxFuel,
      ok: true,
    };
  } catch (err) {
    return {
      name,
      kind: "handler",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: maxFuel,
      ok: false,
      error: (err as Error).message,
    };
  }
}

export async function testValidation(
  name: string,
  source: string,
  inputArb: fc.Arbitrary<{ state: unknown; event: unknown }>,
  options: BatteryOptions = {},
): Promise<TestResult> {
  const fuelLimit = options.fuelLimit ?? 100_000;
  // Per-module where the module is at fault, propagating where the cage is —
  // testHandler above says why.
  let harnessSource: string;
  try {
    ({ harnessSource } = instrumentJessie(source, fuelLimit));
  } catch (err) {
    return {
      name,
      kind: "validation",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: 0,
      ok: false,
      error: (err as Error).message,
    };
  }
  const factory = await evaluateCaged(harnessSource) as (b: number) => FuelHarness;
  const harness = factory(fuelLimit);

  let maxFuel = 0;
  try {
    fc.assert(
      fc.property(inputArb, ({ state, event }) => {
        const frozenState = deepFreeze(structuredClone(state));
        const frozenEvent = deepFreeze(structuredClone(event));

        const res1 = harness.run(frozenState, frozenEvent);
        const fuel1 = harness.getConsumed();
        if (fuel1 > maxFuel) maxFuel = fuel1;

        // Invariant: Validation must return a boolean
        if (typeof res1 !== "boolean") return false;

        // Invariant: Determinism
        const res2 = harness.run(frozenState, frozenEvent);
        const fuel2 = harness.getConsumed();
        if (fuel1 !== fuel2) return false;
        if (res1 !== res2) return false;

        return true;
      }),
      { numRuns: options.numRuns ?? 100, seed: options.seed },
    );

    return {
      name,
      kind: "validation",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: maxFuel,
      ok: true,
    };
  } catch (err) {
    return {
      name,
      kind: "validation",
      runs: options.numRuns ?? 100,
      maxFuelConsumed: maxFuel,
      ok: false,
      error: (err as Error).message,
    };
  }
}

function readValidationsFromCue(appDir: string): Map<string, { entity: string; edges: { table: string; key: string; from: string }[] }> {
  const map = new Map<string, { entity: string; edges: { table: string; key: string; from: string }[] }>();
  try {
    const text = Deno.readTextFileSync(`${appDir}/program_validations.cue`);
    const entRe = /(\w+):\s*validations:\s*\{([\s\S]*?)\n\t\}/g;
    let entMatch;
    while ((entMatch = entRe.exec(text)) !== null) {
      const entity = entMatch[1];
      const body = entMatch[2];
      const valRe = /"([^"]+)":\s*\{\s*edges:\s*\[([\s\S]*?)\]/g;
      let valMatch;
      while ((valMatch = valRe.exec(body)) !== null) {
        const name = valMatch[1];
        const edgesRaw = valMatch[2];
        const edgeRe = /\{table:\s*"([^"]+)",\s*key:\s*"([^"]+)",\s*from:\s*"([^"]+)"\}/g;
        const edges: { table: string; key: string; from: string }[] = [];
        let edgeMatch;
        while ((edgeMatch = edgeRe.exec(edgesRaw)) !== null) {
          edges.push({ table: edgeMatch[1], key: edgeMatch[2], from: edgeMatch[3] });
        }
        map.set(name, { entity, edges });
      }
    }
  } catch {
    // cue optional
  }
  return map;
}

export async function runBatteryOnApp(appDir: string, options: BatteryOptions = {}): Promise<TestResult[]> {
  const factsPath = `${appDir}/.pronto/facts.json`;
  const celPath = `${appDir}/.pronto/cel.json`;

  const factsText = await Deno.readTextFile(factsPath);
  const facts = JSON.parse(factsText);

  let irs = new Map<string, ParsedExpr>();
  try {
    const celText = await Deno.readTextFile(celPath);
    irs = new Map(Object.entries(JSON.parse(celText)));
  } catch {
    // cel.json optional if no constraints
  }

  const entities: Record<string, EntityDef> = {};
  for (const e of facts.entity ?? []) {
    entities[e.name] = {
      table: e.table,
      durability: e.durability,
      fields: [],
    };
  }
  for (const f of facts.field ?? []) {
    if (entities[f.entity]) {
      const fieldDef: FieldDef = {
        name: f.name,
        type: f.type ?? undefined,
        cel: f.cel ?? undefined,
      };
      entities[f.entity].fields?.push(fieldDef);
    }
  }

  const cueValidations = readValidationsFromCue(appDir);
  const results: TestResult[] = [];
  const modules = facts.handler ?? [];

  for (const mod of modules) {
    const modPath = `${appDir}/${mod.path}`;
    const source = await Deno.readTextFile(modPath);
    const isValidation = mod.path.startsWith("shell/validations/");

    if (isValidation) {
      const valName = mod.path.replace(/^shell\/validations\//, "").replace(/\.js$/, "");
      const decl = cueValidations.get(valName);
      const targetEntity = decl ? entities[decl.entity] : Object.values(entities)[0];
      const edges = decl?.edges ?? [];
      const inputArb = arbitraryValidationInput(targetEntity, edges, entities, irs);
      const res = await testValidation(mod.path, source, inputArb, options);
      results.push(res);
    } else {
      const inputArb = arbitraryHandlerInput(entities, undefined, irs);
      const res = await testHandler(mod.path, source, inputArb, options);
      results.push(res);
    }
  }

  return results;
}

export async function batterySelfTest(): Promise<string[]> {
  const failures: string[] = [
    ...arbitrarySelfTest(),
    ...instrumentSelfTest(),
  ];

  const cleanHandler = `
(state, event) => {
  const rows = state.rows?.game ?? [];
  const want = String(event.id ?? "");
  if (want === "") return { updates: [] };
  const updates = [];
  for (const g of rows) {
    const should = g.id === want ? "yes" : "no";
    if ((g.current ?? "no") !== should) {
      updates.push({ op: "patch", entity: "game", id: g.id, row: { current: should } });
    }
  }
  return { updates };
};
`;

  const inputArb = fc.record({
    state: fc.record({
      rows: fc.record({
        game: fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 4 }),
            current: fc.constantFrom("yes", "no"),
          }),
          { minLength: 0, maxLength: 3 },
        ),
      }),
    }),
    event: fc.record({
      id: fc.string({ minLength: 0, maxLength: 4 }),
    }),
  });

  // Regression: Clean handler must execute deterministically and register fuel consumption
  const resClean = await testHandler("clean-resume", cleanHandler, inputArb, { numRuns: 30 });
  if (!resClean.ok) {
    failures.push(`battery clean handler failed: ${resClean.error}`);
  }
  if (resClean.maxFuelConsumed <= 0) {
    failures.push("battery clean handler consumed 0 fuel");
  }

  // Regression: In-place mutations to state must throw TypeError via deepFreeze
  const mutatingHandler = `
(state, event) => {
  state.rows.game.push({ id: "leak" });
  return { updates: [] };
};
`;
  const resMut = await testHandler("mutating-handler", mutatingHandler, inputArb, { numRuns: 10 });
  if (resMut.ok) {
    failures.push("battery mutating handler was not rejected by deep freeze");
  }

  // Regression: Non-terminating loop must exhaust fuel and throw RangeError
  const loopHandler = `(state, event) => { while (true) {} };`;
  const resLoop = await testHandler("infinite-loop-handler", loopHandler, inputArb, { numRuns: 5, fuelLimit: 500 });
  if (resLoop.ok || !resLoop.error?.includes("Jessie fuel limit exceeded")) {
    failures.push("battery infinite loop was not stopped by fuel exhaustion");
  }

  // Regression: Validations must return boolean and evaluate deterministically
  const cleanValidation = `
(state, event) => {
  const articles = state.rows?.article ?? [];
  return articles.every((a) => a.author_id !== event.row?.user_id);
};
`;
  const valInputArb = fc.record({
    state: fc.record({
      rows: fc.record({
        article: fc.array(
          fc.record({ author_id: fc.string({ minLength: 1, maxLength: 4 }) }),
          { minLength: 0, maxLength: 3 },
        ),
      }),
    }),
    event: fc.record({
      row: fc.record({ user_id: fc.string({ minLength: 1, maxLength: 4 }) }),
    }),
  });

  const resVal = await testValidation("clean-validation", cleanValidation, valInputArb, { numRuns: 30 });
  if (!resVal.ok) {
    failures.push(`battery clean validation failed: ${resVal.error}`);
  }

  // Regression: the harness runs CONFINED, not merely instrumented. Every case
  // above measures the fuel counter and the freeze, and all of them pass just
  // as well when the source is run with this process's own globals in scope —
  // which is what the battery used to fall back to when the ses bundle was
  // unreadable. A handler is what production runs in a compartment endowing
  // nothing, so the authority it can see is the thing to assert on: `fetch`
  // and `Deno` are both real here and neither may reach the module.
  const confinedHandler = `
(state, event) => {
  if (typeof fetch !== "undefined") throw new Error("fetch reached a handler");
  if (typeof Deno !== "undefined") throw new Error("Deno reached a handler");
  return { updates: [] };
};
`;
  const resCaged = await testHandler("confinement", confinedHandler, inputArb, { numRuns: 5 });
  if (!resCaged.ok) {
    failures.push(`the fuel harness ran outside the compartment: ${resCaged.error}`);
  }
  // And the realm around it was sealed: a compartment on an unlocked realm
  // still shares mutable intrinsics with everything else in the process.
  if ((globalThis as { __prontoLockdown?: boolean }).__prontoLockdown !== true) {
    failures.push("the realm was never locked down, so the compartment shares mutable intrinsics");
  }

  return failures;
}

if (import.meta.main) {
  const target = Deno.args[0];
  if (!target || target === "--self-test") {
    const fails = await batterySelfTest();
    if (fails.length > 0) {
      for (const f of fails) console.error(`FAIL ${f}`);
      Deno.exit(1);
    }
    console.log("battery self-test passed");
    Deno.exit(0);
  }

  const results = await runBatteryOnApp(target);
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`PASS ${r.name} (${r.runs} runs, max ${r.maxFuelConsumed} steps)`);
    } else {
      console.error(`FAIL ${r.name}: ${r.error}`);
      failed++;
    }
  }
  if (failed > 0) Deno.exit(1);
}
