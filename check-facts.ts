// pronto fact lint: the invariants two rungs owe each other.
//
//   deno run --allow-read=.,../../plugins/pronto --allow-run=mise \
//     ../../plugins/pronto/check-facts.ts <appDir>
//
// Parses nothing of the app's. derive.ts extracts the facts into
// .pronto/facts.json at generate; this pass hands that file to DuckDB and runs
// invariants.sql over it — so an invariant is a query a reviewer can read, not
// a tree-walk, and adding one touches no TypeScript.
//
// It runs invariants.sql twice: over the style cases' fixture (fixtureFailures
// says why it lives here), then over the app.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

import { fileURLToPath } from "node:url";
import {
  designCssFacts,
  type Facts,
  importFacts,
  literalFacts,
  mergeFacts,
  scaleFacts,
  sha256Hex,
  styleFacts,
  vendorFacts,
} from "./facts.ts";
import { readVendored, vendorDeclarationsOf } from "./scales.ts";
import {
  casePath,
  EXCEPTION_REASONS,
  FIXTURE_DESIGN_CSS,
  FIXTURE_ROLES,
  FIXTURE_SCALE,
  FIXTURE_VENDOR_CSS,
  FIXTURE_VENDOR_EXCLUSIONS,
  FIXTURE_VENDOR_SOURCE,
  fixtureOwned,
  fixtureServed,
  lengthLiterals,
  literalExceptions,
  LITERAL_CASES,
  ownedTokens,
  resolveImports,
  type Scale,
  scaleDeclarations,
  scaleSources,
  scaleSteps,
  tokenDeclarations,
} from "./styles.ts";

type Finding = { severity: string; path: string; message: string };

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const invariants = Deno.readTextFile(here("invariants.sql"));

/** The fact schema, declared rather than inferred. read_json types a column
 * that is null in every row as JSON — diagram_node.name is null wherever a
 * label is prose, which is a whole app in this corpus — and joining that
 * against a VARCHAR then fails on a cast. Declaring the types costs one table
 * here and removes the dependency on what a sample happened to contain. */
const SCHEMA: Record<string, Record<string, string>> = {
  entity: { name: "VARCHAR", table: "VARCHAR", durability: "VARCHAR" },
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
  app_token: { path: "VARCHAR", token: "VARCHAR" },
  scale_step: { token: "VARCHAR", dimension: "VARCHAR", norm: "VARCHAR", kind: "VARCHAR" },
  app_literal: {
    path: "VARCHAR",
    line: "BIGINT",
    prop: "VARCHAR",
    value: "VARCHAR",
    dimension: "VARCHAR",
    norm: "VARCHAR",
    decl: "BIGINT",
  },
  literal_exception: {
    path: "VARCHAR",
    line: "BIGINT",
    prop: "VARCHAR",
    reason: "VARCHAR",
    witnessed: "BOOLEAN",
    decl: "BIGINT",
  },
  exception_reason: { reason: "VARCHAR" },
  design_budget: { pending_literals: "BIGINT" },
  vendor_source: { name: "VARCHAR", origin: "VARCHAR", version: "VARCHAR" },
  vendor_declaration: { source: "VARCHAR", token: "VARCHAR", value: "VARCHAR" },
  vendor_exclusion: { source: "VARCHAR", pattern: "VARCHAR", reason: "VARCHAR" },
  scale_source: { name: "VARCHAR", kind: "VARCHAR", origin: "VARCHAR", version: "VARCHAR" },
  scale_declaration: { token: "VARCHAR", value: "VARCHAR", source: "VARCHAR", kind: "VARCHAR" },
  design_declaration: {
    block: "VARCHAR",
    token: "VARCHAR",
    value: "VARCHAR",
    colored: "BOOLEAN",
  },
  design_reference: { block: "VARCHAR", token: "VARCHAR", ref: "VARCHAR" },
  served_file: { file: "VARCHAR", target: "VARCHAR" },
  app_import: { path: "VARCHAR", line: "BIGINT", target: "VARCHAR", resolved: "VARCHAR" },
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
 * reads the table would fail to bind.
 *
 * `live` overrides the file for tables read at query time rather than at
 * derivation: the vendored archives are not the app's and are not derived from
 * anything, so a row snapshotting them could go stale and the quotation rule
 * would then hold the vocabulary against bytes that have moved — which is
 * exactly the silence the rule exists to break. */
function views(factsPath: string, present: Set<string>, live: Facts): string {
  const lit = `'${factsPath.replaceAll("'", "''")}'`;
  return Object.entries(SCHEMA).map(([t, cols]) => {
    if (live[t] !== undefined) return valuesView(t, cols, live[t]);
    const cast = Object.entries(cols).map(([c, ty]) => `${quote(c)}::${ty} AS ${quote(c)}`).join(", ");
    return present.has(t)
      ? `CREATE VIEW ${t} AS SELECT ${cast} FROM (SELECT unnest(${t}, recursive := true) FROM read_json(${lit}));`
      : emptyView(t, cols);
  }).join("\n");
}

const emptyView = (t: string, cols: Record<string, string>) =>
  `CREATE VIEW ${t} AS SELECT * FROM (SELECT ${
    Object.entries(cols).map(([c, ty]) => `NULL::${ty} AS ${quote(c)}`).join(", ")
  }) WHERE false;`;

function valuesView(t: string, cols: Record<string, string>, rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return emptyView(t, cols);
  const values = rows
    .map((r) => `(${Object.entries(cols).map(([c, ty]) => literal(r[c], ty)).join(", ")})`)
    .join(", ");
  return `CREATE VIEW ${t} AS SELECT * FROM (VALUES ${values}) AS t(${Object.keys(cols).map(quote).join(", ")});`;
}

/** One fact, as a typed SQL literal — the column types are declared above, so a
 * column that is null in every fixture row still binds. */
function literal(value: unknown, type: string): string {
  if (value === null || value === undefined) return `NULL::${type}`;
  if (type === "BOOLEAN") return value === true ? "TRUE" : "FALSE";
  if (type === "BIGINT") return `${Number(value)}::BIGINT`;
  return `'${String(value).replaceAll("'", "''")}'::VARCHAR`;
}

/** The same views over facts held in memory, so the fixture below needs no file. */
function inlineViews(facts: Facts): string {
  return Object.entries(SCHEMA).map(([t, cols]) => valuesView(t, cols, facts[t] ?? [])).join("\n");
}

function miseEnv(): Record<string, string> | undefined {
  if (Deno.build.os !== "windows") return undefined;
  const keep = [
    "APPDATA", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles", "SystemRoot", "TEMP",
    "TMP", "USERPROFILE", "USERNAME", "WINDIR", "MISE_TRUSTED_CONFIG_PATHS", "MISE_WINDOWS_SHIM_MODE",
  ];
  const env = Object.fromEntries(keep.flatMap((name) => {
    const value = Deno.env.get(name);
    return value === undefined ? [] : [[name, value]];
  }));
  const path = [
    `${env.USERPROFILE}\\.local\\bin`,
    `${env.USERPROFILE}\\.local\\share\\mise\\shims`,
    `${env.LOCALAPPDATA}\\mise\\bin`,
    `${env.LOCALAPPDATA}\\mise\\shims`,
    `${env.ProgramFiles}\\Git\\cmd`,
    `${env.ProgramFiles}\\Git\\bin`,
    `${env.SystemRoot}\\System32`,
    env.SystemRoot,
  ].filter((value) => !value.startsWith("undefined"));
  return { ...env, PATH: path.join(";") };
}

function miseBin(env: Record<string, string> | undefined): string {
  if (Deno.build.os !== "windows") return "mise";
  return `${env?.LOCALAPPDATA}\\mise\\bin\\mise.exe`;
}

/** duckdb over one script. A non-zero exit is a precondition failure — the tool
 * missing, or the SQL itself refusing to parse — and raises with duckdb's own
 * words rather than grading as findings. */
async function query(sql: string, cwd: string): Promise<Finding[]> {
  const env = miseEnv();
  const child = new Deno.Command(miseBin(env), {
    args: ["x", "--", "duckdb", "-json"],
    cwd,
    clearEnv: Deno.build.os === "windows",
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = child.stdin.getWriter();
  await input.write(new TextEncoder().encode(sql));
  await input.close();
  const duck = await child.output();
  if (!duck.success) {
    throw new Error(`duckdb refused the queries: ${new TextDecoder().decode(duck.stderr).trim()}`);
  }
  const text = new TextDecoder().decode(duck.stdout).trim();
  return text === "" ? [] : JSON.parse(text);
}

/**
 * The style rules run over their own fixture, by the file that IS the rule of
 * record. One stylesheet per case, each at its own path, so a case is graded by
 * the findings carrying its path — including the ledger row a hatch prints,
 * since a hatch reporting nothing would be a silence.
 *
 * Grading these in TypeScript instead would grade a second implementation, and
 * the two would diverge in the direction nothing checks: a rule dropped from the
 * SQL would still pass. So the fixture rides here, where duckdb already is,
 * rather than in derive.ts's self-test, where it cannot be run.
 */
async function fixtureFailures(appDir: string, scale: Scale = FIXTURE_SCALE): Promise<string[]> {
  const sheets = LITERAL_CASES.map((c, i) => ({
    path: casePath(i),
    literals: lengthLiterals(c.css),
    exceptions: literalExceptions(c.css),
  }));
  const facts = mergeFacts(
    styleFacts(
      fixtureOwned(),
      LITERAL_CASES.map((c, i) => ({ path: casePath(i), tokens: ownedTokens(c.css) })),
    ),
    literalFacts(
      scaleSteps(scale, FIXTURE_ROLES),
      sheets,
      EXCEPTION_REASONS,
      LITERAL_CASES.filter((c) => c.debt).length,
    ),
    scaleFacts(scaleSources(scale), scaleDeclarations(scale)),
    designCssFacts(tokenDeclarations(FIXTURE_DESIGN_CSS)),
    vendorFacts({
      sources: [FIXTURE_VENDOR_SOURCE],
      declarations: vendorDeclarationsOf(FIXTURE_VENDOR_SOURCE.name, FIXTURE_VENDOR_CSS),
      exclusions: FIXTURE_VENDOR_EXCLUSIONS,
    }),
    importFacts(
      fixtureServed(),
      resolveImports(LITERAL_CASES.map((c, i) => ({ path: casePath(i), css: c.css, base: "/srv" }))),
    ),
  );
  const sql = `${inlineViews(facts)}\n${await invariants}`;
  const findings = await query(sql, appDir);

  const failures: string[] = [];
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  LITERAL_CASES.forEach((c, i) => {
    const got = byPath.get(casePath(i)) ?? [];
    byPath.delete(casePath(i));
    if (got.length !== c.want) {
      failures.push(
        `want ${c.want} findings, got ${got.length} (${got.map((f) => f.message).join("; ")}) — ` +
          `${c.pins}: ${JSON.stringify(c.css)}`,
      );
    } else if (c.token !== undefined && !got.some((f) => f.message.includes(`var(${c.token})`))) {
      failures.push(
        `want the finding to name ${c.token}, got ${JSON.stringify(got.map((f) => f.message))} — ` +
          `${c.pins}: ${JSON.stringify(c.css)}`,
      );
    }
  });
  // A rule the fixture satisfies must report nothing anywhere else either: an
  // emptiness guard firing here would mean the fixture stopped carrying a table.
  for (const [path, rows] of byPath) {
    failures.push(`${path}: ${rows.map((f) => f.message).join("; ")}`);
  }
  return failures;
}

/**
 * The witness, exercised from the side a positive fixture cannot reach: a rung no
 * vendored tree declares, published under a source relabelled `own`.
 *
 * The relabel is the whole point. `kind` is authored, so a witness reading it is
 * disarmed by one line that reads entirely plausible beside the sources that
 * really are this repository's — and the fabricated rung then ships under the
 * vendor's own prefix, graded by no archive. So the rule keys on a vendored TREE
 * answering the bucket's source name, and this asserts the relabel buys nothing.
 */
async function witnessFailures(appDir: string): Promise<string[]> {
  const scale: Scale = {
    ...FIXTURE_SCALE,
    sources: {
      ...FIXTURE_SCALE.sources,
      fixture: { ...FIXTURE_SCALE.sources.fixture, kind: "own", version: "this repository" },
    },
    buckets: {
      ...FIXTURE_SCALE.buckets,
      layer: {
        ...FIXTURE_SCALE.buckets.layer,
        steps: { ...FIXTURE_SCALE.buckets.layer.steps, "99": "99" },
      },
    },
  };
  return convictedOnce(
    appDir,
    scale,
    ["--layer-99", "declares no such name"],
    "a rung no vendored tree declares must be convicted however its source is labelled, " +
      "and relabelling the source `own` silenced the witness",
  );
}

/**
 * The provenance, from the side the witness cannot reach: a source that calls
 * itself `quoted` and names an archive no tree under scales/ carries.
 *
 * Bucket-less on purpose. Every other quotation rule keys on a published step,
 * so a bucket would be the cheap way to convict this source — and it would also
 * publish a rung the fixture's design.css does not declare, adding a second
 * finding this assertion would have to filter around. With no bucket, the row
 * below is the only one, which is what proves the rule keys on the source.
 *
 * The acquittal needs no case of its own: the positive fixture carries `pronto`,
 * an `own` source no tree answers, and stays green.
 */
async function provenanceFailures(appDir: string): Promise<string[]> {
  const scale: Scale = {
    ...FIXTURE_SCALE,
    sources: {
      ...FIXTURE_SCALE.sources,
      phantom: { kind: "quoted", origin: "a vocabulary nobody vendored", version: "9.9.9" },
    },
  };
  return convictedOnce(
    appDir,
    scale,
    ["phantom", "no tree under scales/ answers that name"],
    "a source that calls itself quoted must name an archive some tree under scales/ carries, " +
      "and a fabricated one passed",
  );
}

/** A perturbed fixture scale, and exactly one finding naming every needle. */
async function convictedOnce(appDir: string, scale: Scale, needles: string[], owed: string): Promise<string[]> {
  const found = (await fixtureFailures(appDir, scale)).filter((m) => needles.every((n) => m.includes(n)));
  return found.length === 1 ? [] : [`${owed} (matched ${found.length})`];
}

async function main(appDir: string): Promise<void> {
  const fixture = (await Promise.all([
    fixtureFailures(appDir),
    witnessFailures(appDir),
    provenanceFailures(appDir),
  ])).flat();
  if (fixture.length > 0) {
    console.log(JSON.stringify(
      fixture.map((message) => ({ severity: "error", path: "plugins/pronto/invariants.sql", message })),
      null,
      2,
    ));
    Deno.exit(1);
  }

  // Absolute, because duckdb resolves read_json() against its own cwd, which is
  // appDir.
  const factsPath = `${await Deno.realPath(appDir)}/.pronto/facts.json`;
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
      : await sha256Hex(bytes);
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

  // Read at check time, not at derivation: see views(). This is also what lets the rule
  // run in an app whose facts.json predates a vocabulary change.
  const live = vendorFacts(await readVendored());
  const sql = `${views(factsPath, present, live)}\n${await invariants}`;
  const findings = await query(sql, appDir);
  console.log(JSON.stringify(findings, null, 2));
  // Severity gates the exit, as the visual battery already does: a contradiction
  // between two rungs is an error, while a promise nothing has settled yet is
  // work the ledger is meant to track rather than a program that is wrong.
  if (findings.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  await main(Deno.args[0] ?? ".");
}
