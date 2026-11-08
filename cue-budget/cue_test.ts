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
  assertMatch(first.stderr, /slot: cue \.: weight 0 of [0-9.]+ \(cue lock\)/);
  const [peak] = (await learned(dir))[0].split(" ");
  assert.ok(Number(peak) > 0.05 && Number(peak) < 1, `learned ${peak} GB for a cue holding ~64 MB`);
  const second = await run(dir, ["export", "./spec"]);
  assertEquals(second.code, 0);
  assertEquals(second.stderr.includes("slot:"), false, "learned under CUE_DIRECT_GB: no claim");
  assertMatch((await learned(dir))[0], /^0\.[0-9]+ cue export \.\/spec/, "measured again by time");
});

Deno.test("an evaluation learned large takes the cue lock (memory is a lock, not a budget)", async () => {
  const dir = await Deno.makeTempDir();
  await fake(dir);
  await run(dir, ["vet", "-c", "./spec"], { CUE_UNKNOWN_GB: "1" });
  const file = (await Array.fromAsync(Deno.readDir(`${dir}/.cache/pronto/cue-mem`)))[0].name;
  await Deno.writeTextFile(`${dir}/.cache/pronto/cue-mem/${file}`, "2 cue vet -c ./spec\n");
  const r = await run(dir, ["vet", "-c", "./spec"]);
  assertMatch(r.stderr, /slot: cue \.: weight 0 of [0-9.]+ \(cue lock\)/);
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

Deno.test("a vet re-vets only the packages whose inputs changed since one passed", async () => {
  // The module is the case's folder: run() puts its bin (the fake cue) on PATH and its HOME there.
  const dir = (await Deno.makeTempDir()) + "/m";
  await Deno.mkdir(dir);
  await fake(dir);
  await Deno.mkdir(`${dir}/cue.mod`, { recursive: true });
  await Deno.writeTextFile(`${dir}/cue.mod/module.cue`, `module: "t.example/m@v0"\nlanguage: version: "v0.16.0"\n`);
  for (const p of ["a", "b", "c"]) await Deno.mkdir(`${dir}/${p}`);
  await Deno.writeTextFile(`${dir}/a/a.cue`, `package a\nx: 1\n`);
  await Deno.writeTextFile(`${dir}/b/b.cue`, `package b\nimport "t.example/m/a"\ny: a.x\n`);
  await Deno.writeTextFile(`${dir}/c/c.cue`, `package c\nz: _ @embed(file="z.json")\n`);
  await Deno.writeTextFile(`${dir}/c/z.json`, `1`);
  await Deno.writeTextFile(`${dir}/c/notes.cue`, `// no package clause: not a package of its own\n`);
  const vet = (env: Record<string, string> = {}) =>
    run(dir, ["vet", "-c", "./..."], { CUE_DIRECT_GB: "0", CUE_UNKNOWN_GB: "0.1", ...env });
  const first = await vet();
  assertEquals(first.code, 0);
  assertMatch(first.stdout, /real cue vet -c \.\/a \.\/b \.\/c/);
  const again = await vet();
  assertEquals(again.code, 0);
  assertEquals(again.stdout, "", "every package passed before: cue is not run");
  assertMatch(again.stderr, /passed before with these same inputs/);
  // An edit to a reaches b, which imports it; c is untouched.
  await Deno.writeTextFile(`${dir}/a/a.cue`, `package a\nx: 2\n`);
  const edited = await vet();
  assertMatch(edited.stdout, /real cue vet -c \.\/a \.\/b\n/);
  // An embedded file is an input too.
  await Deno.writeTextFile(`${dir}/c/z.json`, `2`);
  assertMatch((await vet()).stdout, /real cue vet -c \.\/c\n/);
  // A vet that fails records nothing; CUE_VETTED=off vets every time.
  await Deno.writeTextFile(`${dir}/bin/cue`, `#!/bin/sh\necho "real cue $*"\nexit 1\n`);
  await Deno.writeTextFile(`${dir}/b/b.cue`, `package b\nimport "t.example/m/a"\ny: a.x + 1\n`);
  assertEquals((await vet()).code, 1);
  assertEquals((await vet()).code, 1, "a failed vet was not recorded");
  await fake(dir);
  assertEquals((await vet()).code, 0);
  assertMatch((await vet({ CUE_VETTED: "off" })).stdout, /real cue vet -c \.\/\.\.\./);
});

Deno.test("an export is printed from a passing one with the same inputs, tags deciding which files count", async () => {
  const dir = (await Deno.makeTempDir()) + "/m";
  await Deno.mkdir(dir);
  await fake(dir);
  await Deno.mkdir(`${dir}/cue.mod`, { recursive: true });
  await Deno.writeTextFile(`${dir}/cue.mod/module.cue`, `module: "t.example/m@v0"\nlanguage: version: "v0.16.0"\n`);
  await Deno.mkdir(`${dir}/a`);
  await Deno.writeTextFile(`${dir}/a/a.cue`, `package a\nx: 1\n`);
  await Deno.writeTextFile(`${dir}/a/l1.cue`, `@if(l1)\npackage a\ny: 1\n`);
  await Deno.writeTextFile(`${dir}/a/l2.cue`, `@if(l2)\npackage a\ny: 2\n`);
  const env = { CUE_DIRECT_GB: "0", CUE_UNKNOWN_GB: "0.1" };
  const exp = (args: string[], more: Record<string, string> = {}) => run(dir, ["export", "./a", ...args], { ...env, ...more });
  const first = await exp(["-t", "l1", "--out", "json"]);
  assertEquals(first.code, 0);
  assertMatch(first.stdout, /^real cue export \.\/a -t l1 --out json\n/);
  const again = await exp(["-t", "l1", "--out", "json"]);
  assertEquals(again.stdout, first.stdout, "the kept output is printed as cue printed it");
  assertMatch(again.stderr, /printed from a passing export/);
  // A file the tags leave out is not an input; one they keep is.
  await Deno.writeTextFile(`${dir}/a/l2.cue`, `@if(l2)\npackage a\ny: 3\n`);
  assertMatch((await exp(["-t", "l1", "--out", "json"])).stderr, /printed from a passing export/);
  await Deno.writeTextFile(`${dir}/a/l1.cue`, `@if(l1)\npackage a\ny: 4\n`);
  assertEquals((await exp(["-t", "l1", "--out", "json"])).stderr.includes("printed from a passing export"), false);
  // A package importing a's with its major version and package (\`mod@v0:pkg\`, as pronto's reads do) is keyed by a's files.
  await Deno.mkdir(`${dir}/a/obs`);
  await Deno.writeTextFile(`${dir}/a/obs/o.cue`, `package obs\nimport a "t.example/m/a@v0:a"\nr: a.x\n`);
  const obs = () => run(dir, ["export", "./a/obs", "-e", "r"], env);
  await obs();
  assertMatch((await obs()).stderr, /printed from a passing export/);
  await Deno.writeTextFile(`${dir}/a/a.cue`, `package a\nx: 5\n`);
  assertEquals((await obs()).stderr.includes("printed from a passing export"), false, "an edit to the imported package is a miss");
  // A failing export keeps nothing; -o and CUE_EXPORTED=off run as asked.
  await Deno.writeTextFile(`${dir}/bin/cue`, `#!/bin/sh\necho "real cue $*"\nexit 1\n`);
  assertEquals((await exp(["-e", "x"])).code, 1);
  assertEquals((await exp(["-e", "x"])).code, 1, "a failed export was not kept");
  await fake(dir);
  assertMatch((await exp(["-e", "x"])).stdout, /^real\ cue\ export\ \.\/a\ \-e\ x\n/);
  assertMatch((await exp(["-e", "x"], { CUE_EXPORTED: "off" })).stdout, /^real\ cue\ export\ \.\/a\ \-e\ x\n/);
  assertMatch((await exp(["-o", "out.json"])).stdout, /^real\ cue\ export\ \.\/a\ \-o\ out\.json\n/);
  assertMatch((await exp(["-o", "out.json"])).stdout, /^real\ cue\ export\ \.\/a\ \-o\ out\.json\n/, "-o is never printed from the cache");
  assertMatch((await exp(["-oout.json"])).stdout, /^real cue export \.\/a -oout\.json\n/);
  assertMatch((await exp(["-oout.json"])).stdout, /^real cue export \.\/a -oout\.json\n/, "nor a glued -o");
});
