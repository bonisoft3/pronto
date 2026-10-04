import { seedSql } from "./seed.ts";
import { generateTypeSQL } from "./type-sql.ts";
import { typeTable } from "./type-table.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const POSTGREST = "postgrest/postgrest:v12.2.3@sha256:0a46780309a604cdc8b56c776c6e5e15788ce58174d709e40459ab5a2d44d228";
const ELECTRIC = "docker.io/bonitao/electric:1.8.0@sha256:7b6aed2d5fd356a5e5edd5290eeec0b19859ab798d3cbdb7d9d223fbb872a5ab";

function fail(message: string): never {
  throw new Error(message);
}

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(result.stdout);
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return text;
}

async function dockerFails(args: string[]): Promise<void> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (result.success) fail(`docker ${args.join(" ")} unexpectedly succeeded`);
}

async function eventually<T>(attempt: () => Promise<T>, acceptable: (value: T) => boolean): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      const value = await attempt();
      if (acceptable(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`service did not become ready: ${last}`);
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
}

// The six domain types keep a representation PostgREST calls at its boundary;
// the other nine are base-typed columns whose default JSON output already is
// the canonical spelling, which is why their domain could go. Input at the
// boundary is liberal on purpose (Postel): what a base type parses, it takes.
Deno.test({ name: "PostgREST answers every type canonically, and Electric compares exactly the types types.cue marks `subset`", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const network = `type-http-${suffix}`;
  const database = `type-db-${suffix}`;
  const rest = `type-rest-${suffix}`;
  const electric = `type-electric-${suffix}`;
  let databaseStarted = false;
  let restStarted = false;
  let electricStarted = false;
  let networkStarted = false;
  const scratch = await Deno.makeTempDir({ prefix: "pronto-type-http-" });
  const table = typeTable();
  const types = Object.keys(table.types);
  // The column each type is held in, as the emitter writes it.
  const columns = await new Deno.Command("cue", {
    args: ["export", ".", "--out", "json", "-e",
      `[for t in ${JSON.stringify(types)} {(#colSql & {f: {name: "\\(t)_value", type: t, required: true, if t == "decimal" {precision: 18, scale: 2}}, table: "type_http_smoke"}).out}, ` +
        `(#colSql & {f: {name: "json_optional", type: "json", required: false}, table: "type_http_smoke"}).out]`],
    cwd: new URL(".", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!columns.success) fail(`cue export of #colSql failed: ${new TextDecoder().decode(columns.stderr).trim()}`);
  const column: string[] = JSON.parse(new TextDecoder().decode(columns.stdout));
  const schema = `${generateTypeSQL([{ precision: 18, scale: 2 }])}
CREATE ROLE anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon;
CREATE TABLE public.type_http_smoke (
  id integer PRIMARY KEY,
${column.map((c) => `  ${c}`).join(",\n")}
);
GRANT SELECT, INSERT, UPDATE ON public.type_http_smoke TO anon;
ALTER TABLE public.type_http_smoke REPLICA IDENTITY FULL;
CREATE PUBLICATION electric_publication_default FOR TABLE public.type_http_smoke;
`;
  try {
    await Deno.writeTextFile(`${scratch}/001-types.sql`, schema);
    await docker(["network", "create", network]);
    networkStarted = true;
    await docker(["run", "--rm", "-d", "--name", database, "--network", network,
      "-e", "POSTGRES_PASSWORD=type_pwd", "-e", "POSTGRES_DB=type_db",
      "-v", `${scratch}/001-types.sql:/docker-entrypoint-initdb.d/001-types.sql:ro`, POSTGRES,
      "postgres", "-c", "wal_level=logical"]);
    databaseStarted = true;
    await eventually(() => docker(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-c", "SELECT 1 FROM public.type_http_smoke LIMIT 0"]), () => true);
    await docker(["run", "--rm", "-d", "--name", rest, "--network", network, "-p", "127.0.0.1::3000",
      "-e", "PGRST_DB_URI=postgres://postgres:type_pwd@" + database + ":5432/type_db",
      "-e", "PGRST_DB_SCHEMA=public", "-e", "PGRST_DB_ANON_ROLE=anon", POSTGREST]);
    restStarted = true;
    const port = (await docker(["port", rest, "3000/tcp"])).trim().match(/:(\d+)$/)?.[1] ?? fail("PostgREST did not publish a host port");
    const base = `http://127.0.0.1:${port}/type_http_smoke`;
    await eventually(async () => {
      const response = await request(base);
      const status = response.status;
      await response.body?.cancel();
      return status;
    }, (status) => status === 200);

    const row: Record<string, unknown> = {
      id: 1, string_value: "type_val", bool_value: true, int32_value: -7, int64_value: "9223372036854775807", double_value: 1.5,
      bytes_value: "YWJj", uuid_value: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e",
      timestamp_value: "2026-09-21T11:00:00.123456Z", date_value: "2026-09-21", time_value: "11:00:00.123456",
      timezone_value: "America/Sao_Paulo", duration_value: "PT0.1S", decimal_value: "12.3", json_value: { a: [1, "x"] },
      geojson_value: { type: "Feature", geometry: { type: "Point", coordinates: [-46.6, -23.5] }, properties: {} },
    };
    if (JSON.stringify(Object.keys(row).filter((k) => k !== "id").sort()) !== JSON.stringify(types.map((t) => `${t}_value`).sort())) {
      fail("the row does not hold one value of every type the table names");
    }
    let response = await request(base, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
    if (!response.ok) fail(`all-type insert: ${response.status} ${await response.text()}`);
    const [inserted] = await response.json();
    for (const [key, value] of Object.entries(row)) {
      if (JSON.stringify(inserted[key]) !== JSON.stringify(value)) fail(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(inserted[key])}`);
    }

    const repeated = Array.from({ length: 10 }, (_, index) => ({ ...row, id: index + 2 }));
    response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(repeated) });
    if (!response.ok) fail(`repeated valid casts: ${response.status} ${await response.text()}`);
    response = await request(`${base}?select=id&order=id`);
    if (!response.ok || (await response.json()).length !== 11) fail("PostgREST did not retain all repeated valid inputs");

    // Liberal in: a base type takes whatever Postgres parses into it. Strict
    // out: what comes back is the canonical spelling all the same.
    const liberal = { ...row, id: 12, int32_value: "1", uuid_value: "8C1F3A56-7E0B-4E3D-9C62-6A6FCB7B4A5E", bool_value: "t", double_value: "2.50" };
    response = await request(base, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(liberal) });
    if (!response.ok) fail(`liberal input: ${response.status} ${await response.text()}`);
    const [normalized] = await response.json();
    for (const [key, value] of Object.entries({ int32_value: 1, uuid_value: row.uuid_value, bool_value: true, double_value: 2.5 })) {
      if (JSON.stringify(normalized[key]) !== JSON.stringify(value)) fail(`${key} canonical output: ${JSON.stringify(normalized[key])}`);
    }

    // A JSON null is absence, of a json column as of every other: PostgREST
    // hands a column with no cast a JSON null as SQL NULL, and 900_seed.sql
    // writes one the same way. Regression: json's domain read it as the json
    // value null, so a NOT NULL json field took a null no other type takes,
    // and a json column was the one whose null was a value.
    const psql = (sql: string) => docker(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-v", "ON_ERROR_STOP=1", "-Atc", sql]);
    response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...row, id: 13, json_optional: null }) });
    if (!response.ok) fail(`a JSON null inserted: ${response.status} ${await response.text()}`);
    response = await request(`${base}?id=eq.1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json_optional: { a: 1 } }) });
    if (!response.ok) fail(`a json value patched: ${response.status} ${await response.text()}`);
    response = await request(`${base}?id=eq.1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json_optional: null }) });
    if (!response.ok) fail(`a JSON null patched: ${response.status} ${await response.text()}`);
    // 900_seed.sql's spelling of the row, each column as #seedData describes it.
    const seed = (rows: Record<string, unknown>[]) => seedSql({
      entities: [{
        name: "Smoke",
        table: "type_http_smoke",
        columns: [{ name: "id", type: "int32" }, { name: "json_optional", type: "json" }, ...types.map((t) => ({
          name: `${t}_value`,
          type: t,
          ...(table.types[t].column === "domain" ? { from: `public.${t === "decimal" ? "portable_decimal_18_2" : table.types[t].sql}_from_json` } : {}),
        }))],
        rows,
      }],
    }, {});
    await psql(seed([{ ...row, id: 15, json_optional: null }]));
    const held = (await psql(
      "SELECT string_agg(id || ':' || COALESCE(json_typeof(json_optional), 'NULL'), ',' ORDER BY id) FROM public.type_http_smoke WHERE id IN (1, 13, 15)",
    )).trim();
    if (held !== "1:NULL,13:NULL,15:NULL") fail(`a JSON null is held as ${held}, not as SQL NULL`);
    response = await request(`${base}?select=json_optional&id=eq.13`);
    if (JSON.stringify(await response.json()) !== '[{"json_optional":null}]') fail("a JSON null does not read back as null");
    // A required json field refuses a null as a required field of any type does.
    response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...row, id: 16, json_value: null }) });
    if (response.status !== 400 || !(await response.text()).includes("23502")) fail(`a JSON null into a NOT NULL json column returned ${response.status}`);
    response = await request(`${base}?id=eq.1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json_value: null }) });
    if (response.status !== 400 || !(await response.text()).includes("23502")) fail(`a JSON null patched into a NOT NULL json column returned ${response.status}`);
    await dockerFails(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-v", "ON_ERROR_STOP=1", "-c", seed([{ ...row, id: 17, json_value: null }])]);

    // A checked type's column refuses what its domain refused, by name.
    const raw = (id: number, from: string, to: string) => JSON.stringify({ ...row, id }).replace(from, to);
    const jsonValue = JSON.stringify(row.json_value);
    const geojsonValue = JSON.stringify(row.geojson_value);
    for (const [type, body] of [
      ["double", raw(19, '"double_value":1.5', '"double_value":"NaN"')],
      ["double", raw(20, '"double_value":1.5', '"double_value":"Infinity"')],
      ["date", raw(21, '"date_value":"2026-09-21"', '"date_value":"10000-01-01"')],
      ["timezone", raw(22, '"timezone_value":"America/Sao_Paulo"', '"timezone_value":"Mars/Olympus"')],
      ["timezone", raw(23, '"timezone_value":"America/Sao_Paulo"', '"timezone_value":"EST5EDT"')],
      ["json", raw(24, `"json_value":${jsonValue}`, '"json_value":9007199254740993')],
      ["json", raw(25, `"json_value":${jsonValue}`, '"json_value":{"x":1,"x":2}')],
      ["geojson", raw(28, `"geojson_value":${geojsonValue}`, '"geojson_value":{"type":"Feature","geometry":null}')],
      ["geojson", raw(29, `"geojson_value":${geojsonValue}`, '"geojson_value":{"type":"FeatureCollection"}')],
    ]) {
      response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const text = await response.text();
      if (response.status !== 400 || !text.includes(`type_http_smoke_${type}_value_type`)) fail(`${type} invalid input returned ${response.status}: ${text}`);
    }
    for (const [name, body] of [
      ["timestamp", raw(40, '"timestamp_value":"2026-09-21T11:00:00.123456Z"', '"timestamp_value":"2026-09-21T11:00:60.000000Z"')],
      ["base64", raw(41, '"bytes_value":"YWJj"', '"bytes_value":"YWJj="')],
      ["decimal scale", raw(42, '"decimal_value":"12.3"', '"decimal_value":"1.234"')],
      ["int64 as a number", raw(43, '"int64_value":"9223372036854775807"', '"int64_value":1')],
      // Refused before the CHECK sees them: PostgREST's own reading holds neither.
      ["json NUL", raw(44, `"json_value":${jsonValue}`, '"json_value":"\\u0000"')],
      ["json unpaired surrogate", raw(45, `"json_value":${jsonValue}`, '"json_value":"\\ud800"')],
    ]) {
      response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (response.status !== 400) fail(`${name} invalid type input returned ${response.status}: ${await response.text()}`);
      await response.body?.cancel();
    }
    await dockerFails(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-v", "ON_ERROR_STOP=1", "-c", "SELECT public.portable_timestamp_from_text('10000-01-01T00:00:00.000000Z')"]);

    await docker(["run", "--rm", "-d", "--name", electric, "--network", network, "-p", "127.0.0.1::3000",
      "-e", `DATABASE_URL=postgresql://postgres:type_pwd@${database}:5432/type_db?sslmode=disable`,
      "-e", "ELECTRIC_SECRET=type-electric", "-e", "ELECTRIC_MANUAL_TABLE_PUBLISHING=true", ELECTRIC]);
    electricStarted = true;
    const electricPort = (await docker(["port", electric, "3000/tcp"])).trim().match(/:(\d+)$/)?.[1] ?? fail("Electric did not publish a host port");
    await eventually(async () => {
      const ready = await request(`http://127.0.0.1:${electricPort}/v1/health`);
      const status = ready.status;
      await ready.body?.cancel();
      return status;
    }, (status) => status === 200);
    const shape = (params: Record<string, string>) => {
      const url = new URL(`http://127.0.0.1:${electricPort}/v1/shape`);
      url.search = new URLSearchParams({ table: "type_http_smoke", offset: "-1", secret: "type-electric", ...params }).toString();
      return request(url.href);
    };
    // Each value as the subset's params carry it: Postgres's own text, as
    // electric-db-collection's serializer writes it.
    const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
    const wrong: string[] = [];
    for (const type of types) {
      const entry = table.types[type];
      const compares = entry.subset;
      const c = `${type}_value`;
      response = await shape({ log: "changes_only", subset__where: `"${c}" = $1`, subset__params: JSON.stringify({ "1": text(row[c]) }) });
      const body = await response.text();
      if ((response.status === 200) !== compares) wrong.push(`${type}: a subset "${c}" = $1 answered ${response.status} (${body.slice(0, 160)}), and types.cue says subset: ${compares}`);
      // ORDER BY reaches Postgres as written, so a domain orders there too
      // (measured 2026-10-03); a json one is a 500. What a domain cannot do is
      // the cursor a limited view pages on, `"c" > $1`, which is the where
      // above — so `subset` answers for an order column what it answers for a filter.
      if (compares) {
        const got = (JSON.parse(body) as { data: { value: Record<string, unknown> }[] }).data.map((m) => Number(m.value.id)).sort((a, b) => a - b);
        const held = await (await request(`${base}?select=id&order=id&${c}=eq.${encodeURIComponent(text(row[c]))}`)).json();
        const want = held.map((r: { id: number }) => r.id);
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${type}: the subset matched ${got}, and PostgREST holds the value in ${want}`);
        response = await shape({ log: "changes_only", subset__where: "true = true", subset__order_by: `"${c}"`, subset__limit: "1" });
        if (response.status !== 200) wrong.push(`${type}: a limited subset ordered by it answered ${response.status}: ${(await response.text()).slice(0, 160)}`);
        else await response.body?.cancel();
      }
    }
    response = await shape({ log: "changes_only", subset__where: `"uuid_value" = ANY($1)`, subset__params: JSON.stringify({ "1": `{"${row.uuid_value}"}` }) });
    if (response.status !== 200) wrong.push(`= ANY($1): ${response.status} ${await response.text()}`);
    else if ((await response.json()).data.length !== (await (await request(`${base}?select=id&uuid_value=eq.${row.uuid_value}`)).json()).length) {
      wrong.push("= ANY($1) did not match the rows holding the value");
    }

    if (wrong.length > 0) fail(wrong.join("\n"));
  } finally {
    if (electricStarted) await docker(["rm", "-f", electric]);
    if (restStarted) await docker(["rm", "-f", rest]);
    if (databaseStarted) await docker(["rm", "-f", database]);
    if (networkStarted) await docker(["network", "rm", network]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
