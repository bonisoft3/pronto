// The default builders take their inputs as `_`, so a seat a builder reads is
// required by name. The build serves its terminal's statics, and without the
// terminal it once failed deep inside the bayt builder on a non-concrete path.
// Asked of cue over testdata/emit, because a value that fails to unify cannot
// sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

async function built(expr: string): Promise<{ ok: boolean; out: string }> {
  const out = await new Deno.Command("cue", {
    args: ["export", "builder.cue", "installed-surface.cue", "optional.cue", "-e", expr],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

let cachedWithTerminal: Promise<{ ok: boolean; out: string }> | undefined;
const withTerminal = () =>
  cachedWithTerminal ??= built(
    '{terminalStatics: #installedWithTerminal.out.terminalStatics, additionalContexts: #installedWithTerminal.out.project.targets["ci"].compose.build.additional_contexts}',
  );

Deno.test("a build without its terminal names the missing seat", async () => {
  const got = await built("(#installedBuild & {seats: {}}).out.terminalStatics");
  if (got.ok || !/required field missing: terminal/.test(got.out)) throw new Error(`exported or refused elsewhere: ${got.out}`);
});

Deno.test("a build with its terminal serves the terminal's statics", async () => {
  const got = await withTerminal();
  if (!got.ok || !/"\/omnishell\//.test(got.out)) throw new Error(`refused or no omnishell statics: ${got.out}`);
});

Deno.test("a checkout runner carries Activepieces image and source views", async () => {
  const got = await withTerminal();
  if (!got.ok) throw new Error(got.out);
  const { additionalContexts: contexts } = JSON.parse(got.out);
  for (const target of ["activepieces-image"]) {
    for (const view of ["bayt", "srcs"]) {
      const name = `libraries_mecha-${target}_${view}`;
      if (!contexts[name]?.includes(`:${name}`)) throw new Error(`runner lacks ${name}`);
    }
  }
});

Deno.test("visual integration carries authored screens outside the default directory", async () => {
  const got = await built('#installedAuthored.project.targets.integrate.srcs.globs');
  if (!got.ok) throw new Error(got.out);
  const paths: string[] = JSON.parse(got.out);
  for (const path of ["shell/shell.yaml", "screens/board.html", "styles/board.css"]) {
    if (!paths.includes(path)) throw new Error(`integration image omits ${path}`);
  }
});
