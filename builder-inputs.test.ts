// The default builders take their inputs as `_`, so a missing seat is not
// refused by a definition at the door; the builder that reads it has to say
// so. An installed app's build serves its terminal's statics, and without the
// terminal it once failed deep inside the bayt builder on a non-concrete path.
// Asked of cue over testdata/emit, because a value that fails to unify cannot
// sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

function statics(seats: string): { ok: boolean; out: string } {
  const expr = `(#installedBuild & {seats: {${seats}}}).out.terminalStatics`;
  const out = new Deno.Command("cue", { args: ["export", ".", "-e", expr], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

Deno.test("an installed build without its terminal names the missing seat", () => {
  const got = statics("");
  if (got.ok || !/pass terminal to #DefaultBuild/.test(got.out)) throw new Error(`exported or refused elsewhere: ${got.out}`);
});

Deno.test("an installed build with its terminal serves the terminal's statics", () => {
  const got = statics("terminal: _installedTerm");
  if (!got.ok || !/"\/omnishell\//.test(got.out)) throw new Error(`refused or no omnishell statics: ${got.out}`);
});
