// Compiles CEL constraints and entity schemas into fast-check Arbitraries.
//
// Generates boundary-biased values by construction (no rejection sampling)
// and blends realistic seed corpuses from program.cue with chaos mutations.

import fc from "npm:fast-check@3.23.2";
import type { Expr, ParsedExpr } from "./cel-emit.ts";
import { enumValues } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";

export type FieldDef = {
  name: string;
  type?: string;
  cel?: string;
  required?: boolean;
  pk?: boolean;
  ref?: string;
};

export type EntityDef = {
  table: string;
  durability: string;
  fields?: FieldDef[];
  seed?: Record<string, unknown>[];
  validations?: Record<string, { src: string; via: string[]; note?: string }>;
};

export type FieldBounds = {
  enumValues?: string[];
  intMin?: number;
  intMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  regex?: RegExp;
};

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
      if (pattern !== undefined) bounds.regex = new RegExp(pattern);
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

export function arbitraryField(field: FieldDef, bounds: FieldBounds): fc.Arbitrary<unknown> {
  if (bounds.enumValues && bounds.enumValues.length > 0) {
    const enumArb = fc.constantFrom(...bounds.enumValues);
    if (field.required === false && !bounds.enumValues.includes("")) {
      return fc.oneof({ arbitrary: enumArb, weight: 4 }, { arbitrary: fc.constant(""), weight: 1 });
    }
    return enumArb;
  }

  if (field.type === "int" || bounds.intMin !== undefined || bounds.intMax !== undefined) {
    const min = bounds.intMin !== undefined && bounds.intMin !== -Infinity ? bounds.intMin : -1000;
    const max = bounds.intMax !== undefined && bounds.intMax !== Infinity ? bounds.intMax : 1000;
    const intArb = fc.integer({ min, max });
    if (field.required === false) {
      return fc.option(intArb, { nil: null });
    }
    return intArb;
  }

  if (field.type === "uuid") {
    return fc.uuid();
  }

  if (field.type === "timestamptz") {
    return fc.date().map((d) => d.toISOString());
  }

  if (field.type === "bool") {
    return fc.boolean();
  }

  if (bounds.regex) {
    return fc.stringMatching(bounds.regex);
  }

  const minLen = bounds.sizeMin ?? 0;
  const maxLen = bounds.sizeMax !== undefined && bounds.sizeMax !== Infinity
    ? bounds.sizeMax
    : (minLen === 0 ? 32 : minLen + 32);

  const strArb = fc.string({ minLength: minLen, maxLength: maxLen });
  if (field.required === false && minLen > 0) {
    return fc.oneof({ arbitrary: strArb, weight: 4 }, { arbitrary: fc.constant(""), weight: 1 });
  }
  return strArb;
}

export function arbitraryRow(
  entity: EntityDef,
  irs?: Map<string, ParsedExpr>,
): fc.Arbitrary<Record<string, unknown>> {
  const fields = entity.fields ?? [];
  const fieldArbs: Record<string, fc.Arbitrary<unknown>> = {};

  for (const f of fields) {
    let ir = f.cel && irs ? irs.get(f.cel) : undefined;
    if (!ir && f.cel) {
      ir = parseCel(f.cel);
    }
    const bounds = ir ? extractBounds(ir) : {};
    fieldArbs[f.name] = arbitraryField(f, bounds);
  }

  const generatedRecord = fc.record(fieldArbs);
  const seeds = entity.seed ?? [];

  if (seeds.length === 0) {
    return generatedRecord;
  }

  const seedArb = fc.constantFrom(...seeds);
  const mutatedSeedArb = fc.tuple(seedArb, generatedRecord).map(([seed, gen]) => {
    const keys = Object.keys(seed);
    if (keys.length === 0) return { ...seed };
    const mutateKey = keys[Math.floor(Math.random() * keys.length)];
    return { ...seed, [mutateKey]: gen[mutateKey] };
  });

  return fc.oneof(
    { arbitrary: seedArb, weight: 3 },
    { arbitrary: mutatedSeedArb, weight: 2 },
    { arbitrary: generatedRecord, weight: 5 },
  );
}

export function arbitraryHandlerInput(
  entities: Record<string, EntityDef>,
  targetEntity?: string,
  irs?: Map<string, ParsedExpr>,
): fc.Arbitrary<{ state: { rows: Record<string, unknown[]>; items?: unknown[] }; event: Record<string, unknown> }> {
  const rowArbs: Record<string, fc.Arbitrary<unknown[]>> = {};

  for (const [, def] of Object.entries(entities)) {
    const rowArb = arbitraryRow(def, irs);
    rowArbs[def.table] = fc.array(rowArb, { minLength: 0, maxLength: 4 });
  }

  return fc.record(rowArbs).chain((rows) => {
    const targetRows = targetEntity ? rows[entities[targetEntity]?.table ?? ""] ?? [] : [];
    const existingIds = targetRows
      .map((r) => (r as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    const typeArb = fc.option(fc.constantFrom("click", "mutation", "tick", "chooseMove"), { nil: undefined });

    let eventArb: fc.Arbitrary<Record<string, unknown>>;
    if (existingIds.length > 0) {
      eventArb = fc.oneof(
        { arbitrary: fc.record({ id: fc.constantFrom(...existingIds), type: typeArb }), weight: 5 },
        { arbitrary: fc.record({ id: fc.string({ minLength: 0, maxLength: 8 }), type: typeArb }), weight: 5 },
      );
    } else {
      eventArb = fc.record({ id: fc.string({ minLength: 0, maxLength: 8 }), type: typeArb });
    }

    const state = {
      rows,
      items: targetRows,
    };

    return eventArb.map((event) => ({ state, event }));
  });
}

export function arbitraryValidationInput(
  targetEntity: EntityDef,
  edges: { table: string; key: string; from: string }[],
  allEntities: Record<string, EntityDef>,
  irs?: Map<string, ParsedExpr>,
): fc.Arbitrary<{ state: { rows: Record<string, unknown[]> }; event: { row: Record<string, unknown>; old?: Record<string, unknown> } }> {
  const targetRowArb = arbitraryRow(targetEntity, irs);

  return targetRowArb.chain((row) => {
    const edgeRowArbs: Record<string, fc.Arbitrary<unknown[]>> = {};

    for (const edge of edges) {
      const entity = Object.values(allEntities).find((e) => e.table === edge.table);
      if (entity) {
        const baseArb = arbitraryRow(entity, irs);
        // Correlate the edge key with target row field 50% of the time
        const correlatedArb = baseArb.map((r) => {
          const fromVal = row[edge.from];
          return fromVal !== undefined ? { ...r, [edge.key]: fromVal } : r;
        });

        edgeRowArbs[edge.table] = fc.oneof(
          { arbitrary: fc.array(correlatedArb, { minLength: 1, maxLength: 3 }), weight: 5 },
          { arbitrary: fc.array(baseArb, { minLength: 0, maxLength: 3 }), weight: 5 },
        );
      } else {
        edgeRowArbs[edge.table] = fc.constant([]);
      }
    }

    return fc.record(edgeRowArbs).map((edgeRows) => ({
      state: { rows: edgeRows },
      event: { row },
    }));
  });
}

export function arbitrarySelfTest(): string[] {
  const failures: string[] = [];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`arbitrary ${name}: ${detail}`);
  };

  // Regression: String enum CEL constraints must extract exact enum string literals
  const enumIr = parseCel('this in ["house", "hotseat"]');
  const enumB = extractBounds(enumIr);
  check("enum bounds", JSON.stringify(enumB.enumValues) === '["house","hotseat"]', JSON.stringify(enumB));

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

  // Regression: Generated row samples must conform strictly to composite field constraints
  const testEntity: EntityDef = {
    table: "demo",
    durability: "device",
    fields: [
      { name: "id", type: "text", cel: "this.size() <= 8" },
      { name: "mode", type: "text", cel: 'this in ["fast", "slow"]' },
      { name: "val", type: "int", cel: "this >= 0 && this <= 100" },
    ],
    seed: [{ id: "seed1", mode: "fast", val: 42 }],
  };

  const rowArb = arbitraryRow(testEntity);
  const samples = fc.sample(rowArb, 20);

  for (const s of samples) {
    const id = String(s.id);
    const mode = String(s.mode);
    const val = Number(s.val);
    if (id.length > 8) check("id length <= 8", false, `id=${id}`);
    if (mode !== "fast" && mode !== "slow") check("mode enum", false, `mode=${mode}`);
    if (val < 0 || val > 100) check("val in [0, 100]", false, `val=${val}`);
  }

  return failures;
}

if (import.meta.main) {
  const fails = arbitrarySelfTest();
  if (fails.length > 0) {
    for (const f of fails) console.error(`FAIL ${f}`);
    Deno.exit(1);
  }
  console.log("arbitrary self-test passed");
}
