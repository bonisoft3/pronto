import { assertEquals, assertRejects } from "@std/assert";
import {
  compiledFrom,
  compileProgram,
  compiler,
  currentCompilerHashes,
  sha256,
} from "./compiler.ts";

const encode = (text: string) => new TextEncoder().encode(text);

// A test over a scratch directory, removed whatever the test does.
function scratchTest(name: string, fn: (directory: string) => Promise<void>) {
  Deno.test(name, async () => {
    const directory = await Deno.makeTempDir();
    try {
      await fn(directory);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
}

// A compiled directory as compileProgram leaves it: the compiler's three
// outputs and a manifest naming the compiler, the source and their hashes.
async function compiled(directory: string) {
  const source = `${directory}/program.sql`;
  await Deno.writeTextFile(source, "CREATE VIEW v AS SELECT 1;\n");
  const hashes: Record<string, string> = {
    ...(await currentCompilerHashes()),
    source: await sha256(await Deno.readFile(source)),
  };
  for (const name of ["plan", "schema", "diagnostics"]) {
    await Deno.writeTextFile(`${directory}/${name}.json`, `{"${name}":1}\n`);
    hashes[name] = await sha256(encode(`{"${name}":1}\n`));
  }
  const manifest = { format: 1, compiler, views: ["v"], hashes };
  await rewrite(directory, manifest);
  return { source, manifest };
}

const rewrite = (directory: string, manifest: unknown) =>
  Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(manifest));

// Regeneration ran the Feldera compiler, a JVM in a container, for every
// computation on every generate; golaberto paid 14s for five unchanged ones.
scratchTest(
  "the compiler's output for this source and compiler is reused",
  async (directory) => {
    const { source } = await compiled(directory);
    assertEquals(await compiledFrom(directory, source), true);
  },
);

scratchTest("an edited source compiles again", async (directory) => {
  const { source } = await compiled(directory);
  await Deno.writeTextFile(source, "CREATE VIEW v AS SELECT 2;\n");
  assertEquals(await compiledFrom(directory, source), false);
});

scratchTest("another compiler compiles again", async (directory) => {
  const { source, manifest } = await compiled(directory);
  await rewrite(directory, {
    ...manifest,
    compiler: { ...compiler, flags: [...compiler.flags, "--extra"] },
  });
  assertEquals(await compiledFrom(directory, source), false);
});

// diagnostics.json is read off the compiler's output by diagnostics.ts, which
// leans on translator.ts, so a change to any of the driver's own modules
// cannot reuse what an earlier one read.
for (const name of ["translator", "driver", "admission"]) {
  scratchTest(`another ${name} compiles again`, async (directory) => {
    const { source, manifest } = await compiled(directory);
    await rewrite(directory, {
      ...manifest,
      hashes: { ...manifest.hashes, [name]: "0".repeat(64) },
    });
    assertEquals(await compiledFrom(directory, source), false);
  });
}

scratchTest(
  "an output edited or removed since the compile compiles again",
  async (directory) => {
    const { source } = await compiled(directory);
    await Deno.writeTextFile(`${directory}/plan.json`, "{}\n");
    assertEquals(await compiledFrom(directory, source), false);
    await compiled(directory);
    await Deno.remove(`${directory}/schema.json`);
    assertEquals(await compiledFrom(directory, source), false);
  },
);

// A manifest of another format, cut short, or left mid-merge names nothing
// to trust; before the reuse, compileProgram never read it.
scratchTest(
  "a manifest of another format compiles again",
  async (directory) => {
    const { source, manifest } = await compiled(directory);
    await rewrite(directory, { ...manifest, format: 2 });
    assertEquals(await compiledFrom(directory, source), false);
    await rewrite(directory, {});
    assertEquals(await compiledFrom(directory, source), false);
    await rewrite(directory, { ...manifest, hashes: undefined });
    assertEquals(await compiledFrom(directory, source), false);
    // A generate killed mid-write, and a merge that conflicted in the file.
    const text = JSON.stringify(manifest);
    for (
      const broken of [
        text.slice(0, 40),
        `<<<<<<< HEAD
${text}`,
      ]
    ) {
      await Deno.writeTextFile(`${directory}/manifest.json`, broken);
      assertEquals(await compiledFrom(directory, source), false);
    }
  },
);

scratchTest("a directory never compiled compiles", async (directory) => {
  await Deno.writeTextFile(`${directory}/program.sql`, "SELECT 1;\n");
  assertEquals(
    await compiledFrom(directory, `${directory}/program.sql`),
    false,
  );
});

// The jar is judged before any reuse: a wrong one fails on every generate,
// not at the next edit that happens to recompile.
scratchTest(
  "a wrong compiler jar fails even when the output is reused",
  async (directory) => {
    const { source } = await compiled(directory);
    await Deno.writeTextFile(`${directory}/wrong.jar`, "not the compiler");
    await assertRejects(
      () =>
        compileProgram({
          sourcePath: source,
          outputDirectory: directory,
          views: ["v"],
          jarPath: `${directory}/wrong.jar`,
        }),
      Error,
      "compiler artifact hash",
    );
  },
);
