import { generateTypeSQL } from "./type-sql.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const POSTGREST = "postgrest/postgrest:v12.2.3@sha256:0a46780309a604cdc8b56c776c6e5e15788ce58174d709e40459ab5a2d44d228";
const ELECTRIC = "electricsql/electric@sha256:f311edc272e227ddaea593c5205a02c3d1e5969c2db0f7655a039a5e24abb176";

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

Deno.test({ name: "PostgREST carries portable codecs over native UUID storage", sanitizeOps: false, sanitizeResources: false, fn: async () => {
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
  const schema = `${generateTypeSQL([{ precision: 18, scale: 2 }])}
CREATE ROLE anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon;
CREATE TABLE public.type_http_smoke (
  id public.portable_int32 PRIMARY KEY,
  string_value public.portable_string NOT NULL,
  bool_value public.portable_bool NOT NULL,
  int64_value public.portable_int64 NOT NULL,
  double_value public.portable_double NOT NULL,
  bytes_value public.portable_bytes NOT NULL,
  uuid_value uuid NOT NULL,
  timestamp_value public.portable_timestamp NOT NULL,
  date_value public.portable_date NOT NULL,
  time_value public.portable_time NOT NULL,
  timezone_value public.portable_timezone NOT NULL,
  duration_value public.portable_duration NOT NULL,
  decimal_value public.portable_decimal_18_2 NOT NULL,
  json_value public.portable_json NOT NULL,
  geojson_value public.portable_geojson NOT NULL
);
GRANT SELECT, INSERT ON public.type_http_smoke TO anon;
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
    await eventually(() => docker(["exec", database, "pg_isready", "-U", "postgres", "-d", "type_db"]), (out) => out.includes("accepting connections"));
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

    const row = {
      id: 1, string_value: "type_val", bool_value: true, int64_value: "9223372036854775807", double_value: 1.5,
      bytes_value: "YWJj", uuid_value: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e",
      timestamp_value: "2026-09-21T11:00:00.123456Z", date_value: "2026-09-21", time_value: "11:00:00.123456",
      timezone_value: "America/Sao_Paulo", duration_value: "PT0.1S", decimal_value: "12.3", json_value: null,
      geojson_value: { type: "Feature", geometry: { type: "Point", coordinates: [-46.6, -23.5] }, properties: {} },
    };
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

    const raw = (id: number, from: string, to: string) => JSON.stringify({ ...row, id }).replace(from, to);
    response = await request(base, {
      method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: raw(12, '"uuid_value":"8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e"', '"uuid_value":"8C1F3A56-7E0B-4E3D-9C62-6A6FCB7B4A5E"'),
    });
    if (!response.ok) fail(`normalizable uuid input: ${response.status} ${await response.text()}`);
    const [normalized] = await response.json();
    if (normalized.uuid_value !== row.uuid_value) fail(`uuid canonical output: ${JSON.stringify(normalized.uuid_value)}`);

    for (const [name, body] of [
      ["uuid", raw(19, '"uuid_value":"8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e"', '"uuid_value":"not-a-uuid"')],
      ["timestamp", raw(20, '"timestamp_value":"2026-09-21T11:00:00.123456Z"', '"timestamp_value":"2026-09-21T11:00:60.000000Z"')],
      ["json binary64", raw(21, '"json_value":null', '"json_value":9007199254740993')],
      ["json duplicate key", raw(22, '"json_value":null', '"json_value":{"x":1,"x":2}')],
      ["json NUL", raw(23, '"json_value":null', '"json_value":"\\u0000"')],
      ["json unpaired surrogate", raw(24, '"json_value":null', '"json_value":"\\ud800"')],
      ["geojson feature", raw(25, '"geojson_value":{"type":"Feature","geometry":{"type":"Point","coordinates":[-46.6,-23.5]},"properties":{}}', '"geojson_value":{"type":"Feature","geometry":null}')],
      ["feature collection", raw(26, '"geojson_value":{"type":"Feature","geometry":{"type":"Point","coordinates":[-46.6,-23.5]},"properties":{}}', '"geojson_value":{"type":"FeatureCollection"}')],
      ["base64", raw(27, '"bytes_value":"YWJj"', '"bytes_value":"YWJj="')],
      ["decimal scale", raw(28, '"decimal_value":"12.3"', '"decimal_value":"1.234"')],
    ]) {
      response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (response.status !== 400) fail(`${name} invalid type input returned ${response.status}: ${await response.text()}`);
      await response.body?.cancel();
    }
    await dockerFails(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-v", "ON_ERROR_STOP=1", "-c", "SELECT public.portable_timestamp_from_text('10000-01-01T00:00:00.000000Z')"]);
    await dockerFails(["exec", database, "psql", "-U", "postgres", "-d", "type_db", "-v", "ON_ERROR_STOP=1", "-c", "SELECT public.portable_uuid_from_text('8C1F3A56-7E0B-4E3D-9C62-6A6FCB7B4A5E')"]);

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
    const shape = new URL(`http://127.0.0.1:${electricPort}/v1/shape`);
    shape.search = new URLSearchParams({
      table: "type_http_smoke", offset: "-1", secret: "type-electric",
      where: `uuid_value = '${row.uuid_value}'`,
    }).toString();
    response = await request(shape.href);
    if (response.status !== 200) fail(`native UUID Electric equality: ${response.status} ${await response.text()}`);
    await response.body?.cancel();
  } finally {
    if (electricStarted) await docker(["rm", "-f", electric]);
    if (restStarted) await docker(["rm", "-f", rest]);
    if (databaseStarted) await docker(["rm", "-f", database]);
    if (networkStarted) await docker(["network", "rm", network]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
