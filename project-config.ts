// Keep consumer contributions and program-derived rules under CUE unification.
export async function projectSay(appDir: string, programSay: unknown): Promise<unknown> {
  try {
    await Deno.stat(`${appDir}/pronto/config.cue`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return programSay;
    throw error;
  }
  const result = await new Deno.Command("cue", {
    args: ["export", "./pronto", "-e", `pronto.say & ${JSON.stringify(programSay)}`, "--out", "json"],
    cwd: appDir, stdout: "piped", stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("consumer configuration conflicts with the program's Sayt rules");
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
