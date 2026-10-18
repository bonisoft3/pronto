import { fileURLToPath } from "node:url";
import { join } from "node:path";

// write.ts writes an app's mise.local.toml only where its pronto is the
// monorepo's: the file sends mise to the runtime's trees and turns on the
// switch that builds the runtime's images from them, and a mirror, which
// receives every other file unchanged, must never have it.

const pronto = fileURLToPath(new URL(".", import.meta.url));

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function miseLocalAfterWrite(parent: string, module: boolean): Promise<{ file: string | null; stderr: string }> {
  const app = await Deno.makeTempDir({ dir: parent, prefix: ".layout-" });
  try {
    if (module) await Deno.mkdir(join(app, "cue.mod"));
    await Deno.writeTextFile(join(app, "program.cue"), "package layout\n");
    // Only the layout is under test; the export after it fails on this empty app.
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-check", "--allow-read", "--allow-write", "--allow-run", "--allow-env", join(pronto, "write.ts"), app],
      stdout: "null", stderr: "piped",
    }).output();
    const file = await Deno.readTextFile(join(app, "mise.local.toml")).catch((e) => {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    });
    return { file, stderr: new TextDecoder().decode(run.stderr) };
  } finally {
    await Deno.remove(app, { recursive: true });
  }
}

Deno.test("write.ts points an app in the monorepo at the runtime's trees", async () => {
  const local = (await miseLocalAfterWrite(join(pronto, "../../apps"), false)).file;
  assert(local !== null, "no mise.local.toml for an app inside the monorepo's module");
  for (const line of [
    '"github:bonisoft3/pronto" = "path:../../plugins/pronto"',
    '"github:bonisoft3/mecha" = "path:../../libraries/mecha"',
    'MONOREPO_COMPOSE_MODE = "service"',
    'BAYT_RUNTIME = "../../../plugins/bayt/runtime"',
  ]) assert(local.includes(line), `mise.local.toml lacks ${line}:\n${local}`);
});

Deno.test("write.ts leaves an app built in its own module without one", async () => {
  const outside = await Deno.makeTempDir({ prefix: "layout-outside-" });
  try {
    const { file, stderr } = await miseLocalAfterWrite(outside, true);
    assert(file === null, "mise.local.toml written outside the monorepo");
    // Past the layout, to the derivation this empty program cannot pass: a
    // writer that died before deciding would leave no file either.
    assert(stderr.includes("derive.ts") && !stderr.includes("checkout"), `write.ts stopped before the layout:\n${stderr}`);
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("an installed pronto refuses an app whose checkout keeps the runtime", async () => {
  // The checkout's own pronto writes mise.local.toml; without it mise ran the
  // pinned pronto, which would emit the mirror's form into the monorepo.
  const checkout = await Deno.makeTempDir({ prefix: "layout-runtime-" });
  try {
    await Deno.mkdir(join(checkout, "cue.mod"));
    await Deno.mkdir(join(checkout, "plugins/pronto"), { recursive: true });
    await Deno.writeTextFile(join(checkout, "plugins/pronto/write.ts"), "");
    await Deno.mkdir(join(checkout, "apps"));
    const { file, stderr } = await miseLocalAfterWrite(join(checkout, "apps"), false);
    assert(file === null, "mise.local.toml written by a pronto outside the checkout");
    assert(stderr.includes("has no mise.local.toml"), `write.ts ran on:\n${stderr}`);
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});
