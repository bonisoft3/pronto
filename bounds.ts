// What a CEL constraint says about the values a column admits.
//
// One reading of the parsed expression, stated in terms that name no language:
// a closed set, an integer range, a length range, a pattern. derive-cel.ts
// renders it into program_cel.cue and emit.cue carries it into shell.yaml
// beside the field it belongs to, which is how a reader that has to GENERATE a
// value the program would accept gets one without a second front end for the
// constraint language.
//
// The reading is partial by design: a conjunct this does not recognise leaves
// the domain wider than the constraint, never narrower, so a generator built on
// it proposes values the program refuses and never the reverse.

import type { Expr, ParsedExpr } from "./cel-emit.ts";
import { enumValues } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";

/** A column's value domain. Every key is optional and absent means unbounded;
 * `enumValues` closes the set, and a column that states it states nothing
 * else. `regex` is the pattern's source text, because this crosses to its
 * readers as data. */
export type FieldBounds = {
  enumValues?: string[];
  intMin?: number;
  intMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  regex?: string;
};

/** The keys of a FieldBounds in the order a rendering states them, so two runs
 * over the same constraint write the same line whatever order the source
 * stated its conjuncts in. */
export const BOUND_KEYS = ["intMin", "intMax", "sizeMin", "sizeMax", "regex"] as const;

function conjuncts(e: Expr): Expr[] {
  const c = e.callExpr;
  if (c?.function === "_&&_" && c.args?.length === 2) {
    return [...conjuncts(c.args[0]), ...conjuncts(c.args[1])];
  }
  return [e];
}

function intOf(e: Expr): number | null {
  const v = e.constExpr?.int64Value ?? e.constExpr?.uint64Value;
  return v === undefined ? null : Number(v);
}

export function extractBounds(ir: ParsedExpr): FieldBounds {
  const bounds: FieldBounds = {};
  const enums = enumValues(ir);
  if (enums !== null) {
    bounds.enumValues = enums;
    return bounds;
  }

  for (const c of conjuncts(ir.expr)) {
    const call = c.callExpr;
    if (call === undefined) continue;
    const args = call.args ?? [];

    if (call.function === "matches" && call.target?.identExpr?.name === "this" && args.length === 1) {
      const pattern = args[0].constExpr?.stringValue;
      if (pattern !== undefined) bounds.regex = pattern;
      continue;
    }

    if (args.length === 2) {
      const [lhs, rhs] = args;
      const n = intOf(rhs);
      if (n === null) continue;

      if (lhs.identExpr?.name === "this") {
        if (call.function === "_>=_") bounds.intMin = Math.max(bounds.intMin ?? -Infinity, n);
        else if (call.function === "_>_") bounds.intMin = Math.max(bounds.intMin ?? -Infinity, n + 1);
        else if (call.function === "_<=_") bounds.intMax = Math.min(bounds.intMax ?? Infinity, n);
        else if (call.function === "_<_") bounds.intMax = Math.min(bounds.intMax ?? Infinity, n - 1);
        else if (call.function === "_==_") {
          bounds.intMin = n;
          bounds.intMax = n;
        }
      }

      if (lhs.callExpr?.function === "size" && lhs.callExpr.target?.identExpr?.name === "this") {
        if (call.function === "_>=_") bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, n);
        else if (call.function === "_>_") bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, n + 1);
        else if (call.function === "_<=_") bounds.sizeMax = Math.min(bounds.sizeMax ?? Infinity, n);
        else if (call.function === "_<_") bounds.sizeMax = Math.min(bounds.sizeMax ?? Infinity, n - 1);
        else if (call.function === "_==_") {
          bounds.sizeMin = n;
          bounds.sizeMax = n;
        }
      }

      if (lhs.callExpr?.function === "size" && lhs.callExpr.target?.callExpr?.function === "trim") {
        bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, 1);
      }
    }
  }

  return bounds;
}

export function boundsSelfTest(): string[] {
  const failures: string[] = [];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`bounds ${name}: ${detail}`);
  };

  // Regression: String enum CEL constraints must extract exact enum string literals
  const enumIr = parseCel('this in ["house", "hotseat"]');
  const enumB = extractBounds(enumIr);
  check("enum bounds", JSON.stringify(enumB.enumValues) === '["house","hotseat"]', JSON.stringify(enumB));
  // A closed set is the whole domain: anything else stated beside it would be
  // a second answer to the same question for the reader that has both.
  check("a closed set states nothing else", Object.keys(enumB).length === 1, JSON.stringify(enumB));

  // Regression: Integer comparison conjuncts must tighten min and max bounds
  const intIr = parseCel("this >= -10 && this <= 20");
  const intB = extractBounds(intIr);
  check("int bounds", intB.intMin === -10 && intB.intMax === 20, JSON.stringify(intB));

  // Regression: Size string length conjuncts and exact equality must constrain bounds
  const sizeIr = parseCel("this.size() >= 2 && this.size() <= 8");
  const sizeB = extractBounds(sizeIr);
  check("size bounds", sizeB.sizeMin === 2 && sizeB.sizeMax === 8, JSON.stringify(sizeB));

  const sizeEqIr = parseCel("this.size() == 4");
  const sizeEqB = extractBounds(sizeEqIr);
  check("size == 4 bounds", sizeEqB.sizeMin === 4 && sizeEqB.sizeMax === 4, JSON.stringify(sizeEqB));

  // Regression: a pattern crosses as its source text, not as a compiled object
  const reB = extractBounds(parseCel('this.matches("^[a-z]+$")'));
  check("regex bounds", reB.regex === "^[a-z]+$", JSON.stringify(reB));

  // Regression: an unrecognised conjunct widens nothing and narrows nothing
  const openB = extractBounds(parseCel("this.startsWith('x') && this.size() <= 3"));
  check("an unread conjunct leaves the rest", openB.sizeMax === 3, JSON.stringify(openB));

  return failures;
}

if (import.meta.main) {
  const fails = boundsSelfTest();
  if (fails.length > 0) {
    for (const f of fails) console.error(`FAIL ${f}`);
    Deno.exit(1);
  }
  console.log("bounds self-test passed");
}
