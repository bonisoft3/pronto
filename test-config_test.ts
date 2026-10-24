import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { fileURLToPath, pathToFileURL } from "node:url";

const WRITER = fileURLToPath(new URL("./test-config.ts", import.meta.url));
const url = (dir: string) => pathToFileURL(dir).href + "/";

/** An app whose mise finds omnishell and pronto at the paths given, relative
 * to the app, as mise.local.toml finds a checkout's trees. */
async function app(root: string, dir: string, omnishell: string, pronto: string): Promise<string> {
  const at = `${root}/${dir}`;
  await Deno.mkdir(`${at}/tests`, { recursive: true });
  await Deno.writeTextFile(
    `${at}/mise.toml`,
    `[tools]\n"github:bonisoft3/omnishell" = "path:${omnishell}"\n"github:bonisoft3/pronto" = "path:${pronto}"\n`,
  );
  await Deno.writeTextFile(`${at}/tests/deno.app.json`, JSON.stringify({ imports: { linkedom: "npm:linkedom@0.18.4" }, compilerOptions: { strict: true } }));
  return at;
}

async function tree(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(`${dir}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${dir}/${rel}`, text);
  }
  return Deno.realPath(dir);
}

async function write(at: string, root: string): Promise<{ success: boolean; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--allow-read", "--allow-write", "--allow-run=mise", WRITER, at],
    env: { MISE_TRUSTED_CONFIG_PATHS: root },
    stdout: "inherit",
    stderr: "piped",
  }).output();
  return { success: out.success, stderr: new TextDecoder().decode(out.stderr) };
}

const config = async (at: string) => JSON.parse((await Deno.readTextFile(`${at}/tests/deno.json`)).replace(/^\/\/.*\n/, ""));

// pronto's harness reaches omnishell as its checkout sibling.
const RUNTIMES = {
  omnishell: { "base-url.ts": `export const baseUrl = "omnishell";\n` },
  pronto: { "hybrid-local.ts": `export { baseUrl } from "../omnishell/base-url.ts";\n` },
};

// A mirror's tests mapped /omnishell/ to ../../../plugins/omnishell/, a path
// the monorepo has and the mirror does not, and its integrate died on
// `Module not found "file:///plugins/omnishell/base-url.ts"`.
Deno.test("a checkout's tests import the runtime's trees, an installed app's the releases mise keeps", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const omnishell = await tree(`${root}/plugins/omnishell`, RUNTIMES.omnishell);
    const pronto = await tree(`${root}/plugins/pronto`, RUNTIMES.pronto);
    const checkout = await app(root, "apps/game", "../../plugins/omnishell", "../../plugins/pronto");
    assertEquals((await write(checkout, root)).success, true);
    assertEquals(await config(checkout), {
      imports: { linkedom: "npm:linkedom@0.18.4", "/omnishell/": url(omnishell), "/pronto/": url(pronto) },
      compilerOptions: { strict: true },
    });

    const installedOmnishell = await tree(`${root}/installs/github-bonisoft3-omnishell/0.18.0`, RUNTIMES.omnishell);
    const installedPronto = await tree(`${root}/installs/github-bonisoft3-pronto/0.21.0`, RUNTIMES.pronto);
    const installed = await app(root, "game", installedOmnishell, installedPronto);
    assertEquals((await write(installed, root)).success, true);
    assertEquals((await config(installed)).imports, {
      linkedom: "npm:linkedom@0.18.4",
      "/omnishell/": url(installedOmnishell),
      "/pronto/": url(installedPronto),
      [url(`${root}/installs/github-bonisoft3-omnishell/pronto`)]: url(installedPronto),
      [url(`${root}/installs/github-bonisoft3-pronto/omnishell`)]: url(installedOmnishell),
    });

    for (const at of [checkout, installed]) {
      await Deno.writeTextFile(`${at}/tests/probe.ts`, `import { baseUrl } from "/pronto/hybrid-local.ts";\nconsole.log(baseUrl);\n`);
      const run = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-lock", "--config", "tests/deno.json", "--allow-read", "tests/probe.ts"],
        cwd: at,
        stdout: "piped",
      }).output();
      assertEquals(new TextDecoder().decode(run.stdout).trim(), "omnishell", at);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an app's own config cannot map a platform specifier", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    await tree(`${root}/plugins/omnishell`, RUNTIMES.omnishell);
    await tree(`${root}/plugins/pronto`, RUNTIMES.pronto);
    const at = await app(root, "apps/game", "../../plugins/omnishell", "../../plugins/pronto");
    await Deno.writeTextFile(`${at}/tests/online.app.json`, JSON.stringify({ imports: { "/omnishell/": "../../../plugins/omnishell/" } }));
    const result = await write(at, root);
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "tests/online.app.json maps /omnishell/");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
