// The default builders take their inputs as `_`, so a seat a builder reads is
// required by name. The build serves its terminal's statics, and without the
// terminal it once failed deep inside the bayt builder on a non-concrete path.
// Asked of cue over testdata/emit, because a value that fails to unify cannot
// sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

function built(seats: string, field = "terminalStatics"): { ok: boolean; out: string } {
  const expr = `(#installedBuild & {seats: {${seats}}}).out.${field}`;
  const out = new Deno.Command("cue", {
    args: ["export", "builder.cue", "installed-surface.cue", "optional.cue", "installed.cue", "distribution.cue", "read.cue", "-e", expr],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

Deno.test("a build without its terminal names the missing seat", () => {
  const got = built("");
  if (got.ok || !/required field missing: terminal/.test(got.out)) throw new Error(`exported or refused elsewhere: ${got.out}`);
});

Deno.test("a build with its terminal serves the terminal's statics", () => {
  const got = built("terminal: _installedTerm");
  if (!got.ok || !/"\/omnishell\//.test(got.out)) throw new Error(`refused or no omnishell statics: ${got.out}`);
});

Deno.test("a checkout runner carries Activepieces image and source views", () => {
  const got = built("terminal: _installedTerm", 'project.targets["ci"].compose.build.additional_contexts');
  if (!got.ok) throw new Error(got.out);
  const contexts = JSON.parse(got.out);
  for (const target of ["activepieces-image"]) {
    for (const view of ["bayt", "srcs"]) {
      const name = `libraries_mecha-${target}_${view}`;
      if (!contexts[name]?.includes(`:${name}`)) throw new Error(`runner lacks ${name}`);
    }
  }
});
