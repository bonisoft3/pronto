// The emitters: every artifact a `cel:` constraint owes the rest of the
// program, derived from the parsed IR alone.
//
// The input is always cel.expr.Expr in canonical protobuf-JSON (cel-spec
// syntax.proto), which is what .pronto/cel.json holds. This module imports no
// parser, so nothing it produces can depend on a parser object that never
// reached the checked-in JSON.
//
// `this` carries two conventions, and the emitter is told which:
//   - a field's cel binds `this` to the VALUE ("this.size() <= 64"), so `col`
//     names the column it stands for;
//   - an entity's invariant binds `this` to the ROW ("this.a <= this.b"), so
//     `col` is null and every column arrives as a select off `this`.
// The two are not interchangeable: a bare `this` under the row convention is
// a whole row in a scalar position, and a select off `this` under the field
// convention is a member of a scalar.

export type Const = {
  int64Value?: string;
  uint64Value?: string;
  stringValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
  nullValue?: unknown;
};

export type Expr = {
  constExpr?: Const;
  identExpr?: { name: string };
  selectExpr?: { operand: Expr; field: string; testOnly?: boolean };
  callExpr?: { target?: Expr; function: string; args?: Expr[] };
  listExpr?: { elements?: Expr[] };
  // What the `all` macro parses to: a fold over `iterRange` binding `iterVar`.
  comprehensionExpr?: {
    iterVar: string;
    iterRange: Expr;
    accuVar: string;
    accuInit: Expr;
    loopCondition: Expr;
    loopStep: Expr;
    result: Expr;
  };
};

/** cel.expr.ParsedExpr in protobuf-JSON: what parse() hands over and what
 * .pronto/cel.json stores per constraint. */
export type ParsedExpr = { expr: Expr };

/** A form no emitter of this module renders. Carrying the constraint and the
 * node keeps the report actionable: the author sees which spelling of which
 * constraint has no rendering, rather than a stack. */
export class CelUnsupported extends Error {
  constructor(readonly what: string) {
    super(what);
    this.name = "CelUnsupported";
  }
}

const unsupported = (what: string): never => {
  throw new CelUnsupported(what);
};

const call = (e: Expr) => e.callExpr;
const isThis = (e: Expr) => e.identExpr?.name === "this";

// ---------------------------------------------------------------- json

/** A value named inside a json column: `this`, an `all` element, or a field
 * selected off either, as the path's identifiers. Null where the expression
 * names no such value. */
function pathOf(e: Expr, elements: Set<string>): string[] | null {
  if (e.identExpr !== undefined) {
    return isThis(e) || elements.has(e.identExpr.name) ? [e.identExpr.name] : null;
  }
  const sel = e.selectExpr;
  if (sel === undefined || sel.testOnly === true) return null;
  const head = pathOf(sel.operand, elements);
  return head === null ? null : [...head, sel.field];
}

/** The predicate an `all` comprehension holds over each element, or null
 * where the comprehension is not `all`. */
function allOf(c: NonNullable<Expr["comprehensionExpr"]>): Expr | null {
  const step = call(c.loopStep);
  if (c.accuInit.constExpr?.boolValue !== true || step?.function !== "_&&_" || step.args?.length !== 2) return null;
  if (step.args[0].identExpr?.name !== c.accuVar || c.result.identExpr?.name !== c.accuVar) return null;
  return step.args[1];
}


/** The integer a const node states, or null when it states something else. */
function intOf(e: Expr): number | null {
  const v = e.constExpr?.int64Value ?? e.constExpr?.uint64Value;
  return v === undefined ? null : Number(v);
}

/** Conjuncts of a top-level `&&` chain, in source order. */
function conjuncts(e: Expr): Expr[] {
  const c = call(e);
  if (c?.function === "_&&_" && c.args?.length === 2) return [...conjuncts(c.args[0]), ...conjuncts(c.args[1])];
  return [e];
}

// ---------------------------------------------------------------- SQL

const SQL_CMP: Record<string, string> = {
  "_>_": ">",
  "_>=_": ">=",
  "_<_": "<",
  "_<=_": "<=",
  "_==_": "=",
  "_!=_": "<>",
};

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// CEL's trim() strips Unicode White_Space; Postgres's btrim() and RE2's \s strip
// ASCII alone, so a body of a non-breaking space would pass both and fail CEL.
const SQL_SPACE = String.raw`[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const CUE_SPACE = String.raw`\\s\\v\\x{85}\\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}`;

function sqlConst(c: Const): string {
  if (c.stringValue !== undefined) return sqlString(c.stringValue);
  if (c.int64Value !== undefined) return c.int64Value;
  if (c.uint64Value !== undefined) return c.uint64Value;
  if (c.boolValue !== undefined) return String(c.boolValue);
  if (c.doubleValue !== undefined) return String(c.doubleValue);
  return unsupported(`constant ${JSON.stringify(c)}`);
}

/** SQL for one node, with the precedence level it renders at: 1 OR, 2 AND,
 * 3 comparison, 4 term. A caller parenthesizes by comparing the two. */
function sql(e: Expr, col: string | null): { text: string; prec: number } {
  if (e.constExpr !== undefined) return { text: sqlConst(e.constExpr), prec: 4 };
  if (isThis(e)) {
    return col === null ? unsupported("bare `this` under the row convention") : { text: col, prec: 4 };
  }
  const sel = e.selectExpr;
  if (sel !== undefined) {
    if (!isThis(sel.operand)) return unsupported(`select off ${JSON.stringify(sel.operand)}`);
    if (col !== null) return unsupported(`this.${sel.field} under the field convention`);
    return sel.testOnly === true
      ? { text: `${sel.field} IS NOT NULL`, prec: 3 }
      : { text: sel.field, prec: 4 };
  }
  const c = call(e);
  if (c === undefined) return unsupported(`node ${JSON.stringify(e)}`);
  const args = c.args ?? [];
  if (c.function === "_&&_" || c.function === "_||_") {
    const prec = c.function === "_&&_" ? 2 : 1;
    const op = c.function === "_&&_" ? "AND" : "OR";
    // A logical operand is parenthesized whenever it is itself logical: an OR
    // under an AND needs it to mean what it says, and an AND under an OR gets
    // it for the reader, Postgres binding AND tighter either way.
    const bare = c.function === "_&&_" ? 2 : 3;
    const parts = args.map((a) => {
      const r = sql(a, col);
      return r.prec < bare ? `(${r.text})` : r.text;
    });
    return { text: parts.join(` ${op} `), prec };
  }
  if (c.function in SQL_CMP) {
    if (args.length !== 2) return unsupported(`${c.function} with ${args.length} arguments`);
    const [l, r] = args.map((a) => sql(a, col));
    // SQL comparisons do not chain.
    const wrap = (x: { text: string; prec: number }) => (x.prec <= 3 ? `(${x.text})` : x.text);
    return { text: `${wrap(l)} ${SQL_CMP[c.function]} ${wrap(r)}`, prec: 3 };
  }
  if (c.function === "@in") {
    if (args.length !== 2) return unsupported(`@in with ${args.length} arguments`);
    const members = args[1].listExpr?.elements ?? unsupported("`in` over a non-literal list");
    return {
      text: `${sql(args[0], col).text} IN (${members.map((m) => sql(m, col).text).join(", ")})`,
      prec: 3,
    };
  }
  if (c.target !== undefined) {
    const recv = sql(c.target, col).text;
    if (c.function === "size" && args.length === 0) return { text: `char_length(${recv})`, prec: 4 };
    if (c.function === "trim" && args.length === 0) {
      return { text: `regexp_replace(${recv}, '^${SQL_SPACE}+|${SQL_SPACE}+$', '', 'g')`, prec: 4 };
    }
    if (c.function === "matches" && args.length === 1) {
      const re = args[0].constExpr?.stringValue ?? unsupported("matches() over a non-literal pattern");
      return { text: `${recv} ~ ${sqlString(re)}`, prec: 3 };
    }
  }
  return unsupported(`function ${c.function}`);
}

/** The SQL CHECK body for a constraint. `col` names the column `this` stands
 * for at field level, or is null for an entity invariant; `json` says the
 * column holds a json value, whose constraint is read as a shape. */
export function sqlCheck(ir: ParsedExpr, col: string | null, json = false): string {
  if (json) {
    if (col === null) return unsupported("a json constraint under the row convention");
    // A CHECK holds no subquery, so a nested value is walked by a function
    // written once (type-sql.ts), handed the shape the constraint states.
    return `public.portable_shape_valid(${col}, ${sqlString(JSON.stringify(shapeTree(ir)))}::jsonb)`;
  }
  return sql(ir.expr, col).text;
}

// ---------------------------------------------------------------- CUE

const cueString = (s: string) => JSON.stringify(s);

function cueConst(c: Const): string {
  if (c.stringValue !== undefined) return cueString(c.stringValue);
  if (c.int64Value !== undefined) return c.int64Value;
  if (c.uint64Value !== undefined) return c.uint64Value;
  if (c.boolValue !== undefined) return String(c.boolValue);
  if (c.doubleValue !== undefined) return String(c.doubleValue);
  return unsupported(`constant ${JSON.stringify(c)}`);
}

const RUNES: Record<string, (n: number) => string> = {
  "_>_": (n) => `strings.MinRunes(${n + 1})`,
  "_>=_": (n) => `strings.MinRunes(${n})`,
  "_<_": (n) => `strings.MaxRunes(${n - 1})`,
  "_<=_": (n) => `strings.MaxRunes(${n})`,
  "_==_": (n) => `strings.MinRunes(${n}) & strings.MaxRunes(${n})`,
};

const BOUND: Record<string, string> = { "_>_": ">", "_>=_": ">=", "_<_": "<", "_<=_": "<=", "_!=_": "!=" };

/** A CUE constraint for one node of a FIELD-level cel. `used` records that a
 * rendering reached for the strings package, which the caller must import and
 * CUE rejects importing unused — a fact no reading of the rendered text can
 * recover, since a string literal may spell it too. */
function cue(e: Expr, used: { strings: boolean }): string {
  const c = call(e) ?? unsupported(`node ${JSON.stringify(e)} in a CUE constraint`);
  const args = c.args ?? [];
  if (c.function === "_&&_") return args.map((a) => cue(a, used)).join(" & ");
  if (c.function === "_||_") return `(${args.map((a) => cue(a, used)).join(" | ")})`;
  if (c.function === "@in") {
    if (!isThis(args[0] ?? {})) return unsupported("`in` whose left side is not `this`");
    const members = args[1]?.listExpr?.elements ?? unsupported("`in` over a non-literal list");
    return `(${members.map((m) => cueConst(m.constExpr ?? unsupported("non-constant list member"))).join(" | ")})`;
  }
  if (c.function in SQL_CMP) {
    if (args.length !== 2) return unsupported(`${c.function} with ${args.length} arguments`);
    const [lhs, rhs] = args;
    const n = intOf(rhs);
    const lc = call(lhs);
    // `this.size()` is a rune count, which CUE states as a validator rather
    // than a bound on the value.
    if (lc?.function === "size" && lc.target !== undefined && n !== null) {
      if (isThis(lc.target)) {
        const rune = RUNES[c.function] ?? unsupported(`${c.function} on size()`);
        used.strings = true;
        return rune(n);
      }
      // The only receiver worth a rendering is a trimmed value, and only for
      // "some non-whitespace character" — a longer trimmed bound is a length
      // CUE has no expression for.
      const tc = call(lc.target);
      if (tc?.function === "trim" && tc.target !== undefined && isThis(tc.target)) {
        const nonEmpty = (c.function === "_>_" && n === 0) || (c.function === "_>=_" && n === 1);
        return nonEmpty ? `=~ "[^${CUE_SPACE}]"` : unsupported(`${c.function} ${n} on trim().size()`);
      }
    }
    if (isThis(lhs)) {
      if (c.function === "_==_") return cueConst(rhs.constExpr ?? unsupported("non-constant equality"));
      const op = BOUND[c.function] ?? unsupported(`${c.function} on this`);
      return `${op}${cueConst(rhs.constExpr ?? unsupported("non-constant bound"))}`;
    }
    return unsupported(`comparison whose left side is ${JSON.stringify(lhs)}`);
  }
  if (c.function === "matches" && c.target !== undefined && isThis(c.target) && args.length === 1) {
    return `=~ ${cueString(args[0].constExpr?.stringValue ?? unsupported("matches() over a non-literal pattern"))}`;
  }
  return unsupported(`function ${c.function} in a CUE constraint`);
}

// ---------------------------------------------------------------- shape

/** What a json column's constraint states, read back as the tree #ShapeCel
 * renders it from: the one nested grammar the readers that have to propose
 * a value (bounds) or vet a stated one (CUE) understand. A record with no
 * fields stated is open. */
export type ShapeTree =
  | { kind: "boolean" }
  | { kind: "string"; sizeMax?: number; enumValues?: string[] }
  | { kind: "integer"; intMin?: number; intMax?: number }
  | { kind: "array"; maxItems: number; items: ShapeTree }
  | { kind: "object"; fields?: Record<string, ShapeTree> };

const pathText = (p: string[]) => p.join(".");

/** Reads the conjuncts about `at` off the cursor, in #ShapeCel's order, and
 * refuses any other spelling: the subset is exactly the one the renderer
 * emits, so a constraint written another way is refused rather than read
 * narrower than it says. */
function readShape(cs: Expr[], cursor: { i: number }, at: string[], elements: Set<string>): ShapeTree {
  const next = () => cs[cursor.i++] ?? unsupported(`a json constraint ending before ${pathText(at)} is stated`);
  const typeOf = (e: Expr): string | null => {
    const c = call(e);
    if (c?.function !== "_==_" || c.args?.length !== 2 || call(c.args[0])?.function !== "type") return null;
    const p = pathOf(call(c.args[0])!.args?.[0] ?? {}, elements);
    if (p === null || pathText(p) !== pathText(at)) return null;
    return c.args[1].identExpr?.name ?? null;
  };
  const bound = (e: Expr, fn: string): { op: string; n: number } | null => {
    const c = call(e);
    if (c === undefined || !(c.function in SQL_CMP) || c.args?.length !== 2) return null;
    const n = intOf(c.args[1]);
    const lhs = c.args[0];
    if (n === null) return null;
    if (fn === "size") {
      const lc = call(lhs);
      if (lc?.function !== "size") return null;
      const p = lc.target !== undefined ? pathOf(lc.target, elements) : pathOf(lc.args?.[0] ?? {}, elements);
      if (p === null || pathText(p) !== pathText(at)) return null;
    } else {
      const p = pathOf(lhs, elements);
      if (p === null || pathText(p) !== pathText(at)) return null;
    }
    return { op: c.function, n };
  };
  const first = next();
  // x == int(x): an integer, then its range
  const fc = call(first);
  if (fc?.function === "_==_" && call(fc.args?.[1] ?? {})?.function === "int") {
    const p = pathOf(fc.args![0], elements);
    if (p === null || pathText(p) !== pathText(at)) return unsupported(`int() over ${JSON.stringify(fc.args![0])}`);
    const tree: ShapeTree = { kind: "integer" };
    for (;;) {
      const b = cursor.i < cs.length ? bound(cs[cursor.i], "value") : null;
      if (b === null) break;
      cursor.i++;
      if (b.op === "_>=_") tree.intMin = b.n;
      else if (b.op === "_<=_") tree.intMax = b.n;
      else return unsupported(`${b.op} on an integer of a json value`);
    }
    return tree;
  }
  const kind = typeOf(first) ?? unsupported(`a json constraint on ${pathText(at)} that does not start by its type`);
  if (kind === "bool") return { kind: "boolean" };
  if (kind === "string") {
    const e = cs[cursor.i];
    const ec = e === undefined ? undefined : call(e);
    if (ec?.function === "@in" && ec.args?.length === 2) {
      const p = pathOf(ec.args[0], elements);
      if (p !== null && pathText(p) === pathText(at)) {
        cursor.i++;
        const members = ec.args[1].listExpr?.elements ?? unsupported("`in` over a non-literal list");
        return { kind: "string", enumValues: members.map((m) => m.constExpr?.stringValue ?? unsupported("a non-string set member")) };
      }
    }
    const b = e === undefined ? null : bound(e, "size");
    if (b === null || b.op !== "_<=_") return unsupported(`a string at ${pathText(at)} without its length`);
    cursor.i++;
    return { kind: "string", sizeMax: b.n };
  }
  if (kind === "list") {
    const b = cursor.i < cs.length ? bound(cs[cursor.i], "size") : null;
    if (b === null || b.op !== "_<=_") return unsupported(`a list at ${pathText(at)} without its size`);
    cursor.i++;
    const comp = next().comprehensionExpr ?? unsupported(`a list at ${pathText(at)} without its all()`);
    const pred = allOf(comp) ?? unsupported("a comprehension that is not all()");
    const range = pathOf(comp.iterRange, elements);
    if (range === null || pathText(range) !== pathText(at)) return unsupported(`all() over ${JSON.stringify(comp.iterRange)}`);
    const inner = conjuncts(pred);
    const innerCursor = { i: 0 };
    const items = readShape(inner, innerCursor, [comp.iterVar], new Set([...elements, comp.iterVar]));
    if (innerCursor.i !== inner.length) return unsupported(`all() over ${pathText(at)} states more than its element`);
    return { kind: "array", maxItems: b.n, items };
  }
  if (kind === "map") {
    const b = cursor.i < cs.length ? bound(cs[cursor.i], "size") : null;
    if (b === null) return { kind: "object" };
    if (b.op !== "_==_") return unsupported(`a record at ${pathText(at)} whose size is not fixed`);
    cursor.i++;
    const fields: Record<string, ShapeTree> = {};
    for (let k = 0; k < b.n; k++) {
      const has = next().selectExpr;
      if (has?.testOnly !== true) return unsupported(`a record at ${pathText(at)} stating fewer fields than its size`);
      const p = pathOf(has.operand, elements);
      if (p === null || pathText(p) !== pathText(at)) return unsupported(`has() off ${JSON.stringify(has.operand)}`);
      fields[has.field] = readShape(cs, cursor, [...at, has.field], elements);
    }
    return { kind: "object", fields };
  }
  return unsupported(`type() compared to ${kind}`);
}

/** The tree a json column's constraint states, or a refusal. */
export function shapeTree(ir: ParsedExpr): ShapeTree {
  const cs = conjuncts(ir.expr);
  const cursor = { i: 0 };
  const tree = readShape(cs, cursor, ["this"], new Set());
  if (cursor.i !== cs.length) return unsupported(`a json constraint stating more than its value's shape, from ${JSON.stringify(cs[cursor.i])}`);
  return tree;
}

function cueOfTree(t: ShapeTree, used: { strings: boolean; list: boolean }): string {
  switch (t.kind) {
    case "boolean":
      return "bool";
    case "string":
      if (t.enumValues !== undefined) return `(${t.enumValues.map(cueString).join(" | ")})`;
      used.strings = true;
      return `strings.MaxRunes(${t.sizeMax})`;
    case "integer":
      return ["int", ...(t.intMin === undefined ? [] : [`>=${t.intMin}`]), ...(t.intMax === undefined ? [] : [`<=${t.intMax}`])].join(" & ");
    case "array":
      used.list = true;
      return `[...${cueOfTree(t.items, used)}] & list.MaxItems(${t.maxItems})`;
    case "object":
      if (t.fields === undefined) return "{...}";
      return `close({${Object.entries(t.fields).map(([k, v]) => `${quoteCueKey(k)}: ${cueOfTree(v, used)}`).join(", ")}})`;
  }
}

const quoteCueKey = (k: string) => (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : JSON.stringify(k));

/** The CUE constraint a field-level cel states about the field's value, or
 * the reason there is none. A row-level cel has no field to constrain and is
 * asked for with `field: false`; a json column's is read as a shape. */
export function cueConstraint(
  ir: ParsedExpr,
  field: boolean,
  json = false,
): { cue: string; strings: boolean; list: boolean } | { no: string } {
  if (!field) return { no: "row-level: `this` is the row, and a row is not a field's value" };
  const used = { strings: false, list: false };
  try {
    return { cue: json ? cueOfTree(shapeTree(ir), used) : cue(ir.expr, used), ...used };
  } catch (e) {
    if (e instanceof CelUnsupported) return { no: e.what };
    throw e;
  }
}

// ---------------------------------------------------------------- enum

/** The value set a field-level cel admits, or null when it bounds the value
 * without enumerating it. Members are the strings a data-when carries, so an
 * int enum's members stringify. A conjunction enumerates when any conjunct
 * does; two that both enumerate intersect. */
export function enumValues(ir: ParsedExpr): string[] | null {
  const sets: string[][] = [];
  for (const t of conjuncts(ir.expr)) {
    const c = call(t);
    if (c === undefined) continue;
    const args = c.args ?? [];
    if (c.function === "@in" && args.length === 2 && isThis(args[0])) {
      const members = args[1].listExpr?.elements;
      if (members === undefined) continue;
      const vals = members.map((m) => (m.constExpr === undefined ? null : constText(m.constExpr)));
      if (vals.every((v) => v !== null)) sets.push(vals as string[]);
    }
    // A field pinned to one literal is an enum of one: every other value is
    // undeclarable, and a template set must still admit the one.
    if (c.function === "_==_" && args.length === 2 && isThis(args[0]) && args[1].constExpr !== undefined) {
      const v = constText(args[1].constExpr);
      if (v !== null) sets.push([v]);
    }
  }
  if (sets.length === 0) return null;
  return sets.reduce((a, b) => a.filter((v) => b.includes(v)));
}

/** A member as the string a data-when carries, or null where it has no such
 * spelling — which makes its conjunct non-enumerating rather than failing the
 * derivation, since SQL and CUE both render the constraint regardless. */
function constText(c: Const): string | null {
  if (c.stringValue !== undefined) return c.stringValue;
  if (c.int64Value !== undefined) return c.int64Value;
  if (c.uint64Value !== undefined) return c.uint64Value;
  if (c.boolValue !== undefined) return String(c.boolValue);
  return null;
}
