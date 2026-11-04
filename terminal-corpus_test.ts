import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { prepareTerminalCorpus } from "./terminal-corpus.ts";

Deno.test("a handler-free release corpus compiles without an empty handlers directory", async () => {
  const apps = fileURLToPath(new URL("../../apps/", import.meta.url));
  const fixture = await Deno.makeTempDir({ dir: apps, prefix: ".corpus-test-" });
  // mise refuses a config in a directory nobody has trusted, which a checkout's own apps have
  // been and this one, a moment old, has not. CI trusts every path, so only a laptop saw this.
  const trusted = Deno.env.get("MISE_TRUSTED_CONFIG_PATHS");
  Deno.env.set("MISE_TRUSTED_CONFIG_PATHS", trusted ? `${trusted}${delimiter}${fixture}` : fixture);
  async function copy(from: string, to: string): Promise<void> {
    await Deno.mkdir(to, { recursive: true });
    for await (const e of Deno.readDir(from)) {
      if (e.isDirectory) await copy(join(from, e.name), join(to, e.name));
      else await Deno.copyFile(join(from, e.name), join(to, e.name));
    }
  }
  try {
    const source = join(apps, "w3caria");
    for await (const e of Deno.readDir(source)) {
      if (e.isFile) await Deno.copyFile(join(source, e.name), join(fixture, e.name));
    }
    await copy(join(source, "shell"), join(fixture, "shell"));
    await assertRejects(() => Deno.stat(join(fixture, "shell/handlers")), Deno.errors.NotFound);
    await prepareTerminalCorpus(fixture);
    const config = JSON.parse(await Deno.readTextFile(join(fixture, "shell/shell.json")));
    assertEquals(typeof config, "object");
    assertEquals(await Deno.readTextFile(join(fixture, "shell/shell.yaml")), JSON.stringify(config));
    await assertRejects(() => Deno.stat(join(fixture, "storybook_bootstrap.cue")), Deno.errors.NotFound);
  } finally {
    if (trusted === undefined) Deno.env.delete("MISE_TRUSTED_CONFIG_PATHS");
    else Deno.env.set("MISE_TRUSTED_CONFIG_PATHS", trusted);
    await Deno.remove(fixture, { recursive: true });
  }
});
