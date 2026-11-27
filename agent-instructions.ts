import { join } from "node:path";
import { ifMissing } from "./missing.ts";

export const AGENT_INSTRUCTIONS = "Before editing, use targeted searches to identify the smallest likely set of source files and relevant checks. Read those files to confirm ownership, follow references when needed, and revise the set when evidence changes.";

export async function writeAgentInstructions(appDir: string): Promise<void> {
  const path = join(appDir, "AGENTS.md");
  const existing = await ifMissing(Deno.readTextFile(path), null);
  if (existing?.includes(AGENT_INSTRUCTIONS)) return;
  const separator = existing === null || existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await Deno.writeTextFile(path, `${existing ?? ""}${separator}${AGENT_INSTRUCTIONS}\n`);
}
