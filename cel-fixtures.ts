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
  "this.startsWith('x')": {"expr":{"callExpr":{"target":{"identExpr":{"name":"this"}},"function":"startsWith","args":[{"constExpr":{"stringValue":"x"}}]}}},
};

/** `col` names the column a field-level `this` stands for; null is the row
 * convention. `sql`/`cue` are the rendering, or null where the form must be
 * refused; `values` is the closed value set, or null where the field admits
 * an open one. */
const FIXTURES: { cel: string; col: string | null; sql: string | null; cue: string | null; values: string[] | null }[] = [
  { cel: "this in ['a', 'b']", col: "c", sql: "c IN ('a', 'b')", cue: `("a" | "b")`, values: ["a", "b"] },
  { cel: "this in [1, 2]", col: "c", sql: "c IN (1, 2)", cue: "(1 | 2)", values: ["1", "2"] },
  // A field pinned to one literal is a closed set of one. Answering null here
  // is indistinguishable from an unconstrained column, and the terminal's kind
  // lint then judges nothing.
  { cel: "this == 'live'", col: "c", sql: "c = 'live'", cue: `"live"`, values: ["live"] },
  { cel: "this.size() > 0", col: "c", sql: "char_length(c) > 0", cue: "strings.MinRunes(1)", values: null },
  { cel: "this.size() <= 8", col: "c", sql: "char_length(c) <= 8", cue: "strings.MaxRunes(8)", values: null },
  { cel: "this.matches('^x$')", col: "c", sql: "c ~ '^x$'", cue: `=~ "^x$"`, values: null },
  { cel: "this.trim().size() > 0", col: "c", sql: "char_length(btrim(c)) > 0", cue: `=~ "\\\\S"`, values: null },
  { cel: "this >= 0 && this <= 1", col: "c", sql: "c >= 0 AND c <= 1", cue: ">=0 & <=1", values: null },
  { cel: "this.a <= this.b", col: null, sql: "a <= b", cue: null, values: null },
  { cel: "this in [1.5, 2.5]", col: "c", sql: "c IN (1.5, 2.5)", cue: "(1.5 | 2.5)", values: null },
  // `this` is one thing or the other, and reading it the wrong way renders
  // silently wrong SQL: a member of a scalar under the field convention, a
  // whole row in a scalar position under the row convention.
  { cel: "this.a", col: "c", sql: null, cue: null, values: null },
  { cel: "this", col: null, sql: null, cue: null, values: null },
  { cel: "this.startsWith('x')", col: "c", sql: null, cue: null, values: null },
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
      sql = sqlCheck(ir, f.col);
    } catch (e) {
      if (!(e instanceof CelUnsupported)) throw e;
    }
    if (sql !== f.sql) say(`${f.cel}: SQL is ${JSON.stringify(sql)}, expected ${JSON.stringify(f.sql)}`);
    const c = cueConstraint(ir, f.col !== null);
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
    const site: CelSite = { entity: "E", path: "tab", col: "c", cel };
    return renderCel("p", [site], new Map([[cel, IR[cel]]])).includes('import "strings"');
  };
  if (!imports("this.size() <= 8")) say("a rune bound must import strings");
  if (imports("this == 'strings.x'")) say("a literal spelling strings. must not import strings");
  return out;
}
