import { fileURLToPath } from "node:url";
import { join } from "node:path";

// write.ts states the layout of an app inside its own CUE module, unless the
// app declares itself installed: an app generated as its own repository keeps
// that declaration even when the pronto writing it is the monorepo's.

const pronto = fileURLToPath(new URL(".", import.meta.url));

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function layoutAfterWrite(declared: string): Promise<string> {
  const app = await Deno.makeTempDir({ dir: join(pronto, "../../apps"), prefix: ".layout-" });
  try {
    await Deno.writeTextFile(join(app, "program.cue"), "package layout\n");
    await Deno.writeTextFile(join(app, "program_pronto.cue"), declared);
    // Only the layout is under test; the export after it fails on this empty app.
    await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-check", "--allow-read", "--allow-write", "--allow-run", "--allow-env", join(pronto, "write.ts"), app],
      stdout: "null", stderr: "null",
    }).output();
    return await Deno.readTextFile(join(app, "program_pronto.cue"));
  } finally {
    await Deno.remove(app, { recursive: true });
  }
}

Deno.test("write.ts keeps a layout declared installed", async () => {
  const installed = 'package layout\nloop: surface: sources: pronto: ""\n';
  assert(await layoutAfterWrite(installed) === installed, "installed declaration was rewritten as local");
});

Deno.test("write.ts states the layout of an app built in its module", async () => {
  const layout = await layoutAfterWrite('package layout\nloop: surface: sources: pronto: "../plugins/pronto"\n');
  assert(layout.includes('loop: surface: sources: pronto: "../../plugins/pronto"'), `local layout not restated:\n${layout}`);
});
