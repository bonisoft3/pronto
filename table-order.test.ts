// #tableOrder's refusals, asked of cue over testdata/emit/table-order.cue's
// cases, because a program that must fail cannot sit in the package
// `cue vet` holds. The refusals are `out` itself: a guard on a sibling field
// was dropped where 005 selects `out` from the helper inline, and a cycle
// came out as a CREATE order.

const dir = new URL("./testdata/emit", import.meta.url);

function ask(expr: string, tags: string[] = []): { ok: boolean; out: string } {
  const out = new Deno.Command("cue", { args: ["export", "table-order.cue", "optional.cue", ...tags.flatMap((t) => ["-t", t]), "-e", expr], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr).trim() };
}

function refused(name: string, got: { ok: boolean; out: string }, ...match: RegExp[]): void {
  if (got.ok || !match.every((m) => m.test(got.out))) throw new Error(`${name}: ${got.ok ? "exported" : "refused"} ${got.out}`);
}

Deno.test("a cycle across tables fails the emitted 005, naming its tables", () => {
  refused("egg and hen", ask("_cyclicTables", ["back=egg"]), /form a cycle/, /\begg\b/, /\bhen\b/);
});

Deno.test("128 tables are ordered and closed: a chain reversed, a ring refused", () => {
  const chain = ask("(#linked & {n: 128, ring: false}).out");
  if (!chain.ok) throw new Error(`a chain of 128: ${chain.out}`);
  const tables = JSON.parse(chain.out) as string[];
  const reversed = Array.from({ length: 128 }, (_, i) => `t${127 - i}`);
  if (JSON.stringify(tables) !== JSON.stringify(reversed)) throw new Error(`a chain of 128 came out ${tables.join(",")}`);
  refused("a ring of 128", ask("(#linked & {n: 128, ring: true}).out"), /form a cycle/, /\bt0\b/, /\bt127\b/);
});

Deno.test("past 128 tables the order refuses rather than leave a chain unclosed", () => {
  refused("129 tables", ask("(#linked & {n: 129, ring: false}).out"), /at most 128 tables/);
});
