import assert from "node:assert/strict";

const here = new URL(".", import.meta.url);
const entity = (write: boolean | string | undefined) => JSON.stringify({
  name: "Filter", table: "filter", durability: "offline",
  access: { scope: "public", write },
  fields: [{ name: "id", type: "string", pk: true }, { name: "range", type: "string" }],
});

async function sql(expr: string): Promise<string> {
  const out = await new Deno.Command("cue", {
    args: ["export", ".", "-e", expr, "--out", "text"], cwd: here,
    stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

export function policy(write: boolean | string, restriction = false): Promise<string> {
  return sql(restriction
    ? `(#publicUpdateSql & {e: ${entity(write)}}).out`
    : `(#policySql & {e: ${entity(write)}, entities: {}}).out`);
}


export async function schema(): Promise<string> {
  const floor = await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", here));
  return `CREATE ROLE app_user NOLOGIN; CREATE ROLE service NOLOGIN BYPASSRLS;
    ${floor}
    CREATE TABLE filter (id text PRIMARY KEY, range text NOT NULL,
      scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
    GRANT USAGE ON SCHEMA public TO app_user, service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON filter TO app_user, service;
    INSERT INTO filter (id, range) VALUES ('none', '28d'), ('source', '7d');
    ${await policy(true)}`;
}

export async function assertGuestWrites(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const read = async () => {
    const response = await request("filter?select=id,range&order=id.asc");
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const before = await read();
  const denied = [
    { method: "DELETE", path: "filter" },
    { method: "POST", path: "filter", body: { id: "flood", range: "day" } },
    { method: "POST", path: "filter", body: { id: "flood", range: "day" }, prefer: "resolution=merge-duplicates" },
    { method: "POST", path: "filter", body: { id: "none", range: "day" }, prefer: "resolution=merge-duplicates" },
    { method: "PATCH", path: "filter?id=eq.none", body: { id: "renamed" } },
    { method: "PATCH", path: "filter?id=eq.none", body: { id: "none", range: "day" } },
  ];
  for (const { method, path, body, prefer } of denied) {
    const response = await request(path, {
      method, headers: { "Content-Type": "application/json", Prefer: `return=representation${prefer ? "," + prefer : ""}` },
      body: body && JSON.stringify(body),
    });
    const detail = await response.text();
    assert.equal(response.status, 403, `${method} ${path}: ${detail}`);
    assert.match(detail, /permission denied/);
    assert.deepEqual(await read(), before, `${method} must preserve every preset`);
  }
  const response = await request("filter?id=eq.none", {
    method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ range: "day" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json())[0].range, "day");
  assert.deepEqual(await read(), [{ id: "none", range: "day" }, { id: "source", range: "7d" }]);
}

export async function releaseJobs(): Promise<Record<string, { initdb: { command: string[] }; migrate: { image: string } }>> {
  const out = await new Deno.Command("cue", {
    args: ["export", "optional.cue", "access.cue", "-e", "accessReleaseJobs"],
    cwd: new URL("./testdata/emit", import.meta.url), stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}
