import { compileHybrid, type HybridMachine } from "./hybrid.ts";

export const ROOT = new URL("../../", import.meta.url);
export const DATABASE = "bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b";
export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
export const initial = () => ({ phase: "playing", turn: "a", a: [0, 1, 2], b: [3, 4, 5], plays: [], deadline: 9007199254740000 });
export const request = (revision: number | string, kind = "play", payload: unknown = { card: 0 }) => ({ version: 1, expected_revision: String(revision), event: { kind, payload } });

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
  const result = await run("cue", ["export", "./apps/truco/tests/fixtures/hybrid", "-e", "machine"]);
  if (!result.ok) throw new Error(result.err);
  const spec: HybridMachine = JSON.parse(result.out);
  const rules = await Deno.readTextFile(new URL("apps/truco/tests/fixtures/hybrid/turn.js", ROOT));
  return { spec, rules, compiled: await compileHybrid(spec, rules) };
}
