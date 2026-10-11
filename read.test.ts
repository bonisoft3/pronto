// #App.#read is the entity's mode, so an author cannot state another: asked
// of cue over testdata/emit's #readCase, because a value that fails to unify
// cannot sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

function goal(goal: string, field = "Goal"): { ok: boolean; out: string } {
  const expr = `(#readCase & {reads: [_view], goal: ${goal}}).app.state.entities.${field}.read`;
  const out = new Deno.Command("cue", { args: ["export", ".", "-e", expr], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

function expect(name: string, got: { ok: boolean; out: string }, ok: boolean, match: RegExp): void {
  if (got.ok !== ok || !match.test(got.out)) throw new Error(`${name}: ${got.ok ? "exported" : "refused"} ${got.out}`);
}

Deno.test("an authored read mode the rule contradicts fails to unify", () => {
  expect("authored against the rule", goal('{table: "goal", durability: "live", read: "eager"}'), false, /conflicting values "lazy" and "eager"/);
  expect("offline lazy", goal('{table: "goal", durability: "offline", read: "lazy"}'), false, /conflicting values "eager" and "lazy"|conflicting values "lazy" and "eager"/);
});

Deno.test("a browser tier has no read mode to state", () => {
  expect("a tab entity", goal('{table: "goal", durability: "tab", read: "eager"}'), false, /explicit error \(_\|_ literal\)/);
});
