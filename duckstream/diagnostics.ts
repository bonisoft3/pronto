import { type Plan, require } from "./translator.ts";

export interface Diagnostic {
  view: string;
  final: string[];
}

export function readDiagnostics(text: string, plan: Plan): Diagnostic[] {
  const lines = text.split("\n");
  const result: Diagnostic[] = [];
  let view: string | undefined;
  let before = false;
  for (let index = 0; index < lines.length; index++) {
    const header =
      /^CREATE (?:LOCAL |MATERIALIZED )?VIEW `((?:[^`]|``)+)`(?: \([^\r\n]*\))? AS$/
        .exec(
          lines[index],
        );
    if (header) {
      view = header[1].replaceAll("``", "`");
      before = false;
    }
    if (lines[index] === "Before optimizer") {
      require(view && !before, "diagnostic before-optimizer anchor");
      before = true;
    }
    if (lines[index] === "After optimizer ") {
      require(view && before, "diagnostic final-plan anchor");
      const final: string[] = [];
      while (index + 1 < lines.length && lines[index + 1] !== "") {
        final.push(lines[++index]);
      }
      require(index + 1 < lines.length, "truncated final-plan diagnostics");
      result.push({ view, final });
      view = undefined;
      before = false;
    }
  }
  checkDiagnostics(result, plan);
  return result;
}

export function checkDiagnostics(diagnostics: Diagnostic[], plan: Plan): void {
  const views = Object.keys(plan).filter((view) => view !== "error_view")
    .sort();
  require(
    JSON.stringify(diagnostics.map((item) => item.view).sort()) ===
      JSON.stringify(views),
    "complete final-plan diagnostics for every exported view",
  );
  for (const diagnostic of diagnostics) {
    const rels = plan[diagnostic.view].rels;
    const nodes = new Map(rels.map((node) => [node.id, node]));
    const expected: { depth: number; op: string }[] = [];
    const visit = (id: number, depth: number, path: Set<number>) => {
      const node = nodes.get(id);
      require(node && !path.has(id), "diagnostic plan topology");
      expected.push({ depth, op: node.relOp });
      const active = new Set([...path, id]);
      for (const input of node.inputs) visit(input, depth + 1, active);
    };
    require(rels.length > 0, "diagnostic plan root");
    visit(rels.at(-1)!.id, 0, new Set());
    require(
      diagnostic.final.length === expected.length,
      "complete final-plan diagnostic tree",
    );
    diagnostic.final.forEach((line, index) => {
      const node = /^( +)([A-Za-z][A-Za-z0-9_]*)\(/.exec(line);
      require(
        node && node[1].length === 4 + 2 * expected[index].depth &&
          node[2] === expected[index].op &&
          /: rowcount = .* id = [0-9]+$/.test(line),
        "final-plan diagnostic node correspondence",
      );
      require(
        !/\bFILTER\b/.test(line),
        "aggregate FILTER metadata omitted from JSON export",
      );
    });
  }
}
