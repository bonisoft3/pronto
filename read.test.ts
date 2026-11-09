// #App.#read is the entity's mode, so an author cannot state another: asked
// of cue over testdata/emit's #readCase, because a value that fails to unify
// cannot sit in the package `cue vet` holds.

const dir = new URL("./testdata/emit", import.meta.url);

async function goal(goal: string, field = "Goal"): Promise<{ ok: boolean; out: string }> {
  const expr = `(#readCase & {reads: [_view], goal: ${goal}}).app.state.entities.${field}.read`;
  const out = await new Deno.Command("cue", { args: ["export", "read-case.cue", "-e", expr], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

function expect(name: string, got: { ok: boolean; out: string }, ok: boolean, match: RegExp): void {
  if (got.ok !== ok || !match.test(got.out)) throw new Error(`${name}: ${got.ok ? "exported" : "refused"} ${got.out}`);
}

Deno.test("an authored read mode the rule contradicts fails to unify", async () => {
  const [liveEager, offlineLazy] = await Promise.all([
    goal('{table: "goal", durability: "live", read: "eager"}'),
    goal('{table: "goal", durability: "offline", read: "lazy"}'),
  ]);
  expect("authored against the rule", liveEager, false, /conflicting values "lazy" and "eager"/);
  expect("offline lazy", offlineLazy, false, /conflicting values "eager" and "lazy"|conflicting values "lazy" and "eager"/);
});

Deno.test("a browser tier has no read mode to state", async () => {
  expect("a tab entity", await goal('{table: "goal", durability: "tab", read: "eager"}'), false, /explicit error \(_\|_ literal\)/);
});

Deno.test("an assembly screen requires its chart projection; authored markup alone has a bootstrap default", async () => {
  const screen = '{name: "board", title: "Board", route: "/", reads: [], writes: [], forms: [], states: [], files: {handlers: [], adapters: []}}';
  const results = await Promise.all(
    ([["", false], [", charts: []", true], [', markup: "<main></main>"', true]] as const).map(async ([extra, success]) => {
      const expr = `(#Screen & ${screen.slice(0, -1)}${extra}}).charts`;
      const output = await new Deno.Command("cue", { args: ["export", ".", "-e", expr], stdout: "piped", stderr: "piped" }).output();
      return [success, output] as const;
    }),
  );
  for (const [success, output] of results) {
    const message = new TextDecoder().decode(output.stderr);
    if (output.success !== success || (!success && !message.includes("charts"))) throw new Error(message || "a missing projection was admitted");
  }
});
