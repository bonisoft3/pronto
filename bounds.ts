// What a CEL constraint says about the values a column admits.
//
// One reading of the parsed expression, stated in terms that name no language:
// a closed set, an integer range, a length range, a pattern. derive-cel.ts
// renders it into program_cel.cue (`cel.bounds`) and emit.cue carries it into shell.yaml
// beside the field it belongs to, which is how a reader that has to GENERATE a
// value the program would accept gets one without a second front end for the
// constraint language.
//
// The reading is partial by design: a conjunct this does not recognise leaves
// the domain wider than the constraint, never narrower, so a generator built on
// it proposes values the program refuses and never the reverse.

import type { Expr, ParsedExpr, ShapeTree } from "./cel-emit.ts";
import { CelUnsupported, enumValues, shapeTree } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";

/** A column's value domain. Every key is optional and absent means unbounded;
 * `enumValues` closes the set, and a column that states it states nothing
 * else. `regex` is the pattern's source text, because this crosses to its
 * readers as data. */
export type FieldBounds = {
  enumValues?: string[];
  intMin?: number;
  intMax?: number;
  // A json column's value, as the shape its constraint states: the kind at
  // each level, a record's fields, a list's items and cap. A record with no
  // fields is open.
  kind?: ShapeTree["kind"];
  fields?: Record<string, FieldBounds>;
  items?: FieldBounds;
  maxItems?: number;
  sizeMin?: number;
  sizeMax?: number;
  regex?: string;
};

/** The keys of a FieldBounds in the order a rendering states them, so two runs
 * over the same constraint write the same line whatever order the source
 * stated its conjuncts in. */
export const BOUND_KEYS = ["kind", "intMin", "intMax", "sizeMin", "sizeMax", "regex", "maxItems", "items", "fields"] as const;

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

export function extractBounds(ir: ParsedExpr, json = false): FieldBounds {
  if (json) {
    try {
      return boundsOfTree(shapeTree(ir));
    } catch (e) {
      if (e instanceof CelUnsupported) return {};
      throw e;
    }
  }
  return read(ir).bounds;
}

function boundsOfTree(t: ShapeTree): FieldBounds {
  switch (t.kind) {
    case "boolean":
      return { kind: "boolean" };
    case "string":
      return t.enumValues !== undefined ? { kind: "string", enumValues: t.enumValues } : { kind: "string", sizeMax: t.sizeMax };
    case "integer":
      return { kind: "integer", ...(t.intMin === undefined ? {} : { intMin: t.intMin }), ...(t.intMax === undefined ? {} : { intMax: t.intMax }) };
    case "array":
      return { kind: "array", maxItems: t.maxItems, items: boundsOfTree(t.items) };
    case "object":
      return t.fields === undefined ? { kind: "object" } : { kind: "object", fields: Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, boundsOfTree(v)])) };
  }
}

/** The bounds a constraint states, or null where any conjunct says more than
 * they can: a proof that a value fits the column reads only what it fully
 * understands, where a generator may read the domain wider. */
export function exactBounds(ir: ParsedExpr): FieldBounds | null {
  const { bounds, exact } = read(ir);
  return exact ? bounds : null;
}

function read(ir: ParsedExpr): { bounds: FieldBounds; exact: boolean } {
  const bounds: FieldBounds = {};
  const enums = enumValues(ir);
  if (enums !== null) {
    bounds.enumValues = enums;
    return { bounds, exact: true };
  }

  let exact = true;
  for (const c of conjuncts(ir.expr)) {
    if (!conjunct(c, bounds)) exact = false;
  }
  return { bounds, exact };
}

/** Narrows `bounds` by one conjunct; whether it was read exactly. */
function conjunct(c: Expr, bounds: FieldBounds): boolean {
  const call = c.callExpr;
  if (call === undefined) return false;
  const args = call.args ?? [];

  if (call.function === "matches" && call.target?.identExpr?.name === "this" && args.length === 1) {
    const pattern = args[0].constExpr?.stringValue;
    if (pattern === undefined) return false;
    bounds.regex = pattern;
    return true;
  }

  if (args.length !== 2) return false;
  const [lhs, rhs] = args;
  const n = intOf(rhs);
  if (n === null) return false;

  if (lhs.identExpr?.name === "this") {
    if (call.function === "_>=_") bounds.intMin = Math.max(bounds.intMin ?? -Infinity, n);
    else if (call.function === "_>_") bounds.intMin = Math.max(bounds.intMin ?? -Infinity, n + 1);
    else if (call.function === "_<=_") bounds.intMax = Math.min(bounds.intMax ?? Infinity, n);
    else if (call.function === "_<_") bounds.intMax = Math.min(bounds.intMax ?? Infinity, n - 1);
    else if (call.function === "_==_") {
      bounds.intMin = n;
      bounds.intMax = n;
    } else return false;
    return true;
  }

  if (lhs.callExpr?.function === "size" && lhs.callExpr.target?.identExpr?.name === "this") {
    if (call.function === "_>=_") bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, n);
    else if (call.function === "_>_") bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, n + 1);
    else if (call.function === "_<=_") bounds.sizeMax = Math.min(bounds.sizeMax ?? Infinity, n);
    else if (call.function === "_<_") bounds.sizeMax = Math.min(bounds.sizeMax ?? Infinity, n - 1);
    else if (call.function === "_==_") {
      bounds.sizeMin = n;
      bounds.sizeMax = n;
    } else return false;
    return true;
  }

  // A non-blank value: its untrimmed length is at least one, which is less
  // than it says.
  if (lhs.callExpr?.function === "size" && lhs.callExpr.target?.callExpr?.function === "trim") {
    bounds.sizeMin = Math.max(bounds.sizeMin ?? 0, 1);
  }
  return false;
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
