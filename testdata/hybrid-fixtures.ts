import { compileHybrid, type HybridMachine } from "../hybrid.ts";
import { instrument } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/instrument.ts";
import ses from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/vendor/ses.umd.min.js" with { type: "text" };

/** The compiler's terminal, from the omnishell hybrid-local.ts runs: what
 * write.ts reads where mise puts it. */
export const terminal = { instrument, ses };

export const ROOT = new URL("../../../", import.meta.url);
export const DATABASE = "bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b";
export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
export const initial = () => ({ phase: "playing", turn: "a", a: [0, 1, 2], b: [3, 4, 5], plays: [], deadline: 9007199254740000 });
export const request = (revision: number | string, kind = "play", payload: unknown = { card: 0 }) => ({ version: 1, expected_revision: String(revision), event: { kind, payload } });

/** The surface tables an app declares for a machine (mecha-surface.ts), bare:
 * no policy, so a test reads a seat by its actor. */
export const surface = (name: string) => `
CREATE TABLE public.${name}_seat (id text PRIMARY KEY, instance_id uuid NOT NULL, actor uuid NOT NULL, seat text NOT NULL,
  revision bigint NOT NULL, phase text NOT NULL, view text NOT NULL);
CREATE TABLE public.${name}_command (id text PRIMARY KEY, instance_id uuid NOT NULL, actor uuid NOT NULL DEFAULT public.auth_uid(),
  request text NOT NULL, outcome text, reason text, revision bigint);
GRANT SELECT ON public.${name}_seat TO app_user;
GRANT SELECT, INSERT ON public.${name}_command TO app_user;`;

export async function run(command: string, args: string[], input?: string) {
  const process = new Deno.Command(command, {
    args, cwd: ROOT, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await process.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr).trim() };
}

export async function fixture() {
  const result = await run("cue", ["export", "./apps/truco/tests/fixtures/hybrid", "-e", "reducer"]);
  if (!result.ok) throw new Error(result.err);
  const spec: HybridMachine = JSON.parse(result.out);
  const rules = await Deno.readTextFile(new URL("apps/truco/tests/fixtures/hybrid/turn.js", ROOT));
  return { spec, rules, compiled: await compileHybrid(spec, rules, terminal) };
}
