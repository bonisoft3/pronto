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
    const wrap = (x: { text: string; prec: number }) => (x.prec < 3 ? `(${x.text})` : x.text);
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
    if (c.function === "trim" && args.length === 0) return { text: `btrim(${recv})`, prec: 4 };
    if (c.function === "matches" && args.length === 1) {
      const re = args[0].constExpr?.stringValue ?? unsupported("matches() over a non-literal pattern");
      return { text: `${recv} ~ ${sqlString(re)}`, prec: 3 };
    }
  }
  return unsupported(`function ${c.function}`);
}

/** The SQL CHECK body for a constraint. `col` names the column `this` stands
 * for at field level, or is null for an entity invariant. */
export function sqlCheck(ir: ParsedExpr, col: string | null): string {
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
        return nonEmpty ? `=~ "\\\\S"` : unsupported(`${c.function} ${n} on trim().size()`);
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

/** The CUE constraint a field-level cel states about the field's value, or
 * the reason there is none. A row-level cel has no field to constrain and is
 * asked for with `field: false`. */
export function cueConstraint(
  ir: ParsedExpr,
  field: boolean,
): { cue: string; strings: boolean } | { no: string } {
  if (!field) return { no: "row-level: `this` is the row, and a row is not a field's value" };
  const used = { strings: false };
  try {
    return { cue: cue(ir.expr, used), strings: used.strings };
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
