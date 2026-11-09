// The docker appliance runs a program's migrations, effects, bridges and change
// feed inside its one container (docs/release-targets.md#docker). The fixture is
// yogurt, a real docker-released app, copied beside it under its own name with
// testdata/appliance: a row machine whose effect an embedded bridge answers, and
// a drain, whose function a forward migration creates, counting the answers off
// the change feed. Building it needs Docker and the monorepo.
import { assertEquals } from "jsr:@std/assert@1.0.11";
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
    await must("docker", ["run", "-d", "--name", container, image]);

    const psql = (sql: string) => must("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "postgres", "-d", name], { stdin: sql });
    const up = () => until("the appliance", async () => (await run("docker", ["exec", container, "sh", "-c", "portcheck --port 9997 && portcheck --port 3000"])).ok, (v) => v, 180);
    const ping = async (id: string) => {
      await psql(`INSERT INTO ping (id, status) VALUES ('${id}', 'pending'); UPDATE ping SET status = 'sending' WHERE id = '${id}';`);
      return until(`ping ${id}`, () => psql(`SELECT status || '|' || coalesce(answer, '') FROM ping WHERE id = '${id}'`), (v) => v.startsWith("answered"), 90);
    };
    const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    await up();

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
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[c]onduit run")']);
      assertEquals(await ping(id(5)), "answered|from-the-stub");
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "3", 90), "3");
    });
    await t.step("a killed bridge is restarted", async () => {
      await must("docker", ["exec", container, "sh", "-c", 'kill -9 $(pgrep -f "[p]ing-stub.ts")']);
      assertEquals(await ping(id(3)), "answered|from-the-stub");
    });
    await t.step("a restarted container keeps the ledger and answers new rows", async () => {
      await must("docker", ["restart", container]);
      await up();
      assertEquals(await ping(id(4)), "answered|from-the-stub");
      assertEquals(await psql("SELECT count(*) FROM airlock.external_effect_ledger WHERE outcome->>'kind' = 'done'"), "5");
      assertEquals(await until("ping_count", () => psql("SELECT answered FROM ping_count"), (v) => v === "5", 60), "5");
      assertEquals(await psql("SELECT count(*) FROM pgroll.migrations WHERE name = '040_ping_count' AND done"), "1");
    });
  } finally {
    await run("docker", ["rm", "-f", container]);
    await Deno.remove(app, { recursive: true });
  }
} });
