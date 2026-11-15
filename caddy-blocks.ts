// docker/Caddyfile written once, whole. A plugin's generate rule adds its
// routes to the door as a block between `# <name>:begin` and `# <name>:end`
// lines, before the first `handle /auth/*` (pronto-plugins' route steps). The
// writer's emission has none of them; written as it was, the door lost every
// plugin's routes until the rules after it put them back, and a reader in that
// window (a gate's test beside a stack's `launch --watch` generate) saw them
// gone (2026-11-07). So the writer keeps the blocks the file already holds,
// where a route step puts them, and writes the result in one rename. A plugin
// taken out of an app takes its block out with it: the writer no longer drops it.

const BEGIN = /^\s*# ([\w.-]+):begin\b/;
const end = (name: string) => new RegExp(`^\\s*# ${name.replace(/[.]/g, "\\.")}:end\\b`);

/** The marked blocks of a Caddyfile, in order, each its lines. */
export function blocks(text: string): { name: string; lines: string[] }[] {
  const lines = text.split("\n");
  const found: { name: string; lines: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BEGIN);
    if (!m) continue;
    const close = end(m[1]);
    const j = lines.findIndex((l, k) => k > i && close.test(l));
    if (j < 0) throw new Error(`docker/Caddyfile: \`# ${m[1]}:begin\` has no \`# ${m[1]}:end\``);
    found.push({ name: m[1], lines: lines.slice(i, j + 1) });
    i = j;
  }
  return found;
}

/**
 * The writer's Caddyfile with the blocks the current one holds that it does not
 * emit itself, placed as a route step places one: before the comment lines of
 * the first `handle /auth/*`. With no such line, or no current file, it is the
 * emission as it is.
 */
export function keepBlocks(current: string | null, emitted: string): string {
  if (current === null) return emitted;
  const own = new Set(blocks(emitted).map((b) => b.name));
  const kept = blocks(current).filter((b) => !own.has(b.name));
  if (kept.length === 0) return emitted;
  const lines = emitted.split("\n");
  const at = lines.findIndex((l) => l.startsWith("  handle /auth/*"));
  if (at < 0) return emitted;
  let start = at;
  while (start > 0 && lines[start - 1].startsWith("  #")) start--;
  return [...lines.slice(0, start), ...kept.flatMap((b) => b.lines), ...lines.slice(start)].join("\n");
}

/** A file replaced in one rename: a reader sees the old text or the new, never part of one. */
export async function writeWhole(path: string, text: string): Promise<void> {
  const tmp = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(tmp, text);
  try {
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}
