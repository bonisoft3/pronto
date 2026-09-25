// CUE: rendering literals for the derivations that emit them, and asking a
// program what it says.

/** A CUE struct key: bare where it is an identifier, JSON-escaped otherwise.
 * CUE reads a lone backslash as an escape, and a key is whatever an author put
 * in an ir id or a program field name. */
export const quoteKey = (k: string) => (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

/**
 * What a program states at `expr`, as JSON.
 *
 * Through `mise x` rather than a bare `cue`, so the pin the app declares is the
 * one that answers — a checker reading a different CUE than the writer used
 * would disagree with it for reasons no finding could explain.
 */
export async function exportJson<T>(appDir: string, expr: string): Promise<T> {
  const out = await new Deno.Command("mise", {
    args: ["x", "--", "cue", "export", ".", "-e", expr, "--out", "json"],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`cue export ${expr} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
}
