// The emitters' fixture table: what each shape of `cel:` must render to.
//
// Real constraints, and the forms the emitters must REFUSE rather than render.
// A transform pinned against what an author writes, run from derive.ts's
// self-test. Whether an app's constraints and their IR agree is invariants.sql.

import type { ParsedExpr } from "./cel-emit.ts";
import { CelUnsupported, cueConstraint, enumValues, sqlCheck } from "./cel-emit.ts";
import { type CelSite, renderCel } from "./derive-cel.ts";

type Finding = { severity: string; path: string; message: string };

const IR: Record<string, ParsedExpr> = {
  "this in ['a', 'b']": {"expr":{"callExpr":{"function":"@in","args":[{"identExpr":{"name":"this"}},{"listExpr":{"elements":[{"constExpr":{"stringValue":"a"}},{"constExpr":{"stringValue":"b"}}]}}]}}},
  "this in [1, 2]": {"expr":{"callExpr":{"function":"@in","args":[{"identExpr":{"name":"this"}},{"listExpr":{"elements":[{"constExpr":{"int64Value":"1"}},{"constExpr":{"int64Value":"2"}}]}}]}}},
  "this == 'live'": {"expr":{"callExpr":{"function":"_==_","args":[{"identExpr":{"name":"this"}},{"constExpr":{"stringValue":"live"}}]}}},
  "this.size() > 0": {"expr":{"callExpr":{"function":"_>_","args":[{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"size"}},{"constExpr":{"int64Value":"0"}}]}}},
  "this.size() <= 8": {"expr":{"callExpr":{"function":"_<=_","args":[{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"size"}},{"constExpr":{"int64Value":"8"}}]}}},
  "this.matches('^x$')": {"expr":{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"matches","args":[{"constExpr":{"stringValue":"^x$"}}]}}},
  "this.trim().size() > 0": {"expr":{"callExpr":{"function":"_>_","args":[{"callExpr":{"target":{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"trim"}},"function":"size"}},{"constExpr":{"int64Value":"0"}}]}}},
  "this >= 0 && this <= 1": {"expr":{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_>=_","args":[{"identExpr":{"name":"this"}},{"constExpr":{"int64Value":"0"}}]}},{"callExpr":{"function":"_<=_","args":[{"identExpr":{"name":"this"}},{"constExpr":{"int64Value":"1"}}]}}]}}},
  "this.a <= this.b": {"expr":{"callExpr":{"function":"_<=_","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"a"}},{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"b"}}]}}},
  "this.a": {"expr":{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"a"}}},
  "this": {"expr":{"identExpr":{"name":"this"}}},
  "this == 'strings.x'": {"expr":{"callExpr":{"function":"_==_","args":[{"identExpr":{"name":"this"}},{"constExpr":{"stringValue":"strings.x"}}]}}},
  "this in [1.5, 2.5]": {"expr":{"callExpr":{"function":"@in","args":[{"identExpr":{"name":"this"}},{"listExpr":{"elements":[{"constExpr":{"doubleValue":1.5}},{"constExpr":{"doubleValue":2.5}}]}}]}}},
  "has(this.a) == has(this.b)": {"expr":{"callExpr":{"function":"_==_","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"a","testOnly":true}},{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"b","testOnly":true}}]}}},
  "type(this) == map && size(this) == 2 && has(this.n) && type(this.n) == string && this.n.size() <= 4 && has(this.xs) && type(this.xs) == list && size(this.xs) <= 2 && this.xs.all(e1, e1 == int(e1) && e1 >= 0 && e1 <= 9)": {"expr":{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"type","args":[{"identExpr":{"name":"this"}}]}},{"identExpr":{"name":"map"}}]}},{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"size","args":[{"identExpr":{"name":"this"}}]}},{"constExpr":{"int64Value":"2"}}]}}]}},{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"n","testOnly":true}}]}},{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"type","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"n"}}]}},{"identExpr":{"name":"string"}}]}},{"callExpr":{"function":"_<=_","args":[{"callExpr":{"target":{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"n"}},"function":"size"}},{"constExpr":{"int64Value":"4"}}]}}]}}]}},{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_&&_","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"xs","testOnly":true}},{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"type","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"xs"}}]}},{"identExpr":{"name":"list"}}]}}]}},{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_<=_","args":[{"callExpr":{"function":"size","args":[{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"xs"}}]}},{"constExpr":{"int64Value":"2"}}]}},{"comprehensionExpr":{"iterVar":"e1","iterRange":{"selectExpr":{"operand":{"identExpr":{"name":"this"}},"field":"xs"}},"accuVar":"@result","accuInit":{"constExpr":{"boolValue":true}},"loopCondition":{"callExpr":{"function":"@not_strictly_false","args":[{"identExpr":{"name":"@result"}}]}},"loopStep":{"callExpr":{"function":"_&&_","args":[{"identExpr":{"name":"@result"}},{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_==_","args":[{"identExpr":{"name":"e1"}},{"callExpr":{"function":"int","args":[{"identExpr":{"name":"e1"}}]}}]}},{"callExpr":{"function":"_>=_","args":[{"identExpr":{"name":"e1"}},{"constExpr":{"int64Value":"0"}}]}}]}},{"callExpr":{"function":"_<=_","args":[{"identExpr":{"name":"e1"}},{"constExpr":{"int64Value":"9"}}]}}]}}]}},"result":{"identExpr":{"name":"@result"}}}}]}}]}}]}}},
  "type(this) == map && size(this) == 1": {"expr":{"callExpr":{"function":"_&&_","args":[{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"type","args":[{"identExpr":{"name":"this"}}]}},{"identExpr":{"name":"map"}}]}},{"callExpr":{"function":"_==_","args":[{"callExpr":{"function":"size","args":[{"identExpr":{"name":"this"}}]}},{"constExpr":{"int64Value":"1"}}]}}]}}},
  "this.startsWith('x')": {"expr":{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"startsWith","args":[{"constExpr":{"stringValue":"x"}}]}}},
};

/** `col` names the column a field-level `this` stands for; null is the row
 * convention. `sql`/`cue` are the rendering, or null where the form must be
 * refused; `values` is the closed value set, or null where the field admits
 * an open one. */
const FIXTURES: { cel: string; col: string | null; sql: string | null; cue: string | null; values: string[] | null; json?: true }[] = [
  { cel: "this in ['a', 'b']", col: "c", sql: "c IN ('a', 'b')", cue: `("a" | "b")`, values: ["a", "b"] },
  { cel: "this in [1, 2]", col: "c", sql: "c IN (1, 2)", cue: "(1 | 2)", values: ["1", "2"] },
  // A field pinned to one literal is a closed set of one. Answering null here
  // is indistinguishable from an unconstrained column, and the terminal's kind
  // lint then judges nothing.
  { cel: "this == 'live'", col: "c", sql: "c = 'live'", cue: `"live"`, values: ["live"] },
  { cel: "this.size() > 0", col: "c", sql: "char_length(c) > 0", cue: "strings.MinRunes(1)", values: null },
  { cel: "this.size() <= 8", col: "c", sql: "char_length(c) <= 8", cue: "strings.MaxRunes(8)", values: null },
  { cel: "this.matches('^x$')", col: "c", sql: "c ~ '^x$'", cue: `=~ "^x$"`, values: null },
  { cel: "this.trim().size() > 0", col: "c", sql: String.raw`char_length(regexp_replace(c, '^[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g')) > 0`, cue: String.raw`=~ "[^\\s\\v\\x{85}\\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}]"`, values: null },
  { cel: "this >= 0 && this <= 1", col: "c", sql: "c >= 0 AND c <= 1", cue: ">=0 & <=1", values: null },
  { cel: "this.a <= this.b", col: null, sql: "a <= b", cue: null, values: null },
  // Unparenthesized, `a IS NOT NULL = b IS NOT NULL` compares a boolean with b.
  { cel: "has(this.a) == has(this.b)", col: null, sql: "(a IS NOT NULL) = (b IS NOT NULL)", cue: null, values: null },
  { cel: "this in [1.5, 2.5]", col: "c", sql: "c IN (1.5, 2.5)", cue: "(1.5 | 2.5)", values: null },
  // `this` is one thing or the other, and reading it the wrong way renders
  // silently wrong SQL: a member of a scalar under the field convention, a
  // whole row in a scalar position under the row convention.
  { cel: "this.a", col: "c", sql: null, cue: null, values: null },
  { cel: "this", col: null, sql: null, cue: null, values: null },
  { cel: "this.startsWith('x')", col: "c", sql: null, cue: null, values: null },
  // A json column's constraint is the shape #ShapeCel renders (cel-shape.cue),
  // read back as a tree: the CHECK hands it to portable_shape_valid, CUE closes
  // the record, and the set stays open since no scalar is enumerated.
  {
    cel: "type(this) == map && size(this) == 2 && has(this.n) && type(this.n) == string && this.n.size() <= 4 && has(this.xs) && type(this.xs) == list && size(this.xs) <= 2 && this.xs.all(e1, e1 == int(e1) && e1 >= 0 && e1 <= 9)",
    col: "c",
    json: true,
    sql: "public.portable_shape_valid(c, '" + JSON.stringify({"kind":"object","fields":{"n":{"kind":"string","sizeMax":4},"xs":{"kind":"array","maxItems":2,"items":{"kind":"integer","intMin":0,"intMax":9}}}}) + "'::jsonb)",
    cue: "close({n: strings.MaxRunes(4), xs: [...int & >=0 & <=9] & list.MaxItems(2)})",
    values: null,
  },
  // A record stating fewer fields than its size is outside the renderer's grammar, and is refused rather than read narrower.
  { cel: "type(this) == map && size(this) == 1", col: "c", json: true, sql: null, cue: null, values: null },
];

export function celFixtures(): Finding[] {
  const out: Finding[] = [];
  const say = (message: string) => out.push({ severity: "error", path: "plugins/pronto/cel-emit.ts", message });
    for (const f of FIXTURES) {
    const ir = IR[f.cel];
    if (ir === undefined) {
    say(`${f.cel}: the fixture table names a constraint IR carries no IR for`);
    continue;
    }
    let sql: string | null = null;
    try {
      sql = sqlCheck(ir, f.col, f.json === true);
    } catch (e) {
      if (!(e instanceof CelUnsupported)) throw e;
    }
    if (sql !== f.sql) say(`${f.cel}: SQL is ${JSON.stringify(sql)}, expected ${JSON.stringify(f.sql)}`);
    const c = cueConstraint(ir, f.col !== null, f.json === true);
    const cue = "cue" in c ? c.cue : null;
    if (cue !== f.cue) say(`${f.cel}: CUE is ${JSON.stringify(cue)}, expected ${JSON.stringify(f.cue)}`);
    if (f.col !== null) {
      const got = enumValues(ir);
      if (JSON.stringify(got) !== JSON.stringify(f.values)) {
        say(`${f.cel}: value set is ${JSON.stringify(got)}, expected ${JSON.stringify(f.values)}`);
      }
    }
  }
  // Whether program_cel.cue imports strings is structural, not a substring of
  // the rendering: a literal may spell it, and CUE refuses an unused import.
  const imports = (cel: string) => {
    const site: CelSite = { entity: "E", durability: "tab", col: "c", cel };
    return renderCel("p", [site], new Map([[cel, IR[cel]]])).includes('import "strings"');
  };
  if (!imports("this.size() <= 8")) say("a rune bound must import strings");
  if (imports("this == 'strings.x'")) say("a literal spelling strings. must not import strings");
  // The entity block's shape: the three maps sit under `cel`, beside `seed`,
  // where emit.cue reads them (`e.cel.checks`, `.enums`, `.bounds`) and where
  // the closed #Entity admits them; a map at the entity's top level is refused.
  const rendered = renderCel("p", [
    { entity: "E", durability: "server", col: "kind", cel: "this in ['a', 'b']" },
    { entity: "E", durability: "server", col: "name", cel: "this.size() <= 8" },
  ], new Map([["this in ['a', 'b']", IR["this in ['a', 'b']"]], ["this.size() <= 8", IR["this.size() <= 8"]]]));
  const block = "\tE: {\n\t\tseed: [...{\n\t\t\tkind?: (\"a\" | \"b\")\n\t\t\tname?: strings.MaxRunes(8)\n\t\t}]\n" +
    "\t\tcel: {\n\t\t\tchecks: {\n\t\t\t\tkind: \"kind IN ('a', 'b')\"\n\t\t\t\tname: \"char_length(name) <= 8\"\n\t\t\t}\n" +
    "\t\t\tenums: {\n\t\t\t\tkind: [\"a\",\"b\"]\n\t\t\t}\n\t\t\tbounds: {\n\t\t\t\tname: {sizeMax: 8}\n\t\t\t}\n\t\t}\n\t}";
  if (!rendered.includes(block)) say(`program_cel.cue's entity block is not {seed, cel: {checks, enums, bounds}}:\n${rendered}`);
  return out;
}
