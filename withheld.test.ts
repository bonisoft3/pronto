// What the SQL and proto passes decline to read, and why. Inspection is
// default-on, so every case here is one where something is NOT read: the set a
// mistake would silently widen.

import { assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { findings as sqlFindings, withheld as sqlWithheld } from "./check-sql.ts";
import { findings as protoFindings, gitInput, withheld as protoWithheld } from "./check-proto.ts";

Deno.test("only a sql-kind hatch withholds SQL", () => {
  // A container hatch withholds a service, and a proto hatch a proto; neither
  // says anything about what squawk may read.
  const skip = sqlWithheld({
    vendored: { kind: "container", note: "a hand-written service" },
    legacy: { kind: "sql", files: ["services/database/sql/legacy.sql"], note: "predates the vocabulary" },
    api: { kind: "proto", files: ["hatch/vendor.proto"], note: "a vendored proto" },
  }, []);
  assertEquals([...skip.keys()], ["services/database/sql/legacy.sql"]);
});

Deno.test("a rawMigration's generated copy is skipped, not its source", () => {
  // write.ts copies src into migrations/<name>; reading both reports one file
  // twice, the second time at a path nobody can edit.
  const skip = sqlWithheld({}, [{ name: "011_owner.sql", src: "services/database/sql/011_owner.sql" }]);
  assertEquals(skip.has("services/database/migrations/011_owner.sql"), true);
  assertEquals(skip.has("services/database/sql/011_owner.sql"), false);
});

Deno.test("a rawMigration written in place is not skipped as its own copy", () => {
  // An app whose src already sits at the emitted path would otherwise withhold
  // the only copy there is, and read nothing.
  const path = "services/database/migrations/011_owner.sql";
  assertEquals(sqlWithheld({}, [{ name: "011_owner.sql", src: path }]).has(path), false);
});

Deno.test("the domain rule is forgiven only in the file pronto derives", () => {
  const reported = [
    { file: "/app/services/database/migrations/004_types.sql", line: 9, rule_name: "ban-create-domain-with-constraint", message: "m" },
    { file: "/app/services/database/sql/011_owner.sql", line: 2, rule_name: "ban-create-domain-with-constraint", message: "m" },
  ];
  const found = sqlFindings(reported, "/app");
  assertEquals(found.length, 1);
  assertEquals(found[0].path, "services/database/sql/011_owner.sql");
});

Deno.test("only a proto-kind hatch withholds a proto", () => {
  const skip = protoWithheld({
    legacy: { kind: "sql", files: ["services/database/sql/legacy.sql"], note: "sql" },
    api: { kind: "proto", files: ["hatch/vendor.proto"], note: "a vendored proto" },
  });
  assertEquals([...skip.keys()], ["hatch/vendor.proto"]);
});

Deno.test("the git input carries a subdir in a monorepo and none at a repo root", () => {
  // The same emitted buf.yaml has to compare correctly in this repo and in the
  // one copybara gives the app, where the app IS the root.
  assertEquals(gitInput("/r/.git", "apps/realworld/", "main"), "/r/.git#branch=main,subdir=apps/realworld");
  assertEquals(gitInput("/r/.git", "", "main"), "/r/.git#branch=main");
});

Deno.test("a tree with no repository is refused, a repository with no commits is an answer", async () => {
  // These two absences fail `rev-parse --verify HEAD` identically — both exit
  // 128 — so reading that alone reported "no history" about a tree that was
  // never a checkout, and the pass went green having compared nothing. Only the
  // second is genuinely nothing-to-compare-against.
  const run = (cwd: string) =>
    new Deno.Command("deno", {
      args: ["run", "-A", fileURLToPath(new URL("./check-proto.ts", import.meta.url)), cwd],
      stdout: "piped",
      stderr: "piped",
    }).output();

  const root = await Deno.makeTempDir({ prefix: "pronto-norepo-" });
  try {
    const bare = await run(root);
    assertEquals(bare.success, false);
    assertEquals(new TextDecoder().decode(bare.stderr).includes("is not in a git repository"), true);

    await new Deno.Command("git", { args: ["init", "-q"], cwd: root }).output();
    const fresh = await run(root);
    assertEquals(fresh.success, true);
    assertEquals(new TextDecoder().decode(fresh.stdout).trim(), "[]");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a buf line that carries no file:line is still reported", () => {
  // Losing it would turn a complaint buf made into a clean verdict.
  const found = protoFindings("something buf said without a position");
  assertEquals(found.length, 1);
  assertEquals(found[0].severity, "error");
});
