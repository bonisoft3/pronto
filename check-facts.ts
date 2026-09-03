// pronto fact lint: the invariants two rungs owe each other.
//
//   deno run --allow-read=.,../../plugins/pronto --allow-run=mise \
//     ../../plugins/pronto/check-facts.ts <appDir>
//
// Runs no parser. derive.ts extracts the facts into .pronto/facts.json at
// generate; this pass hands that file to DuckDB and runs
// invariants.sql over it — so an invariant is a query a reviewer can read, not
// a tree-walk, and adding one touches no TypeScript.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

import { fileURLToPath } from "node:url";

type Finding = { severity: string; path: string; message: string };

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The fact schema, declared rather than inferred. read_json types a column
 * that is null in every row as JSON — diagram_node.name is null wherever a
 * label is prose, which is a whole app in this corpus — and joining that
 * against a VARCHAR then fails on a cast. Declaring the types costs one table
 * here and removes the dependency on what a sample happened to contain. */
const SCHEMA: Record<string, Record<string, string>> = {
  entity: { name: "VARCHAR", table: "VARCHAR", path: "VARCHAR" },
  field: { entity: "VARCHAR", name: "VARCHAR", type: "VARCHAR", cel: "VARCHAR" },
  screen: { name: "VARCHAR" },
  reads: { screen: "VARCHAR", entity: "VARCHAR" },
  chart: { screen: "VARCHAR", table: "VARCHAR", field: "VARCHAR", initial: "VARCHAR" },
  chart_state: { screen: "VARCHAR", table: "VARCHAR", field: "VARCHAR", state: "VARCHAR" },
  transition: {
    screen: "VARCHAR",
    table: "VARCHAR",
    field: "VARCHAR",
    from_state: "VARCHAR",
    event: "VARCHAR",
    to_state: "VARCHAR",
  },
  enum_value: { entity: "VARCHAR", field: "VARCHAR", value: "VARCHAR" },
  ir_path_accept: { screen: "VARCHAR", name: "VARCHAR", accept: "VARCHAR" },
  claim: { rung: "VARCHAR", kind: "VARCHAR", id: "VARCHAR", where: "VARCHAR" },
  unique_claim: { rung: "VARCHAR", kind: "VARCHAR" },
  pairing: {
    severity: "VARCHAR",
    kind_a: "VARCHAR",
    rung_a: "VARCHAR",
    kind_b: "VARCHAR",
    rung_b: "VARCHAR",
    noun: "VARCHAR",
    a_missing: "VARCHAR",
    b_missing: "VARCHAR",
  },
  artifact: { path: "VARCHAR", sha256: "VARCHAR", derived: "BOOLEAN" },
  cel_site: { entity: "VARCHAR", col: "VARCHAR", cel: "VARCHAR" },
  cel_ir: { cel: "VARCHAR" },
  owned_token: { token: "VARCHAR" },
  denied_identifier: { name: "VARCHAR", reason: "VARCHAR" },
  handler_reference: { path: "VARCHAR", name: "VARCHAR" },
  handler: { path: "VARCHAR", completion: "VARCHAR" },
  screen_token: { path: "VARCHAR", token: "VARCHAR" },
  ir_route: { id: "VARCHAR", route: "VARCHAR" },
  program_route: { id: "VARCHAR", route: "VARCHAR", where: "VARCHAR" },
  diagram_node: {
    diagram: "BIGINT",
    id: "VARCHAR",
    label: "VARCHAR",
    shape: "VARCHAR",
    name: "VARCHAR",
    kind: "VARCHAR",
  },
  diagram_edge: {
    diagram: "BIGINT",
    source: "VARCHAR",
    target: "VARCHAR",
    stroke: "VARCHAR",
    label: "VARCHAR",
  },
};

const quote = (c: string) => `"${c}"`;

/** One view per fact table, so a query names `entity` rather than a path into
 * the file. A table with no rows is declared empty rather than unnested:
 * unnest() over an empty list yields no columns at all, and every query that
 * reads the table would fail to bind. */
function views(factsPath: string, present: Set<string>): string {
  const lit = `'${factsPath.replaceAll("'", "''")}'`;
  return Object.entries(SCHEMA).map(([t, cols]) => {
    const cast = Object.entries(cols).map(([c, ty]) => `${quote(c)}::${ty} AS ${quote(c)}`).join(", ");
    const nulls = Object.entries(cols).map(([c, ty]) => `NULL::${ty} AS ${quote(c)}`).join(", ");
    return present.has(t)
      ? `CREATE VIEW ${t} AS SELECT ${cast} FROM (SELECT unnest(${t}, recursive := true) FROM read_json(${lit}));`
      : `CREATE VIEW ${t} AS SELECT * FROM (SELECT ${nulls}) WHERE false;`;
  }).join("\n");
}

async function main(appDir: string): Promise<void> {
  const factsPath = `${appDir}/.pronto/facts.json`;
  let facts: Record<string, unknown[]>;
  try {
    facts = JSON.parse(await Deno.readTextFile(factsPath));
  } catch {
    console.log(JSON.stringify([{
      severity: "error",
      path: ".pronto/facts.json",
      message: "missing or unreadable; run plugins/pronto/write.ts",
    }]));
    Deno.exit(1);
  }
  // An empty table read through unnest() yields no columns at all, so it is
  // declared rather than unnested — the same treatment as an absent one.
  const present = new Set(Object.keys(facts).filter((t) => (facts[t] ?? []).length > 0));
  const unknown = [...Object.keys(facts)].filter((t) => !(t in SCHEMA));
  if (unknown.length > 0) {
    console.log(JSON.stringify([{
      severity: "error",
      path: ".pronto/facts.json",
      message: `states ${unknown.join(", ")}, which this pass declares no view for`,
    }]));
    Deno.exit(1);
  }

  // The one precondition a query cannot state: whether the rows still describe
  // the files. Every fact below was derived from a source at a known hash and
  // every derived file was written at one, so a file that no longer hashes to
  // its row makes the rest of this pass an answer about yesterday.
  //
  // facts.json is not among them — a file cannot carry its own hash — so its
  // integrity is the review's, not this pass's.
  const moved: Finding[] = [];
  for (const row of (facts.artifact ?? []) as { path: string; sha256: string; derived: boolean }[]) {
    const bytes = await Deno.readFile(`${appDir}/${row.path}`).catch(() => null);
    const actual = bytes === null
      ? null
      : [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
    if (actual === row.sha256) continue;
    moved.push({
      severity: "error",
      path: row.path,
      message: actual === null
        ? "is gone, and the facts were derived from it"
        : row.derived
        ? "was edited after it was generated; run plugins/pronto/write.ts"
        : "has changed since the facts were derived from it; run plugins/pronto/write.ts",
    });
  }
  if (moved.length > 0) {
    console.log(JSON.stringify(moved, null, 2));
    Deno.exit(1);
  }

  const sql = `${views(factsPath, present)}\n${await Deno.readTextFile(here("invariants.sql"))}`;
  const duck = await new Deno.Command("mise", {
    args: ["x", "--", "duckdb", "-json", "-c", sql],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!duck.success) {
    console.error(new TextDecoder().decode(duck.stderr));
    console.log(JSON.stringify([{
      severity: "error",
      path: "plugins/pronto/invariants.sql",
      message: "duckdb refused the invariant queries",
    }]));
    Deno.exit(1);
  }
  const text = new TextDecoder().decode(duck.stdout).trim();
  const findings: Finding[] = text === "" ? [] : JSON.parse(text);
  console.log(JSON.stringify(findings, null, 2));
  // Severity gates the exit, as the visual battery already does: a contradiction
  // between two rungs is an error, while a promise nothing has settled yet is
  // work the ledger is meant to track rather than a program that is wrong.
  if (findings.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  await main(Deno.args[0] ?? ".");
}
