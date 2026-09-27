import { exists } from "./missing.ts";

// Keep consumer contributions and program-derived rules under CUE unification.
export async function projectSay(appDir: string, programSay: unknown): Promise<unknown> {
  if (!(await exists(`${appDir}/pronto/config.cue`))) return programSay;
  const result = await new Deno.Command("cue", {
    args: ["export", "./pronto", "-e", `pronto.say & ${JSON.stringify(programSay)}`, "--out", "json"],
    cwd: appDir, stdout: "piped", stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("consumer configuration conflicts with the program's Sayt rules");
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
