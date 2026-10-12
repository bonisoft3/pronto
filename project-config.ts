import { exists } from "./missing.ts";

// Keep consumer contributions and program-derived rules under CUE unification.
export type Sources = { pronto: string; omnishell: string; mecha: string };

export async function projectSay(appDir: string, programSay: unknown, sources?: Sources): Promise<unknown> {
  if (!(await exists(`${appDir}/pronto/config.cue`))) return programSay;
  const consumer = sources === undefined ? "pronto" : `(pronto & ${JSON.stringify({ runtime: sources.pronto, omnishell: sources.omnishell, mecha: sources.mecha })})`;
  const result = await new Deno.Command("cue", {
    args: ["export", "./pronto", "-e", `${consumer}.say & ${JSON.stringify(programSay)}`, "--out", "json"],
    cwd: appDir, stdout: "piped", stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("consumer configuration conflicts with the program's Sayt rules");
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
