// The docker appliance runs a program's migrations, effects, bridges and change
// feed inside its one container (docs/release-targets.md#docker). The fixture is
// yogurt, a real docker-released app, copied beside it under its own name with
// testdata/appliance: a row machine whose effect an embedded bridge answers, and
// a drain, whose function a forward migration creates, counting the answers off
// the change feed. Building it needs Docker and the monorepo.
import { assert, assertStringIncludes, assertEquals } from "jsr:@std/assert@1.0.11";
import { fromFileUrl, join } from "jsr:@std/path@1.0.8";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("testdata/appliance/", import.meta.url));

async function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const child = new Deno.Command(cmd, { args, cwd: opts.cwd, stdin: opts.stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const r = await child.output();
  return { ok: r.success, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr) };
}

async function must(cmd: string, args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const r = await run(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${args.join(" ")}\n${r.err}\n${r.out}`);
  return r.out;
}

async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, seconds: number): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < seconds; i++) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)} after ${seconds}s`);
}

async function copyTree(from: string, to: string) {
  await must("rsync", ["-a", "--exclude", ".task", "--exclude", "node_modules", "--exclude", "dist", "--exclude", ".bayt", `${from}/`, `${to}/`]);
}

Deno.test({ name: "the docker appliance migrates, runs effects through an embedded bridge and drains off its change feed, and recovers", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const name = `applianceit${crypto.randomUUID().slice(0, 6)}`;
  const app = join(ROOT, "apps", name);
  const image = `ghcr.io/bonisoft3/${name}:latest`;
  const container = `${name}-run`;
  const volume = `${name}-data`;
  const bus = `${name}-redis`;
  await copyTree(join(ROOT, "apps", "yogurt"), app);
  try {
    // The fixture beside yogurt's own program, under the copy's name.
    await copyTree(FIXTURE, app);
    for await (const e of Deno.readDir(app)) {
      if (!e.isFile || !e.name.endsWith(".cue")) continue;
      const f = join(app, e.name);
      await Deno.writeTextFile(f, (await Deno.readTextFile(f)).replace(/^package (yogurt|APP)$/m, `package ${name}`));
    }
    const program = join(app, "program.cue");
    let text = await Deno.readTextFile(program);
    text = text.replace('meta: name:        "yogurt"', `meta: name:        "${name}"`);
    text = text.replace(/(state: entityOrder: \[[^\]]*)\]/, '$1, "Ping"]');
    await Deno.writeTextFile(program, text);

    await must(join(ROOT, "plugins/sayt/sayt.sh"), ["generate"], { cwd: app });
    await must("mise", ["exec", "--", "docker", "compose", "build", "release-docker"], { cwd: app });
    await must("docker", ["run", "-d", "--name", container, "-v", `${volume}:/var/lib/pgsql/data`, "-v", `${bus}:/var/lib/redis`, image]);

    const psql = (sql: string) => must("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "postgres", "-d", name], { stdin: sql });
    const up = () => until("the appliance", async () => (await run("docker", ["exec", container, "sh", "-c", "portcheck --port 9997 && portcheck --port 3000 && httpcheck http://127.0.0.1:3002/v1/health"])).ok, (v) => v, 180);
    const ping = async (id: string) => {
      await psql(`INSERT INTO ping (id, status) VALUES ('${id}', 'pending'); UPDATE ping SET status = 'sending' WHERE id = '${id}';`);
      return until(`ping ${id}`, () => psql(`SELECT status || '|' || coalesce(answer, '') FROM ping WHERE id = '${id}'`), (v) => v.startsWith("answered"), 90);
    };
    const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    await up();

    await t.step("PostgreSQL keeps acknowledged writes durable", async () => {
      assertEquals(await psql("SELECT current_setting('fsync') || '|' || current_setting('synchronous_commit') || '|' || current_setting('full_page_writes')"), "on|on|on");
      assertEquals(await psql("SELECT current_setting('max_slot_wal_keep_size')"), "1GB");
    });

    await t.step("Caddy uses the configured certificate directory", async () => {
      await until("Caddy certificate storage", async () => {
        const result = await run("docker", ["exec", container, "sh", "-c", 'tr "\\0" "\\n" < /proc/$(pidof caddy)/environ | sed -n "/^XDG_DATA_HOME=/p"']);
        return result.out;
      }, (value) => value === "XDG_DATA_HOME=/var/lib/caddy", 30);
    });

    let shapeHandle = "";
    await t.step("Electric serves the live rows", async () => {
      await psql(`INSERT INTO ping (id, status) VALUES ('${id(6)}', 'pending')`);
      const url = "http://127.0.0.1:3002/v1/shape?table=ping&secret=dev-electric-secret";
      const snapshot = await must("docker", ["exec", container, "curl", "-fsSi", `${url}&offset=-1`]);
      assertStringIncludes(snapshot, id(6));
      const handle = snapshot.match(/^electric-handle:\s*(.+)\r?$/im)?.[1].trim();
      const offset = snapshot.match(/^electric-offset:\s*(.+)\r?$/im)?.[1].trim();
      if (!handle || !offset) throw new Error("Electric snapshot omitted its handle or offset");
      shapeHandle = handle;
      await psql(`INSERT INTO ping (id, status) VALUES ('${id(7)}', 'pending')`);
      const updates = () => must("docker", ["exec", container, "curl", "-fsS", `${url}&handle=${encodeURIComponent(handle)}&offset=${encodeURIComponent(offset)}`]);
      await until("Electric update", updates, (v) => v.includes(id(7)), 60);
    });
    await t.step("a replacement container keeps Electric's shapes on the volume", async () => {
      await must("docker", ["rm", "-f", container]);
      await must("docker", ["run", "-d", "--name", container, "-v", `${volume}:/var/lib/pgsql/data`, "-v", `${bus}:/var/lib/redis`, image]);
      await up();
      const shape = await must("docker", ["exec", container, "curl", "-fsSi", "http://127.0.0.1:3002/v1/shape?table=ping&offset=-1&secret=dev-electric-secret"]);
      assertStringIncludes(shape, id(6));
      assertStringIncludes(shape, `electric-handle: ${shapeHandle}`);
    });
    await t.step("a row moves through the effect to its onDone state, answered by the embedded bridge", async () => {
      assertEquals(await ping(id(1)), "answered|from-the-stub");
    });
    await t.step("the program's forward migrations are applied before what reads them", async () => {
      assertEquals(await psql("SELECT count(*) FROM pgroll.migrations WHERE name = '040_ping_count' AND done"), "1");
    });
    await t.step("the database runs Jessie as plv8, on pljs", async () => {
      assertEquals(await psql(`SELECT public.fn_echo('{"value": 7}'::jsonb)::text`), '{"echoed": 7}');
    });
    await t.step("the drain runs off the change feed when its table changes", async () => {
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "1", 30), "1");
    });
    await t.step("a killed airlock is restarted and answers what arrived meanwhile", async () => {
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[a]irlock-deno run .*main.ts")']);
      assertEquals(await ping(id(2)), "answered|from-the-stub");
    });
    await t.step("a change made while Conduit is down reaches the drain once it restarts, the slot holding it", async () => {
      assertEquals(await until("settled ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "2", 90), "2");
      await must("docker", ["exec", container, "sh", "-c", 'kill -STOP $(pgrep -f "[c]onduit run")']);
      await psql(`DELETE FROM ping WHERE id = '${id(2)}';`);
      assertEquals(await psql("SELECT answered FROM ping_count"), "2");
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[c]onduit run")']);
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "1", 90), "1");
      assertEquals(await ping(id(5)), "answered|from-the-stub");
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "2", 90), "2");
    });
    await t.step("a killed bridge is restarted", async () => {
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[p]ing-stub.ts")']);
      assertEquals(await ping(id(3)), "answered|from-the-stub");
    });
    const redis = (args: string) => must("docker", ["exec", container, "sh", "-c", `redis-cli -p $(pgrep -a redis-server | grep -o ':[0-9]*' | head -1 | tr -d :) ${args}`]);
    await t.step("Redis runs with maxmemory and noeviction", async () => {
      const maxmemory = (await redis("CONFIG GET maxmemory")).split("\n")[1];
      const policy = (await redis("CONFIG GET maxmemory-policy")).split("\n")[1];
      assert(Number(maxmemory) > 0, `expected maxmemory > 0, got ${maxmemory}`);
      assertEquals(policy, "noeviction");
    });
    const group = `${name}-ping-count`;
    // A field of one consumer group, as redis-cli prints XINFO GROUPS: names and values a line each.
    const groupField = async (stream: string, of: string, field: string) => {
      const lines = (await redis(`XINFO GROUPS ${stream}`)).split("\n");
      const at = lines.findIndex((line, i) => line === "name" && lines[i + 1] === of);
      if (at < 0) return "";
      const end = lines.findIndex((line, i) => i > at + 1 && line === "name");
      const block = lines.slice(at, end < 0 ? undefined : end);
      return block[block.indexOf(field) + 1] ?? "";
    };
    const retried = () => groupField(`${group}-retry`, "mecha", "pending");
    await t.step("a drain's refused change leaves the stream for durable retry, and lands once fixed", async () => {
      await until("settled ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "3", 90);
      await psql(`UPDATE ping SET answer = 'poison' WHERE id = '${id(1)}'`);
      await until("the refused change's hand-off", async () => Number(await redis(`XLEN ${group}-retry`)), (n) => n > 0, 90);
      // The stream moved on: the refused change is no longer the drain's to hold.
      assertEquals(await until("the drain's pending list", () => groupField("cdc-events", group, "pending"), (v) => v === "0", 30), "0");
      await until("Dapr redelivering it", retried, (v) => Number(v) > 0, 60);
      await psql(`UPDATE ping SET answer = 'from-the-stub' WHERE id = '${id(1)}'`);
      assertEquals(await until("the redelivery's success", retried, (v) => v === "0", 120), "0");
    });
    await t.step("a start redrives what durable retry dead-lettered", async () => {
      await redis(`EVAL "local e = redis.call('XRANGE', 'cdc-events', '-', '+', 'COUNT', 1)[1] redis.call('XADD', KEYS[1], '*', unpack(e[2])) return 1" 1 ${group}-dead`);
      await must("docker", ["restart", container]);
      await up();
      assertEquals(await until("the dead letters' return", async () => Number(await redis(`XLEN ${group}-dead`)), (n) => n === 0, 90), 0);
      assertEquals(await until("their redelivery", retried, (v) => v === "0", 120), "0");
      assertStringIncludes((await run("docker", ["logs", container])).out + (await run("docker", ["logs", container])).err, "durable retry at start");
    });
    await t.step("a replacement container keeps the bus's stream on the volume", async () => {
      const added = async () => Number((await redis("XINFO STREAM cdc-events")).match(/entries-added\n(\d+)/)![1]);
      await until("settled ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "3", 90);
      await must("docker", ["exec", container, "sh", "-c", 'kill -STOP $(pgrep -f "[r]edpanda-connect")']);
      assertEquals(await ping(id(8)), "answered|from-the-stub");
      await until("the drain's unread change", () => redis("XINFO GROUPS cdc-events"), (v) => /lag\n[1-9]/.test(v), 30);
      const before = await added();
      await must("docker", ["rm", "-f", container]);
      await must("docker", ["run", "-d", "--name", container, "-v", `${volume}:/var/lib/pgsql/data`, "-v", `${bus}:/var/lib/redis`, image]);
      await up();
      // An in-memory Redis starts the stream over; its log on the volume keeps every entry it had added.
      assert((await added()) >= before, `the stream restarted at ${await added()}, below ${before}`);
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "4", 90), "4");
    });
    await t.step("a replacement container keeps the ledger and answers new rows", async () => {
      await must("docker", ["rm", "-f", container]);
      await must("docker", ["run", "-d", "--name", container, "-v", `${volume}:/var/lib/pgsql/data`, "-v", `${bus}:/var/lib/redis`, image]);
      await up();
      const shape = await must("docker", ["exec", container, "curl", "-fsSi", "http://127.0.0.1:3002/v1/shape?table=ping&offset=-1&secret=dev-electric-secret"]);
      assertStringIncludes(shape, id(6));
      assertStringIncludes(shape, `electric-handle: ${shapeHandle}`);
      assertEquals(await ping(id(4)), "answered|from-the-stub");
      assertEquals(await psql("SELECT count(*) FROM airlock.external_effect_ledger WHERE outcome->>'kind' = 'done'"), "6");
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "5", 60), "5");
      assertEquals(await psql("SELECT count(*) FROM pgroll.migrations WHERE name = '040_ping_count' AND done"), "1");
    });
    await t.step("a lost slot is recreated on Conduit's start and readers rebuild", async () => {
      const slot = `${name}_conduit_slot`;
      await must("docker", ["rm", "-f", container]);
      await must("docker", ["run", "-d", "--name", container, "-e", "PG_MAX_SLOT_WAL_KEEP_SIZE=1MB", "-v", `${volume}:/var/lib/pgsql/data`, "-v", `${bus}:/var/lib/redis`, image]);
      await up();
      assertEquals(await psql("SELECT current_setting('max_slot_wal_keep_size')"), "1MB");
      await until("conduit running", async () => (await run("docker", ["exec", container, "pgrep", "-f", "[c]onduit run"])).ok, (v) => v, 30);
      await must("docker", ["exec", container, "sh", "-c", 'kill -STOP $(pgrep -f "[c]onduit run")']);
      await psql(`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${slot}' AND active_pid IS NOT NULL;`);
      await psql("UPDATE ping_count SET answered = 999 WHERE id = 1;");
      await until("lost slot", async () => {
        await psql("SELECT pg_logical_emit_message(true, 'test', repeat('x', 4096)); SELECT pg_switch_wal(); CHECKPOINT;");
        return await psql(`SELECT wal_status FROM pg_replication_slots WHERE slot_name = '${slot}'`);
      }, (status) => status === "lost", 60);
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[c]onduit run")']);
      await until("recreated slot", () => psql(`SELECT wal_status FROM pg_replication_slots WHERE slot_name = '${slot}'`), (status) => status !== "" && status !== "lost", 60);
      assertEquals(await until("rebuilt ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "5", 90), "5");
      assertEquals(await ping(id(9)), "answered|from-the-stub");
      assertEquals(await until("post-rebuild ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "6", 90), "6");
    });
  } finally {
    await run("docker", ["rm", "-f", container]);
    await run("docker", ["volume", "rm", volume, bus]);
    await Deno.remove(app, { recursive: true });
  }
} });
