// The vendored grammar and the pinned binary have to be the same pgroll.
//
// pgroll.cue is imported from the schema.json a pgroll release ships, and
// nothing about the import records which release. A pin bumped without a
// regrab leaves apps writing migrations against operations the tool no longer
// has — and CUE would accept them, so the first sign would be a migration that
// vets here and is refused at the database.

import { assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows that yields "/C:/…", which is
// not a path anything can open.
const read = (rel: string) => Deno.readTextFile(fileURLToPath(new URL(rel, import.meta.url)));

Deno.test("the grammar was taken from the pgroll that is pinned", async () => {
  const grammar = /#PgRollGrammar:\s*"([^"]+)"/.exec(await read("./pgroll.cue"));
  const pinned = /"github:xataio\/pgroll":\s*\{version:\s*"([^"]+)"/.exec(await read("./distribution/config.cue"));
  assertEquals(grammar === null, false, "pgroll.cue declares no #PgRollGrammar");
  assertEquals(pinned === null, false, "distribution/config.cue pins no pgroll");
  assertEquals(grammar![1], pinned![1]);
});
