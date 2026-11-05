// The cue wrapper at the runtime's root (../cue), against a fake cue: what passes through at once,
// what claims memory from the pool, and what it learns. Each case has its own PATH, HOME and pool.
import { strict as assert } from "node:assert";

const assertEquals = (a: unknown, b: unknown, why?: string) => assert.deepStrictEqual(a, b, why);
const assertMatch = (s: string, re: RegExp, why?: string) => assert.match(s, re, why);

const wrapper = new URL("../cue", import.meta.url).pathname;
const runtime = wrapper.replace(/\/cue$/, "");
const deno = Deno.execPath().replace(/\/deno$/, "");

// A fake cue that says what it was asked, echoes its stdin for `export -`, holds `mb` MB (as RSS: it
// becomes a deno that fills a buffer, one process as cue is) or sleeps `sleep` s, noting a TERM.
const fake = async (dir: string, mb = 0, sleep = 0) => {
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/bin/cue`, `#!/bin/sh
echo "real cue $*"
[ "$CUE_BUDGET_WRAPPED" ] && echo wrapped
[ "$2" = - ] && cat
[ ${mb} -gt 0 ] && exec "${deno}/deno" eval 'const a = new Uint8Array(${mb} * 2 ** 20); a.fill(1); await new Promise((r) => setTimeout(r, 1500)); console.log(a[7])'
[ ${sleep} -gt 0 ] && { trap 'echo got TERM >> "${dir}/signals"; exit 143' TERM; sleep ${sleep} & wait; }
exit 0
`);
  await Deno.chmod(`${dir}/bin/cue`, 0o755);
};

const run = async (dir: string, args: string[], env: Record<string, string> = {}, stdin?: string) => {
  const child = new Deno.Command(wrapper, {
    args,
    cwd: dir,
    env: { PATH: `${runtime}:${dir}/bin:${deno}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, STACK_POOL: `${dir}/pool`, ...env },
    clearEnv: true,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
};

const learned = async (dir: string) => {
  const files = [];
  for await (const e of Deno.readDir(`${dir}/.cache/pronto/cue-mem`)) files.push(await Deno.readTextFile(`${dir}/.cache/pronto/cue-mem/${e.name}`));
  return files;
};

Deno.test("a command that evaluates nothing runs at once, and never claims", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  const r = await run(dir, ["fmt", "x.cue"]);
  assertEquals(r.code, 0);
  assertMatch(r.stdout, /^real cue fmt x\.cue/);
  assertEquals(r.stderr, "", "no slot line: it never reached the pool");
});

Deno.test("an evaluation never seen claims CUE_UNKNOWN_GB, then learns its peak and runs outside the pool", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir, 64);
  const first = await run(dir, ["export", "./spec"], { CUE_UNKNOWN_GB: "3" });
  assertEquals(first.code, 0);
  assertMatch(first.stderr, /slot: cue \.: weight 0 of [0-9.]+, 3 GB of/);
  const [peak] = (await learned(dir))[0].split(" ");
  assert.ok(Number(peak) > 0.05 && Number(peak) < 1, `learned ${peak} GB for a cue holding ~64 MB`);
  const second = await run(dir, ["export", "./spec"]);
  assertEquals(second.code, 0);
  assertEquals(second.stderr.includes("slot:"), false, "learned under CUE_DIRECT_GB: no claim");
  assertMatch((await learned(dir))[0], /^0\.[0-9]+ cue export \.\/spec/, "measured again by time");
});

Deno.test("an evaluation learned large claims its peak and a quarter", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  await run(dir, ["vet", "-c", "./spec"], { CUE_UNKNOWN_GB: "1" });
  const file = (await Array.fromAsync(Deno.readDir(`${dir}/.cache/pronto/cue-mem`)))[0].name;
  await Deno.writeTextFile(`${dir}/.cache/pronto/cue-mem/${file}`, "2 cue vet -c ./spec\n");
  const r = await run(dir, ["vet", "-c", "./spec"]);
  assertMatch(r.stderr, /, 2\.5 GB of /);
});

Deno.test("stdin reaches cue on both paths", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  const claimed = await run(dir, ["export", "-"], { CUE_UNKNOWN_GB: "1" }, "a: 1\n");
  assertMatch(claimed.stdout, /a: 1/);
  const direct = await run(dir, ["export", "-"], {}, "b: 2\n");
  assertEquals(direct.stderr.includes("slot:"), false);
  assertMatch(direct.stdout, /b: 2/, "a background command loses its stdin unless kept");
});

Deno.test("a cue run by a cue is its parent's, and a CUE_BUDGET=off one claims nothing", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  const inner = await run(dir, ["export", "./spec"], { CUE_BUDGET_WRAPPED: "1" });
  assertEquals(inner.stderr, "");
  const off = await run(dir, ["export", "./spec"], { CUE_BUDGET: "off" });
  assertEquals(off.stderr, "");
});

Deno.test("a signal to the wrapper reaches cue on the direct path", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  await run(dir, ["eval", "./spec"], { CUE_UNKNOWN_GB: "1" });
  // Learned small now; the next run is direct, and is stopped mid-run.
  await fake(dir, 0, 30);
  const child = new Deno.Command(wrapper, {
    args: ["eval", "./spec"],
    cwd: dir,
    env: { PATH: `${runtime}:${dir}/bin:${deno}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, STACK_POOL: `${dir}/pool` },
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  await new Promise((r) => setTimeout(r, 1500));
  child.kill("SIGTERM");
  await child.status;
  await new Promise((r) => setTimeout(r, 500));
  assertMatch(await Deno.readTextFile(`${dir}/signals`), /got TERM/, "cue would run on, orphaned, unbudgeted");
});

Deno.test("two wrappers on one PATH (a machine's and a runtime's) claim once and reach cue", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  await Deno.mkdir(`${dir}/machine/cue-budget`, { recursive: true });
  await Deno.copyFile(wrapper, `${dir}/machine/cue`);
  await Deno.chmod(`${dir}/machine/cue`, 0o755);
  await Deno.copyFile(`${runtime}/cue-budget/slot.ts`, `${dir}/machine/cue-budget/slot.ts`);
  // Its own argument, so a loop left behind is found and stopped.
  const spec = `./spec-${crypto.randomUUID()}`;
  const child = new Deno.Command(`${dir}/machine/cue`, {
    args: ["export", spec],
    cwd: dir,
    env: { PATH: `${dir}/machine:${runtime}:${dir}/bin:${deno}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, STACK_POOL: `${dir}/pool`, CUE_UNKNOWN_GB: "1" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = child.output();
  // Two that skip only themselves exec each other for ever.
  const done = await Promise.race([out.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))]);
  if (!done) {
    await new Deno.Command("pkill", { args: ["-9", "-f", spec] }).output();
    await out.catch(() => {});
    assert.fail("the wrappers handed cue to each other until killed");
  }
  const { code, stdout, stderr } = await out;
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  assertEquals(code, 0);
  assertMatch(text(stdout), new RegExp(`^real cue export ${spec.replace(/[.]/g, "\\.")}`));
  assertEquals(text(stderr).match(/slot: cue/g)?.length, 1, "one claim, not one per wrapper");
});
