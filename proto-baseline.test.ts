import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { gitInput, historyChecksEnabled, protoBaseline } from "./check-proto.ts";
import { fileURLToPath } from "node:url";

Deno.test("history comparisons are CI-only and local lint needs no Git or generated inputs", async () => {
  for (const value of [undefined, "", "0", "false", "FALSE"]) assertEquals(historyChecksEnabled(value), false);
  for (const value of ["1", "true"]) assertEquals(historyChecksEnabled(value), true);
  const root = await Deno.makeTempDir({ prefix: "pronto-local-lint-" });
  try {
    for (const args of [[root], ["--baseline", root]]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-config", "--allow-env=CI", `--allow-write=${root}`, fileURLToPath(new URL("./check-proto.ts", import.meta.url)), ...args],
        env: { CI: "" }, stdout: "piped", stderr: "piped",
      }).output();
      assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    }
    assertEquals(await Deno.readTextFile(`${root}/.pronto/proto-baseline.json`), "null\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lint's history input follows the comparison ref, including packed refs", async () => {
  const root = await Deno.makeTempDir({ prefix: "pronto-baseline-" });
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  };
  try {
    await assertRejects(
      () => protoBaseline(root),
      Error,
      "not in a git repository",
    );
    await git("init", "-q", "-b", "main");
    assertEquals(await protoBaseline(root), null);
    await Deno.writeTextFile(`${root}/schema.proto`, 'syntax = "proto3";\n');
    await git("add", ".");
    await git("commit", "-q", "-m", "schema");
    const first = await protoBaseline(root);
    await git("pack-refs", "--all", "--prune");
    assertEquals(await protoBaseline(root), first);
    await Deno.writeTextFile(
      `${root}/schema.proto`,
      'syntax = "proto3";\nmessage Added {}\n',
    );
    await git("commit", "-qam", "new baseline");
    assertEquals((await protoBaseline(root)) === first, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the schema comparison uses the sampled commit even if its branch moves", () => {
  assertEquals(gitInput("/repo/.git", "apps/demo/", "main", "abc123"), "/repo/.git#branch=main,ref=abc123,subdir=apps/demo");
});
