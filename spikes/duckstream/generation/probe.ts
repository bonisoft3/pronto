Deno.chdir(new URL(".", import.meta.url));
const decoder = new TextDecoder();
const scope = "accounts/v1/source-1";
type Row = { id: number; value: number };
type Payload = { accounts: Row[]; totals: Row[] };
type Envelope = { generation: number; payload: Payload; digest: string };
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
async function command(cmd: string, args: string[], input?: string) {
  const child = new Deno.Command(cmd, {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  assert(result.success, `${cmd}: ${decoder.decode(result.stderr)}`);
  return decoder.decode(result.stdout).trim();
}
const compose = (args: string[]) =>
  command("docker", ["compose", "-f", "compose.yaml", ...args]);
const pg = (sql: string) =>
  command("docker", [
    "compose",
    "-f",
    "compose.yaml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "spike",
  ], sql);
const json = async (path: string, value: unknown) =>
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
async function refuses(action: () => Promise<unknown>, message: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof Error && failure.message.includes(message),
    `expected ${message}, received ${failure}`,
  );
}
async function sourceHash() {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile("sink.sql"),
  );
  return Array.from(
    new Uint8Array(bytes),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
async function doctor() {
  assert(Deno.version.deno === "2.8.2", "Deno 2.8.2 required");
  return {
    deno: Deno.version.deno,
    docker: await command("docker", ["info", "--format", "{{.ServerVersion}}"]),
    postgres_image:
      (await Deno.readTextFile("compose.yaml")).match(/image: (.+)/)![1],
  };
}
async function build() {
  const tools = await doctor();
  await command("deno", ["check", "probe.ts"]);
  await Deno.mkdir("results", { recursive: true });
  await json("results/build.json", { tools, sink_sha256: await sourceHash() });
}
function payload(values: number[]): Payload {
  return {
    accounts: values.map((value, index) => ({ id: index + 1, value })),
    totals: values.length
      ? [{ id: 1, value: values.reduce((a, b) => a + b, 0) }]
      : [],
  };
}
async function envelope(generation: number, data: Payload): Promise<Envelope> {
  const digest = await pg(
    `SELECT encode(sha256(convert_to(${
      sqlString(JSON.stringify(data))
    }::jsonb::text, 'UTF8')), 'hex');`,
  );
  return { generation, payload: data, digest };
}
function publish(e: Envelope, overridePayload: unknown = e.payload) {
  return `SELECT publish_generation(${sqlString(scope)}, ${e.generation}, ${
    sqlString(JSON.stringify(overridePayload))
  }::jsonb, ${sqlString(e.digest)});`;
}
function ingress(e: Envelope) {
  return `INSERT INTO generation_ingress VALUES (${
    sqlString(scope)
  }, ${e.generation}, ${sqlString(JSON.stringify(e.payload))}::jsonb, ${
    sqlString(e.digest)
  }) ON CONFLICT (scope) DO UPDATE SET generation = EXCLUDED.generation, payload = EXCLUDED.payload, digest = EXCLUDED.digest;`;
}
const deliver = (e: Envelope) =>
  pg(`SET ROLE generation_writer; ${publish(e)}`);
const snapshotSql =
  `SELECT json_build_object('generation', (SELECT generation FROM generation_head), 'accounts', (SELECT COALESCE(json_agg(a ORDER BY id), '[]') FROM accounts a), 'totals', (SELECT COALESCE(json_agg(t ORDER BY id), '[]') FROM totals t));`;
const snapshot = async () => JSON.parse(await pg(snapshotSql));
const counts = async () =>
  JSON.parse(
    await pg(
      `SELECT json_build_array((SELECT count(*) FROM generation_receipts), (SELECT count(*) FROM local_hooks));`,
    ),
  );
const expected = (e: Envelope) => ({ generation: e.generation, ...e.payload });
async function test() {
  const build = JSON.parse(await Deno.readTextFile("results/build.json"));
  equal(build.sink_sha256, await sourceHash(), "build evidence current");
  const tools = await doctor();
  await compose(["up", "-d", "--wait"]);
  const checks: string[] = [];
  try {
    equal(
      await pg("SHOW server_version_num;"),
      "170006",
      "PostgreSQL pin",
    );
    await pg(await Deno.readTextFile("sink.sql"));
    await pg(
      `CREATE FUNCTION inject_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('spike.fail_between', true) = 'on' THEN RAISE EXCEPTION 'injected between table writes'; END IF;
      IF current_setting('spike.pause_between', true) = 'on' THEN PERFORM pg_sleep(0.6); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER generation_boundary BEFORE INSERT ON totals FOR EACH ROW EXECUTE FUNCTION inject_boundary();`,
    );
    const a = await envelope(1, payload([10, 20]));
    const b = await envelope(2, payload([15]));
    const c = await envelope(3, payload([25, 35, 45]));
    equal(await deliver(a), "activated", "first generation");
    equal(await snapshot(), expected(a), "initial complete result");

    await pg(
      "CREATE TABLE independent_accounts AS TABLE accounts; CREATE TABLE independent_totals AS TABLE totals;",
    );
    await pg(
      "DELETE FROM independent_accounts; INSERT INTO independent_accounts VALUES (1,15);",
    );
    const mixture = JSON.parse(
      await pg(
        `SELECT json_build_array((SELECT sum(value) FROM independent_accounts), (SELECT sum(value) FROM independent_totals));`,
      ),
    );
    equal(
      mixture,
      [15, 30],
      "independent table deliveries expose old/new mixture",
    );
    checks.push("Independent table commits expose accounts=15 while totals=30");

    await refuses(
      () =>
        pg(
          `SET ROLE generation_writer; SET spike.fail_between = 'on'; ${
            publish(b)
          }`,
        ),
      "injected between table writes",
    );
    equal(await snapshot(), expected(a), "rollback between table writes");
    equal(await counts(), [1, 1], "rollback removes receipt and hook");
    checks.push(
      "Failure between table replacements rolls back rows, receipt, completion and hook",
    );

    await refuses(async () => {
      await pg(`SET ROLE generation_writer; BEGIN; ${publish(b)} COMMIT;`);
      throw new Error("injected lost acknowledgement");
    }, "injected lost acknowledgement");
    equal(await deliver(b), "activated", "lost acknowledgement retry");
    equal(await snapshot(), expected(b), "absence deletes old second row");
    equal(await counts(), [2, 2], "lost acknowledgement produces one hook");
    equal(
      await deliver(a),
      "activated",
      "historical receipt remains original outcome",
    );
    equal(
      await snapshot(),
      expected(b),
      "old replay cannot regress active head",
    );
    const stale = await envelope(1, payload([999]));
    await refuses(() => deliver(stale), "generation identity reused");
    checks.push(
      "Successful COMMIT/lost application ack replays once; old replay and same-ID changed payload cannot regress",
    );

    const partial = { accounts: c.payload.accounts };
    await refuses(
      () => pg(`SET ROLE generation_writer; ${publish(c, partial)}`),
      "complete two-table envelope required",
    );
    await refuses(
      () =>
        pg(
          `SET ROLE generation_writer; ${
            publish(c, {
              ...c.payload,
              accounts: c.payload.accounts.slice(0, 1),
            })
          }`,
        ),
      "manifest digest mismatch",
    );
    const sameCount = structuredClone(c.payload);
    sameCount.accounts[0].value++;
    await refuses(
      () => pg(`SET ROLE generation_writer; ${publish(c, sameCount)}`),
      "manifest digest mismatch",
    );
    equal(
      await snapshot(),
      expected(b),
      "partial newer envelope cannot activate",
    );
    checks.push(
      "Missing table, missing row and equal-count changed content fail complete manifest verification",
    );

    await pg(`SET ROLE generation_writer; ${ingress(c)}`);
    await pg(`SET ROLE generation_writer; ${ingress(c)}`);
    equal(await counts(), [3, 3], "connector-shaped ingress upsert replay");
    const cConflict = await envelope(3, payload([55]));
    await refuses(
      () => pg(`SET ROLE generation_writer; ${ingress(cConflict)}`),
      "generation identity reused",
    );
    equal(
      await pg(
        `SELECT payload::jsonb = ${
          sqlString(JSON.stringify(c.payload))
        }::jsonb FROM generation_ingress WHERE generation=3;`,
      ),
      "t",
      "ingress payload immutable after conflict rollback",
    );
    await refuses(
      () =>
        pg(
          `SET ROLE generation_writer; UPDATE generation_receipts SET payload='{}';`,
        ),
      "permission denied",
    );
    await refuses(
      () =>
        pg(
          "SET ROLE generation_writer; UPDATE generation_head SET generation=999;",
        ),
      "permission denied",
    );
    checks.push(
      "Ordinary ingress INSERT/UPSERT activates atomically and rejects mutation; publisher cannot edit receipts/head",
    );

    const ten = await envelope(10, payload([100]));
    const eleven = await envelope(11, payload([110, 220]));
    const observations: unknown[] = [];
    const publications = [ten, eleven].map((e) =>
      pg(
        `SET ROLE generation_writer; SET application_name = 'generation-${e.generation}'; SET spike.pause_between='on'; ${
          publish(e)
        }`,
      )
    );
    await Promise.all([
      ...publications,
      (async () => {
        for (let i = 0; i < 15; i++) observations.push(await snapshot());
      })(),
    ]);
    const allowed = [c, ten, eleven].map((e) => JSON.stringify(expected(e)));
    assert(
      observations.every((s) => allowed.includes(JSON.stringify(s))),
      "one SQL snapshot always observes a whole generation",
    );
    const observedGenerations = observations.map((s) =>
      (s as { generation: number }).generation
    );
    assert(
      observedGenerations.every((n, i) =>
        i === 0 || n >= observedGenerations[i - 1]
      ),
      "observed generation never decreases",
    );
    equal(await snapshot(), expected(eleven), "concurrent final generation");
    const nine = await envelope(9, payload([90]));
    equal(await deliver(nine), "superseded", "unseen stale generation");
    equal(
      await snapshot(),
      expected(eleven),
      "unseen stale generation leaves current tables",
    );
    checks.push(
      "Competing PostgreSQL sessions serialize by whole scope; single SQL snapshots stay coherent and monotone",
    );

    const twelve = await envelope(12, {
      accounts: [],
      totals: [{ id: 1, value: 0 }],
    });
    await deliver(twelve);
    equal(await snapshot(), expected(twelve), "empty one table");
    const thirteen = await envelope(13, payload([]));
    await deliver(thirteen);
    await deliver(eleven);
    equal(
      await snapshot(),
      expected(thirteen),
      "empty generation cannot resurrect",
    );
    const hooks = JSON.parse(
      await pg(
        "SELECT json_agg(generation ORDER BY generation) FROM local_hooks;",
      ),
    ) as number[];
    assert(
      new Set(hooks).size === hooks.length && !hooks.includes(9),
      "one hook per activated generation only",
    );
    checks.push(
      "Empty table and empty whole generation replace/delete; late replay cannot resurrect",
    );

    const fourteen = await envelope(14, payload([14]));
    await refuses(
      () =>
        pg(
          `SET ROLE generation_writer; SET spike.fail_between='on'; ${
            ingress(fourteen)
          }`,
        ),
      "injected between table writes",
    );
    equal(
      await pg("SELECT count(*) FROM generation_ingress WHERE generation=14;"),
      "0",
      "ingress rolls back with finalization",
    );
    equal(
      await snapshot(),
      expected(thirteen),
      "failed ingress leaves complete empty generation",
    );
    checks.push(
      "Ingress transport row, final tables, completion, receipt and local hook share one transaction",
    );
    await json("results/tests.json", {
      tools,
      sink_sha256: await sourceHash(),
      checks,
      independent_table_counterexample: mixture,
      concurrent_snapshots: observations,
      activated_hooks: hooks,
      final: await snapshot(),
      fault_model:
        "SQL statement failure between table writes and throw after acknowledged COMMIT; no OS kill or network interruption",
      native_connector_tested: false,
    });
  } finally {
    await compose(["down", "-v", "--remove-orphans"]);
  }
  console.log(`PASS ${checks.length} generation assertion groups`);
}
export {
  assert,
  command,
  compose,
  counts,
  doctor,
  envelope,
  equal,
  expected,
  json,
  payload,
  pg,
  snapshot,
};

if (import.meta.main) {
  const mode = Deno.args[0];
  if (mode === "doctor") console.log(JSON.stringify(await doctor(), null, 2));
  else if (mode === "build") await build();
  else if (mode === "test") await test();
  else throw new Error(`unknown command: ${mode}`);
}
