import { exists, ifMissing } from "./missing.ts";

export type SyntheticSeedOptions = {
  count?: number;
  seed?: number;
  forceFresh?: boolean;
};

export type TableRows = Record<string, Record<string, unknown>[]>;

type EntityFact = {
  name: string;
  table: string;
  durability: string;
};

type FieldFact = {
  entity: string;
  name: string;
  type?: string | null;
  cel?: string | null;
};

type FactsJson = {
  entity?: EntityFact[];
  field?: FieldFact[];
  reads?: { screen: string; entity: string }[];
};

function miseBin(): string {
  if (Deno.build.os !== "windows") return "mise";
  return `${Deno.env.get("LOCALAPPDATA")}\\mise\\bin\\mise.exe`;
}

function parseCelEnum(cel: string | null | undefined): string[] | null {
  if (!cel) return null;
  const match = cel.match(/this\s+in\s+\[(.*?)\]/);
  if (!match) return null;
  const items = match[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  return items.length > 0 ? items : null;
}

function parseCelRange(cel: string | null | undefined): { min: number; max: number } | null {
  if (!cel) return null;
  const minMatch = cel.match(/this\s*>=\s*(-?\d+)/);
  const maxMatch = cel.match(/this\s*<=\s*(-?\d+)/);
  if (minMatch && maxMatch) {
    return { min: parseInt(minMatch[1], 10), max: parseInt(maxMatch[1], 10) };
  }
  return null;
}

function findParentEntity(
  fieldName: string,
  currentTable: string,
  entities: EntityFact[],
  allowedTables?: string[],
): EntityFact | undefined {
  if (!fieldName.endsWith("_id")) return undefined;
  const candidate = fieldName.slice(0, -3).toLowerCase();
  const pool = allowedTables
    ? entities.filter((e) => allowedTables.includes(e.table))
    : entities;

  const direct = pool.find(
    (other) =>
      other.table !== currentTable &&
      (other.table.toLowerCase() === candidate ||
        other.name.toLowerCase() === candidate ||
        other.table.toLowerCase() === `${candidate}s` ||
        other.table.toLowerCase().startsWith(candidate) ||
        (candidate.includes("_") && other.table.toLowerCase() === candidate.split("_").pop())),
  );
  if (direct) return direct;

  const userRoles = ["author", "follower", "followed", "user", "challenger", "target", "player", "owner"];
  if (userRoles.includes(candidate)) {
    const userParent = pool.find(
      (other) =>
        other.table !== currentTable &&
        ["app_user", "user", "users", "account", "profile"].includes(other.table.toLowerCase()),
    );
    if (userParent) return userParent;
  }

  return undefined;
}

function sortEntitiesTopologically(
  entities: EntityFact[],
  fieldsByEntity: Map<string, FieldFact[]>,
): EntityFact[] {
  const entityByName = new Map<string, EntityFact>();
  const entityByTable = new Map<string, EntityFact>();
  for (const e of entities) {
    entityByName.set(e.name, e);
    entityByTable.set(e.table, e);
  }

  const dependencies = new Map<string, Set<string>>();
  for (const e of entities) {
    const deps = new Set<string>();
    const fields = fieldsByEntity.get(e.name) ?? [];
    for (const f of fields) {
      const parent = findParentEntity(f.name, e.table, entities);
      if (parent) {
        deps.add(parent.table);
      }
    }
    dependencies.set(e.table, deps);
  }

  const sorted: EntityFact[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(table: string) {
    if (visited.has(table)) return;
    if (visiting.has(table)) return; // cycle break
    visiting.add(table);
    const deps = dependencies.get(table) ?? new Set();
    for (const dep of deps) {
      if (entityByTable.has(dep)) visit(dep);
    }
    visiting.delete(table);
    visited.add(table);
    const ent = entityByTable.get(table);
    if (ent && !sorted.includes(ent)) {
      sorted.push(ent);
    }
  }

  for (const e of entities) {
    visit(e.table);
  }

  return sorted;
}

export async function generateSyntheticSeeds(
  appDir: string,
  options: SyntheticSeedOptions = {},
): Promise<TableRows> {
  const count = options.count ?? 3;
  const seed = options.seed ?? 0.42;

  if (!options.forceFresh) {
    const raw = await ifMissing(Deno.readTextFile(`${appDir}/.pronto/seeds.json`), null);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return parsed as TableRows;
    }
  }

  const factsText = await ifMissing(Deno.readTextFile(`${appDir}/.pronto/facts.json`), null);
  if (factsText === null) throw new Error(`${appDir}/.pronto/facts.json is missing: run derive first`);
  const facts: FactsJson = JSON.parse(factsText);

  const entities = facts.entity ?? [];
  if (entities.length === 0) return {};

  const availableScreens = [...new Set(facts.reads?.map((r) => r.screen) ?? [])];
  const defaultRoute = availableScreens[0] ?? "home";

  const fieldsByEntity = new Map<string, FieldFact[]>();
  for (const f of facts.field ?? []) {
    if (!fieldsByEntity.has(f.entity)) fieldsByEntity.set(f.entity, []);
    fieldsByEntity.get(f.entity)!.push(f);
  }

  const sortedEntities = sortEntitiesTopologically(entities, fieldsByEntity);

  const sqlLines: string[] = [
    `SELECT setseed(${seed});`,
  ];

  const tableList: string[] = [];

  for (const e of sortedEntities) {
    const fields = fieldsByEntity.get(e.name) ?? [];
    if (fields.length === 0) continue;

    tableList.push(e.table);

    const colDefs: string[] = [];
    const selectCols: string[] = [];

    const hasId = fields.some((f) => f.name === "id");
    if (!hasId) {
      colDefs.push("id TEXT");
      selectCols.push(`'${e.table}_' || i::TEXT AS id`);
    }

    const curFields = fields.filter((f) => f.name.startsWith("cur_")).map((f) => f.name);
    const chkFields = fields.filter((f) => f.name.startsWith("chk_")).map((f) => f.name);
    const expFields = fields.filter((f) => f.name.startsWith("exp_")).map((f) => f.name);

    for (const f of fields) {
      const type = (f.type ?? "string").toLowerCase();
      const enums = parseCelEnum(f.cel);
      const range = parseCelRange(f.cel);

      let colType = "TEXT";
      let colVal = `'seed_${f.name}_' || i::TEXT`;

      if (f.name === "id") {
        colType = "TEXT";
        colVal = type.includes("uuid")
          ? `uuid()::TEXT`
          : `'${e.table}_' || lpad(i::TEXT, 4, '0')`;
      } else if (f.name.endsWith("_id")) {
        const parent = findParentEntity(f.name, e.table, sortedEntities, tableList);
        colType = "TEXT";
        if (parent) {
          colVal = `(SELECT id FROM "${parent.table}" ORDER BY hash(id || '_' || i::TEXT || '_${f.name}') LIMIT 1)`;
        } else {
          colVal = `'seed_${f.name}_' || i::TEXT`;
        }
      } else if (curFields.includes(f.name)) {
        colType = "TEXT";
        const curIdx = curFields.indexOf(f.name);
        colVal = `CASE WHEN ((i - 1) % ${curFields.length}) = ${curIdx} THEN 'true' ELSE 'false' END`;
      } else if (chkFields.length > 1 && chkFields.includes(f.name)) {
        colType = "TEXT";
        const chkIdx = chkFields.indexOf(f.name);
        colVal = `CASE WHEN ((i - 1) % ${chkFields.length}) = ${chkIdx} THEN 'true' ELSE 'false' END`;
      } else if (expFields.length > 1 && expFields.includes(f.name)) {
        colType = "TEXT";
        const expIdx = expFields.indexOf(f.name);
        colVal = `CASE WHEN ((i - 1) % ${expFields.length}) = ${expIdx} THEN 'true' ELSE 'false' END`;
      } else if (enums && enums.length > 0) {
        colType = "TEXT";
        const arr = enums.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
        colVal = `(ARRAY[${arr}])[((i - 1) % ${enums.length}) + 1]`;
      } else if (range) {
        colType = "BIGINT";
        colVal = `${range.min} + ((i - 1) % (${range.max - range.min + 1}))`;
      } else if (type.includes("int")) {
        colType = "BIGINT";
        colVal = `(i * 10)::BIGINT`;
      } else if (type.includes("bool")) {
        colType = "TEXT";
        const usesTrue = f.cel?.includes("true") || f.cel?.includes("false");
        colVal = usesTrue
          ? `CASE WHEN i % 2 = 1 THEN 'true' ELSE 'false' END`
          : `CASE WHEN i % 2 = 1 THEN 'yes' ELSE 'no' END`;
      } else if (type.includes("duration")) {
        colType = "TEXT";
        colVal = `'PT' || (i * 300)::TEXT || 'S'`;
      } else if (type.includes("timestamp") || f.name.endsWith("_at") || f.name === "at" || f.name.endsWith("_date") || f.name === "date") {
        colType = "TEXT";
        colVal = `strftime('2026-09-24T00:00:00Z'::TIMESTAMP - INTERVAL (i * 3600) SECOND, '%Y-%m-%dT%H:%M:%SZ')`;
      } else if (f.name === "current") {
        colType = "TEXT";
        colVal = `CASE WHEN i = 1 THEN 'yes' ELSE 'no' END`;
      } else if (f.name === "route") {
        colType = "TEXT";
        colVal = `'${defaultRoute}'`;
      } else if (f.name === "status") {
        colType = "TEXT";
        colVal = `'active'`;
      } else if (f.name.includes("name") || f.name === "title") {
        colType = "TEXT";
        colVal = `'Sample ' || '${f.name} ' || i::TEXT`;
      }

      colDefs.push(`"${f.name}" ${colType}`);
      selectCols.push(`${colVal} AS "${f.name}"`);
    }

    sqlLines.push(`CREATE TABLE "${e.table}" (${colDefs.join(", ")});`);
    sqlLines.push(
      `INSERT INTO "${e.table}" SELECT ${selectCols.join(", ")} FROM range(1, ${count + 1}) t(i);`,
    );
  }

  const jsonAggs = tableList.map(
    (t) => `'${t}', (SELECT coalesce(json_group_array(to_json(row)), '[]'::JSON) FROM "${t}" row)`,
  );
  sqlLines.push(`SELECT json_object(${jsonAggs.join(", ")}) AS payload;`);

  const fullSql = sqlLines.join("\n");

  const child = new Deno.Command(miseBin(), {
    args: ["x", "--", "duckdb", "-json"],
    cwd: appDir,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(fullSql));
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`DuckDB synthetic seed generation failed for ${appDir}: ${err}`);
  }

  const text = new TextDecoder().decode(output.stdout).trim();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (Array.isArray(parsed) && parsed[0]?.payload) {
        return parsed[0].payload as TableRows;
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }

  throw new Error(`DuckDB did not return expected payload for ${appDir}: ${text}`);
}

export async function writeSyntheticSeeds(
  appDir: string,
  options: SyntheticSeedOptions = {},
): Promise<string> {
  const seeds = await generateSyntheticSeeds(appDir, options);
  const prontoDir = `${appDir}/.pronto`;
  await Deno.mkdir(prontoDir, { recursive: true });
  const outPath = `${prontoDir}/seeds.json`;
  await Deno.writeTextFile(outPath, JSON.stringify(seeds, null, 2) + "\n");
  return outPath;
}

if (import.meta.main) {
  const targetDir = Deno.args[0];
  if (targetDir) {
    await writeSyntheticSeeds(targetDir, { forceFresh: true });
  } else {
    for await (const entry of Deno.readDir("apps")) {
      if (entry.isDirectory) {
        if (!(await exists(`apps/${entry.name}/.pronto/facts.json`))) continue;
        await writeSyntheticSeeds(`apps/${entry.name}`, { forceFresh: true });
      }
    }
  }
}
