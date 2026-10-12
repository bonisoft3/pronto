// Seed rows held as data (#App.state.seed): read, judged, and rendered with
// the stated ones into 900_seed.sql.
//
// Held rows stay out of the program's package because CUE re-judges a row in
// it on every evaluation; they are judged here instead, by `cue vet` against
// the program's own #Seed, and only when what the judgement depends on moved.
import { checkTypeSeeds, type TypeEntity } from "./type-check.ts";
import { sha256Hex } from "./facts.ts";

export type Row = Record<string, unknown>;
export type Held = Record<string, Row[]>;

/** The emission's `seed-sql` entry (emit.cue #seedData). */
export type SeedData = {
  src?: string;
  entities: { name: string; table: string; columns: { name: string; type?: string; from?: string }[]; rows: Row[] }[];
};

/** A seed file, as {"<Entity>": [row, ...]}; anything else is refused. */
export function parseHeld(src: string, text: string): Held {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${src}: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${src}: is not an object of entity names to rows`);
  }
  for (const [entity, rows] of Object.entries(parsed)) {
    if (!Array.isArray(rows) || rows.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
      throw new Error(`${src}: ${entity} is not a list of rows`);
    }
  }
  return parsed as Held;
}

/** An entity's rows have one home: what the program states, or what the file holds. */
export function oneHome(src: string, stated: Record<string, { seed?: Row[] }>, held: Held): void {
  for (const [entity, rows] of Object.entries(held)) {
    if (rows.length > 0 && (stated[entity]?.seed ?? []).length > 0) {
      throw new Error(`${src}: ${entity} has rows in the program and in ${src}; keep them in one`);
    }
  }
}

// CUE's json.Marshal, which escapes the two line terminators JSON.stringify
// leaves bare.
const marshal = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

function literal(where: string, v: unknown): string {
  if (typeof v === "string") return quote(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  throw new Error(`${where}: ${JSON.stringify(v)} is not a string, a bool or an int a JSON reader holds exactly`);
}

/** 900_seed.sql's body: per entity in program order, its rows in order. */
export function seedSql(data: SeedData, held: Held): string {
  const src = data.src ?? "";
  const known = new Set(data.entities.map((e) => e.name));
  for (const entity of Object.keys(held)) {
    if (!known.has(entity)) throw new Error(`${src}: ${entity} is not a server entity of the program`);
  }
  oneHome(src, Object.fromEntries(data.entities.map((e) => [e.name, { seed: e.rows }])), held);
  const blocks: string[] = [];
  for (const e of data.entities) {
    const rows = e.rows.length > 0 ? e.rows : held[e.name] ?? [];
    if (rows.length === 0) continue;
    const columns = new Map(e.columns.map((c) => [c.name, c]));
    blocks.push(rows.map((row, i) => {
      const where = `${e.name}[${i}]`;
      for (const k of Object.keys(row)) {
        if (!columns.has(k)) throw new Error(`${where}: ${k} is not a field of ${e.name}`);
      }
      const present = e.columns.filter((c) => c.name in row);
      const values = present.map((c) => {
        const v = row[c.name];
        const at = `${where}.${c.name}`;
        if (c.from !== undefined) {
          literal(at, v);
          return `${c.from}(${quote(marshal(v))}::json)`;
        }
        // A JSON null is absence, as PostgREST stores it.
        if (c.type === "json" && v === null) return "NULL";
        // A base-typed column reads the value as SQL spells it; its CHECK
        // judges it there, as a domain's representation function would.
        if (c.type === "json" || c.type === "geojson") return `${quote(marshal(v))}::json`;
        if (c.type === "double" && typeof v === "number" && Number.isFinite(v)) return String(v);
        return literal(at, v);
      });
      return `INSERT INTO ${e.table} (${present.map((c) => c.name).join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT (id) DO NOTHING;`;
    }).join("\n"));
  }
  return blocks.join("\n") + "\n";
}

/** The inputs a held seed's verdict depends on: its bytes, the entities that
 * judge it (fields, types, cel), the constraints derived from their cel, and
 * the type table and entity schema pronto judges every row with. */
export async function seedKey(bytes: Uint8Array, entities: unknown, programCel: string): Promise<string> {
  const pronto = await Promise.all(
    ["types.cue", "schema.cue"].map((f) => Deno.readFile(new URL(`./${f}`, import.meta.url)).then(sha256Hex)),
  );
  const text = JSON.stringify({ seed: await sha256Hex(bytes), entities, programCel, pronto });
  return sha256Hex(new TextEncoder().encode(text));
}

/** Judges held rows the way stated ones are: CUE unifies each with its
 * entity's seed constraint (#Seed), then the `beyond` checks run. Throws on
 * the first refusal; cue's own report, naming the row, goes to stderr. */
export async function vetHeld(appDir: string, src: string, held: Held, entities: Record<string, TypeEntity>): Promise<void> {
  const vet = await new Deno.Command("cue", {
    args: ["vet", "-d", "code.#Seed", ".", src],
    cwd: appDir,
    stderr: "inherit",
  }).output();
  if (!vet.success) throw new Error(`${src}: a row does not satisfy its entity (cue's report above)`);
  checkTypeSeeds(Object.fromEntries(
    Object.entries(held).map(([name, seed]) => [name, { fields: entities[name].fields, seed }]),
  ));
}
