// The default builders take their inputs as `_`, so a seat a builder reads is
// required by name. The build serves its terminal's statics, and without the
// terminal it once failed deep inside the bayt builder on a non-concrete path.
// Asked of cue over testdata/emit, because a value that fails to unify cannot
// sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

function statics(seats: string): { ok: boolean; out: string } {
  const expr = `(#installedBuild & {seats: {${seats}}}).out.terminalStatics`;
  const out = new Deno.Command("cue", {
    args: ["export", "builder.cue", "installed-surface.cue", "optional.cue", "installed.cue", "distribution.cue", "read.cue", "-e", expr],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

Deno.test("a build without its terminal names the missing seat", () => {
  const got = statics("");
  if (got.ok || !/required field missing: terminal/.test(got.out)) throw new Error(`exported or refused elsewhere: ${got.out}`);
});

Deno.test("a build with its terminal serves the terminal's statics", () => {
  const got = statics("terminal: _installedTerm");
  if (!got.ok || !/"\/omnishell\//.test(got.out)) throw new Error(`refused or no omnishell statics: ${got.out}`);
});
