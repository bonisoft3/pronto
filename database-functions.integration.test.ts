// Database functions in PostgreSQL: the compiled migration in the pinned
// database image, called from SQL inside a transaction that also writes, as a
// machine's action would.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { compileFunction } from "./database-functions.ts";
import { DATABASE, quote, run, terminal } from "./mecha-fixtures.ts";
import { LOOSE, ROUND, SPIN, THROW, round, reshaped } from "./testdata/function-fixtures.ts";

Deno.test({ name: "a function runs in plv8 inside the caller's transaction, and its failure rolls that back", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  const container = `pronto-functions-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=proof", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (source: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-U", "postgres"], source);
  const sql = async (source: string) => {
    const result = await psql(source);
    if (result.ok) return result.out;
    throw new Error(result.err);
  };
  const refused = async (source: string) => {
    const result = await psql(source);
    if (result.ok) throw new Error(`accepted: ${source}`);
    return result.err;
  };
  try {
    // Over TCP, which the image listens on only once its init has finished.
    for (let i = 0; ; i++) {
      if ((await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok) break;
      if (i >= 60) throw new Error("PostgreSQL did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const migration = [["round", ROUND], ["spin", SPIN], ["fail", THROW], ["loose", LOOSE]]
      .map(([name, source]) => compileFunction({ name, fuel: 10000 }, source, terminal)).join("\n");
    await sql(migration);
    await sql(`CREATE ROLE app_user;
      CREATE TABLE public.observation (id integer PRIMARY KEY, parsed jsonb NOT NULL);
      GRANT SELECT, INSERT ON public.observation TO app_user;`);

    await t.step("a call reshapes its argument in the commit that stores it", async () => {
      await sql(`SET ROLE app_user; INSERT INTO public.observation VALUES (1, public.fn_round(${quote(round)}));`);
      assertEquals(JSON.parse(await sql("SELECT parsed FROM public.observation WHERE id = 1")), reshaped);
    });
    await t.step("only the wrapper is the caller's: the engine is the definer's", async () => {
      assertStringIncludes(await refused(`SET ROLE app_user; SELECT pronto_functions.round('{}');`), "permission denied");
    });
    await t.step("exhausted fuel, a throw and an answer that is not JSON fail the transaction", async () => {
      for (const [call, message] of [
        ["public.fn_spin('{}')", "function spin: fuel exhausted"],
        [`public.fn_fail('{"kind": "round"}')`, "unparsable round"],
        [`public.fn_loose('{"n": 1}')`, "answer.value is not a finite number"],
      ]) {
        assertStringIncludes(await refused(`BEGIN; INSERT INTO public.observation VALUES (2, '{}'); INSERT INTO public.observation VALUES (3, ${call}); COMMIT;`), message);
        assertEquals(await sql("SELECT count(*) FROM public.observation WHERE id IN (2, 3)"), "0");
      }
    });
    await t.step("a session runs many calls, each with its whole budget", async () => {
      assertEquals(await sql(`SELECT count(*) FROM generate_series(1, 50) g WHERE public.fn_round(${quote(round)}) = ${quote(reshaped)}`), "50");
    });
  } finally {
    const stopped = await run("docker", ["stop", container]);
    if (!stopped.ok) throw new Error(stopped.err);
  }
} });
