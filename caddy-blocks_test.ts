// docker/Caddyfile written once, whole (caddy-blocks.ts), and one generate at a
// time in a checkout (generate-lock.sh): the two halves of the door's routes
// never seen missing (2026-11-07: a gate's guard-generated found ~130 lines of
// plugin routes gone, written by a stack's `launch --watch` generate beside it).
import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { blocks, keepBlocks, writeWhole } from "./caddy-blocks.ts";

const emitted = `:8080 {
  import app
}
(app) {
  # writer:begin — the writer's own
  respond /own 200
  # writer:end
  handle /api/* {
    reverse_proxy api:8080
  }
  # No strip_prefix: the auth service mounts its routes.
  handle /auth/* {
    reverse_proxy auth:8080
  }
}
`;
const block = (name: string) => [`  # pronto-${name}:begin — ${name}`, `  handle /${name}/* {`, `    reverse_proxy ${name}:80`, `  }`, `  # pronto-${name}:end`];
// What a full generate leaves: the emission with each plugin's block before the auth comment.
const settled = emitted.replace("  # No strip_prefix", [...block("journeys"), ...block("flags"), "  # No strip_prefix"].join("\n"));

Deno.test("the writer keeps the plugins' blocks the Caddyfile holds, where a route step puts them", () => {
  assertEquals(keepBlocks(null, emitted), emitted);
  assertEquals(keepBlocks(emitted, emitted), emitted);
  assertEquals(keepBlocks(settled, emitted), settled, "a settled file is written as it is");
  assertEquals(blocks(keepBlocks(settled, emitted)).map((b) => b.name), ["writer", "pronto-journeys", "pronto-flags"]);
  // The writer's own block is the emission's, never the old file's.
  const old = settled.replace("respond /own 200", "respond /own 404");
  assertEquals(keepBlocks(old, emitted), settled);
  // An emission with no `handle /auth/*` has no place for them: it is written as emitted.
  const bare = emitted.replace(/  # No strip_prefix[^]*?\n  }\n/, "");
  assertEquals(keepBlocks(settled, bare), bare);
});

Deno.test("an unclosed block fails the write", () => {
  let threw = false;
  try {
    keepBlocks("  # pronto-x:begin\n  handle /x\n", emitted);
  } catch (e) {
    threw = String(e).includes("has no `# pronto-x:end`");
  }
  assert(threw);
});

Deno.test("a reader polling the Caddyfile during generates never sees a block missing", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/Caddyfile`;
  await Deno.writeTextFile(path, settled);
  let done = false;
  let reads = 0;
  const missing: string[] = [];
  const reader = (async () => {
    while (!done) {
      const text = await Deno.readTextFile(path);
      reads++;
      const names = blocks(text).map((b) => b.name);
      if (!names.includes("pronto-journeys") || !names.includes("pronto-flags")) missing.push(text);
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
  // Each round is a generate's writes: the writer's emission, then a route step moving its block.
  for (let i = 0; i < 300; i++) {
    await writeWhole(path, keepBlocks(await Deno.readTextFile(path), emitted.replace("respond /own 200", `respond /own ${200 + (i % 2)}`)));
    const moved = keepBlocks(await Deno.readTextFile(path), emitted);
    await writeWhole(path, moved);
  }
  done = true;
  await reader;
  assert(reads > 50, `the reader read ${reads} times`);
  assertEquals(missing.length, 0, `a read saw a block missing:\n${missing[0]}`);
  await Deno.remove(dir, { recursive: true });
});

const lock = new URL("./generate-lock.sh", import.meta.url).pathname;

Deno.test("two generates started at once in one checkout run one after the other", async () => {
  const dir = await Deno.makeTempDir();
  // A generate as sayt runs one: its rules under a `task-leaf generate`, the lock's rule first.
  const generate = (name: string) =>
    new Deno.Command("sh", {
      args: ["-c", `: task-leaf generate; sh '${lock}' .task/bayt/generate.lock || exit 1; echo "${name} start"; sleep 1; echo "${name} end"`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
  const started = Date.now();
  const [a, b] = await Promise.all([generate("a"), generate("b")]);
  assert(a.success && b.success, new TextDecoder().decode(a.stderr) + new TextDecoder().decode(b.stderr));
  assert(Date.now() - started >= 2000, "the second waited for the first to end");
  const waited = new TextDecoder().decode(a.stderr) + new TextDecoder().decode(b.stderr);
  assert(waited.includes("another generate is running in this checkout"), waited);
  // The lock outlives neither: a third starts at once.
  const t = Date.now();
  assert((await generate("c")).success);
  assert(Date.now() - t < 2000, "the lock was released when the generates ended");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a generate inside one that holds the lock does not wait for it", async () => {
  const dir = await Deno.makeTempDir();
  const inner = `sh -c ': task-leaf generate; sh "${lock}" .task/bayt/generate.lock && echo inner'`;
  const out = await new Deno.Command("sh", {
    args: ["-c", `: task-leaf generate; sh '${lock}' .task/bayt/generate.lock || exit 1; ${inner}`],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(10_000),
  }).output();
  assertEquals(new TextDecoder().decode(out.stdout), "inner\n", new TextDecoder().decode(out.stderr));
  await Deno.remove(dir, { recursive: true });
});
