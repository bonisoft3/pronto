// What the replay concludes from a pair of catalog states, and where it sends
// the reader. The query is the thing under test: every case here is one a
// migration can produce and a text pass cannot see.

import { assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { targetService, forgivable, locate, pgrollMigrations, plain } from "./check-replay.ts";

type Row = { step: number; mig: string; rel: number; tbl: string; col: string; typ: string; ordinal: number };
type Finding = { severity: string; path: string | null; message: string };

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The query, over states a test supplies rather than a database. */
async function replay(rows: Row[], steps: { step: number; mig: string }[]): Promise<Finding[]> {
  const dir = await Deno.makeTempDir({ prefix: "replay-test-" });
  try {
    await Deno.writeTextFile(`${dir}/states.json`, JSON.stringify(rows));
    await Deno.writeTextFile(`${dir}/steps.json`, JSON.stringify(steps));
    const query = `CREATE TABLE snapshot AS SELECT * FROM read_json_auto('${dir}/states.json');\n` +
      `CREATE TABLE step AS SELECT * FROM read_json_auto('${dir}/steps.json');\n` +
      await Deno.readTextFile(here("./replay.sql"));
    const out = await new Deno.Command("mise", {
      args: ["x", "--", "duckdb", "-json", "-c", query],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout).trim();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    return stdout === "" ? [] : JSON.parse(stdout);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A column of `article`. `rel` defaults to one relation living across steps. */
const col = (step: number, mig: string, col: string, ordinal: number, typ = "text", rel = 100): Row => ({
  step,
  mig,
  rel,
  tbl: "article",
  col,
  typ,
  ordinal,
});

Deno.test("a name that moved under a living ordinal is a rename", async () => {
  const found = await replay(
    [col(1, "a.sql", "image_url", 5), col(2, "b.sql", "avatar_url", 5)],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].path, "b.sql");
  assertEquals(found[0].message.includes("was renamed to avatar_url"), true);
});

Deno.test("a name that left with its ordinal is a loss", async () => {
  const found = await replay(
    [col(1, "a.sql", "bio", 3), col(2, "b.sql", "id", 1)],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].message.includes("bio (column 3) is gone"), true);
});

Deno.test("a column whose type changed under the same ordinal is a retype", async () => {
  const found = await replay(
    [col(1, "a.sql", "subtitle", 4, "text"), col(2, "b.sql", "subtitle", 4, "integer")],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].message.includes("was text and is integer"), true);
});

Deno.test("an added column is not a finding: it costs no holder anything", async () => {
  const found = await replay(
    [col(1, "a.sql", "id", 1), col(2, "b.sql", "id", 1), col(2, "b.sql", "subtitle", 2)],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found, []);
});

Deno.test("a table dropped and recreated with the same shape is still a loss", async () => {
  // Matched on name and column number alone this reads as no change at all:
  // attnum restarts at 1 in the new relation, so every column pairs with the
  // dead table's and nothing differs — while every row is gone. The relation's
  // identity is the only thing that separates the two states.
  const found = await replay(
    [
      col(1, "a.sql", "id", 1, "integer", 100),
      col(1, "a.sql", "body", 2, "text", 100),
      col(2, "b.sql", "id", 1, "integer", 200),
      col(2, "b.sql", "body", 2, "text", 200),
    ],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].path, "b.sql");
  assertEquals(found[0].message.includes("was dropped and recreated"), true);
});

Deno.test("a recreated table is not reported as having renamed a column", async () => {
  // The worse half of the same defect: pairing across relations turns total
  // data loss into a note about JSON keys, which reads like a much smaller
  // event than the one that happened.
  const found = await replay(
    [
      col(1, "a.sql", "body", 2, "text", 100),
      col(2, "b.sql", "name", 2, "text", 200),
    ],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].message.includes("renamed"), false);
  assertEquals(found[0].message.includes("was dropped and recreated"), true);
});

Deno.test("the migration that drops the last table is still named", async () => {
  // It appears in neither the state before it nor the state after, so a step
  // list derived from the snapshot would leave the most destructive migration
  // there is as the only one a finding could not attribute.
  const found = await replay(
    [col(1, "a.sql", "id", 1), col(3, "c.sql", "id", 1)],
    [{ step: 1, mig: "a.sql" }, { step: 2, mig: "b_drops_everything.sql" }, { step: 3, mig: "c.sql" }],
  );
  assertEquals(found.length, 1);
  assertEquals(found[0].path, "b_drops_everything.sql");
});

Deno.test("the second pass forgives a duplicate domain and cast, and nothing else", () => {
  // Every one of these says "already exists", which is why matching that alone
  // forgave the two that must not be: a CREATE FUNCTION without OR REPLACE and
  // a CREATE TABLE are ordinary non-idempotent statements, and the exemption is
  // for constructs with no IF NOT EXISTS spelling at all. Messages measured
  // against the app's own database image.
  assertEquals(forgivable('ERROR:  type "portable_email" already exists'), true);
  assertEquals(forgivable("ERROR:  cast from type portable_email to type text already exists"), true);
  assertEquals(forgivable('ERROR:  function "f" already exists with same argument types'), false);
  assertEquals(forgivable('ERROR:  relation "article" already exists'), false);
});

Deno.test("the database service is picked by build context, not by name alone", () => {
  // The cluster an app instantiates declares a database of its own under a
  // name ending the same way; only one of the two is built out of this
  // directory. `target` is the cluster's published name for it.
  const picked = targetService({
    services: {
      "libraries_mecha-database": { image: "cluster:latest", build: { context: "/repo/libraries/mecha" } },
      "apps_realworld-database": { image: "app:latest", build: { context: "/repo/apps/realworld" } },
    },
  }, "/repo/apps/realworld", "database");
  assertEquals(picked?.image, "app:latest");
});

Deno.test("a spinner's escape codes do not reach a finding", () => {
  assertEquals(plain("\u001b[96m▀ \u001b[0m working (0s)\r   \r\u001b[91mFailed: no such table\u001b[0m"), "Failed: no such table");
});

Deno.test("the diagnosis survives the frames pgroll draws after it", () => {
  // The whole stderr, as pgroll actually emits it: the sentence is in the
  // middle, the word is "failed" and not "error", and the run ends on an erase
  // frame. Taking the last frame, or grepping for "error", yields "" — and the
  // finding then names a failure it does not describe.
  const stderr = "\u001b[96m| \u001b[0m starting (0s)\r" +
    "\u001b[91mfailed: column \"body\" does not exist\u001b[0m\n" +
    " cleaning up (0s)\r   \r";
  assertEquals(plain(stderr), 'failed: column "body" does not exist');
});

Deno.test("declared migrations are named without their extension, in applied order", () => {
  assertEquals(pgrollMigrations("03_c.json\n01_a.json\n02_b.json\nnotes.txt\n"), ["01_a", "02_b", "03_c"]);
});

Deno.test("applied order is byte order, as the migrate target applies them", () => {
  // localeCompare puts "1_z" before "10_a"; the runner globs and compares
  // under LC_ALL=C, where "_" sorts after every digit.
  assertEquals(pgrollMigrations("10_a.json\n1_z.json\n0_b.json\n"), ["0_b", "10_a", "1_z"]);
});

Deno.test({ name: "a dangling link is the app's file, not the image's", ignore: Deno.build.os === "windows" }, async () => {
  // stat follows the link and reports its missing target as absence, which
  // sent a reader to mecha's copy when the fault was the app's own link; the
  // link is what lstat sees.
  const dir = await Deno.makeTempDir({ prefix: "replay-locate-link-" });
  try {
    await Deno.mkdir(`${dir}/services/database/migrations`, { recursive: true });
    await Deno.symlink(`${dir}/nowhere.sql`, `${dir}/services/database/migrations/005_create_tables.sql`);
    assertEquals(
      await locate(dir, "/docker-entrypoint-initdb.d/005_create_tables.sql"),
      "services/database/migrations/005_create_tables.sql",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a finding lands on the app's own file when it has one", async () => {
  // And on the image's otherwise: a step the cluster contributed is not the
  // app's to fix, and sending a reader to a path they cannot open is worse
  // than naming the image.
  const dir = await Deno.makeTempDir({ prefix: "replay-locate-" });
  try {
    await Deno.mkdir(`${dir}/services/database/migrations`, { recursive: true });
    await Deno.writeTextFile(`${dir}/services/database/migrations/005_create_tables.sql`, "");
    assertEquals(
      await locate(dir, "/docker-entrypoint-initdb.d/005_create_tables.sql"),
      "services/database/migrations/005_create_tables.sql",
    );
    assertEquals(
      await locate(dir, "/docker-entrypoint-initdb.d/003_rls.sql"),
      "the database image's 003_rls.sql",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
