// AST-based fuel instrumentation for Jessie modules.
//
// Injects deterministic step metering at all loop heads and function entries
// to enforce execution budgets without relying on non-deterministic wall-clock timers.

import * as acorn from "npm:acorn@8.14.0";
import * as walk from "npm:acorn-walk@8.3.4";
import { splitCompletion } from "./jessie.ts";

export type FuelHarness = {
  run: (...args: unknown[]) => unknown;
  getRemaining: () => number;
  getConsumed: () => number;
};

export function instrumentSource(source: string, fuelLimit = 100_000): string {
  if (!source.trim()) return "";

  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const edits: { pos: number; insert: string }[] = [];
  const stmtCheck = `if (--__fuel <= 0) throw new RangeError("Jessie fuel limit exceeded (${fuelLimit} steps)");`;
  const exprCheckPrefix = `(--__fuel <= 0 ? (() => { throw new RangeError("Jessie fuel limit exceeded (${fuelLimit} steps)"); })() : (`;

  // deno-lint-ignore no-explicit-any
  const loopBody = (body: any) => {
    if (body.type === "BlockStatement") {
      edits.push({ pos: body.start + 1, insert: ` ${stmtCheck}` });
    } else {
      edits.push({ pos: body.start, insert: `{ ${stmtCheck} ` });
      edits.push({ pos: body.end, insert: " }" });
    }
  };

  walk.simple(ast, {
    ForStatement(node) { loopBody(node.body); },
    ForInStatement(node) { loopBody(node.body); },
    ForOfStatement(node) { loopBody(node.body); },
    WhileStatement(node) { loopBody(node.body); },
    DoWhileStatement(node) { loopBody(node.body); },
    ArrowFunctionExpression(node) {
      if (node.body.type === "BlockStatement") {
        edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
      } else {
        edits.push({ pos: node.body.start, insert: exprCheckPrefix });
        edits.push({ pos: node.body.end, insert: "))" });
      }
    },
    FunctionDeclaration(node) {
      edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
    },
    FunctionExpression(node) {
      edits.push({ pos: node.body.start + 1, insert: ` ${stmtCheck}` });
    },
  });

  edits.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.pos) + edit.insert + out.slice(edit.pos);
  }
  return out;
}

export function instrumentJessie(source: string, fuelLimit = 100_000): { harnessSource: string; isArrow: boolean } {
  const split = splitCompletion(source);
  if (split === null) {
    const inst = instrumentSource(source, fuelLimit);
    const harnessSource = `(() => {
  "use strict";
  return (__fuel_budget = ${fuelLimit}) => {
    let __fuel = __fuel_budget;
    const __target = (${inst});
    return {
      run: (...args) => {
        __fuel = __fuel_budget;
        return typeof __target === "function" ? __target(...args) : __target;
      },
      getRemaining: () => __fuel,
      getConsumed: () => __fuel_budget - __fuel
    };
  };
})()`;
    return { harnessSource, isArrow: false };
  }

  const instStmts = instrumentSource(split.statements, fuelLimit);
  const instComp = instrumentSource(split.completion, fuelLimit);
  const cleanComp = instComp.trimEnd().replace(/;+$/, "");

  const harnessSource = `(() => {
  "use strict";
  return (__fuel_budget = ${fuelLimit}) => {
    let __fuel = __fuel_budget;
    ${instStmts}
    const __target = (${cleanComp});
    return {
      run: (...args) => {
        __fuel = __fuel_budget;
        return __target(...args);
      },
      getRemaining: () => __fuel,
      getConsumed: () => __fuel_budget - __fuel
    };
  };
})()`;

  return { harnessSource, isArrow: true };
}

export function instrumentSelfTest(): string[] {
  const failures: string[] = [];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`instrument ${name}: ${detail}`);
  };

  const normalSrc = `
const bump = (n) => n + 1;
(state, event) => {
  let s = 0;
  for (const x of state.items) s += bump(x);
  return { s };
};
`;

  const { harnessSource } = instrumentJessie(normalSrc, 1000);
  const factory = (0, eval)(harnessSource) as (b: number) => FuelHarness;
  const harness = factory(1000);

  const res1 = harness.run({ items: [1, 2, 3] }) as { s: number };
  check("normal result", res1.s === 9, JSON.stringify(res1));
  const consumed1 = harness.getConsumed();
  check("step consumption", consumed1 === 7, `consumed ${consumed1}`);

  const _res2 = harness.run({ items: [10] }) as { s: number };
  check("second run resets fuel", harness.getConsumed() === 3, `consumed ${harness.getConsumed()}`);

  // Regression: Parenthesised concise arrow expression must wrap in fuel check without syntax error
  const parenSrc = `
const num = (v) => (Number(v) || 0);
(state, event) => ({ n: num(event.x) });
`;
  const { harnessSource: parenHarness } = instrumentJessie(parenSrc, 1000);
  const parenFactory = (0, eval)(parenHarness) as (b: number) => FuelHarness;
  const parenRunner = parenFactory(1000);
  const resParen = parenRunner.run({}, { x: "42" }) as { n: number };
  check("paren expression arrow result", resParen.n === 42, JSON.stringify(resParen));

  // Regression: While loop must exhaust fuel limit and abort execution
  const loopSrc = `(state, event) => { while (true) {} };`;
  const { harnessSource: loopHarness } = instrumentJessie(loopSrc, 500);
  const loopFactory = (0, eval)(loopHarness) as (b: number) => FuelHarness;
  const loopRunner = loopFactory(500);

  let loopThrew = false;
  try {
    loopRunner.run({}, {});
  } catch (e) {
    loopThrew = (e as Error).message.includes("Jessie fuel limit exceeded");
  }
  check("infinite loop caught", loopThrew, "did not throw fuel error");

  // Regression: Unbounded function recursion must exhaust fuel limit before stack overflow
  const recurseSrc = `
const recurse = () => recurse();
(state, event) => recurse();
`;
  const { harnessSource: recHarness } = instrumentJessie(recurseSrc, 200);
  const recFactory = (0, eval)(recHarness) as (b: number) => FuelHarness;
  const recRunner = recFactory(200);

  let recThrew = false;
  try {
    recRunner.run({}, {});
  } catch (e) {
    recThrew = (e as Error).message.includes("Jessie fuel limit exceeded");
  }
  check("runaway recursion caught", recThrew, "did not throw fuel error");

  return failures;
}

if (import.meta.main) {
  const fails = instrumentSelfTest();
  if (fails.length > 0) {
    for (const f of fails) console.error(`FAIL ${f}`);
    Deno.exit(1);
  }
  console.log("instrument self-test passed");
}
