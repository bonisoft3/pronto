// The acceptance ledger and the ir's claims about it.
//
// acceptance.md is the ledger: one check per line, each closing with a
// `{#accept-…}` id. Two other rungs cite into it — the program's `accepts`
// fields, and the ir's `data-accepts` on its test elements — and the ir also
// states each screen's storyboard paths, which program.cue states again.
//
// Both sides are read because `paths` is optional program-side: a claim settled
// only in the ir's storyboard is a program that has not formalised it, and
// naming that against acceptance.md would blame the wrong file.

/** The ledger's app-relative name. emit.cue serves the four ladder files under
 * these literal names and the program names no path for them. */
export const LEDGER = "acceptance.md";

/** The attrs-style id closing each check line of the ledger. */
const CLAIM = /\{#(accept-[a-z0-9-]+)\}/g;

const TAG = /<[a-z][a-z0-9]*\s[^>]*>/gi;
const ID = /\sid="([^"]*)"/;
const KIND = /\sdata-kind="([^"]*)"/;
const OF = /\sdata-of="([^"]*)"/;
const ACCEPTS = /\sdata-accepts="([^"]*)"/;
const PATHS_BLOCK = /<script[^>]*\sdata-kind="paths"[^>]*>([\s\S]*?)<\/script>/g;

export type IrPath = { screen: string; name: string; accepts: string[] };
export type IrAccept = { test: string; accept: string };

/** Claim ids in the ledger, in file order. */
export function claims(md: string): string[] {
  return [...md.matchAll(CLAIM)].map((m) => m[1]);
}

/**
 * Each storyboard path the ir names, by the screen its block is `data-of`. The
 * block is JSON whose keys are the path names; a block that does not parse is
 * refused rather than read as a screen with no paths.
 */
export function irPaths(html: string): IrPath[] {
  const out: IrPath[] = [];
  for (const block of html.matchAll(PATHS_BLOCK)) {
    const screen = OF.exec(block[0])?.[1];
    if (screen === undefined) throw new Error('a data-kind="paths" block names no data-of screen');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(block[1]);
    } catch (e) {
      throw new Error(`the paths block of "${screen}" is not JSON: ${(e as Error).message}`);
    }
    for (const [name, body] of Object.entries(parsed)) {
      if (body === null || typeof body !== "object") {
        throw new Error(`the paths block of "${screen}" states no body for "${name}"`);
      }
      const cited = (body as { accepts?: unknown }).accepts;
      out.push({ screen, name, accepts: Array.isArray(cited) ? cited.map(String) : [] });
    }
  }
  return out;
}

/**
 * The claims each ir test element cites. `data-accepts` is whitespace
 * separated, and a test element carrying none cites none — which is itself a
 * fact worth a row's absence rather than an error, since the program's test is
 * where coverage is finally counted.
 */
export function irAccepts(html: string): IrAccept[] {
  const out: IrAccept[] = [];
  for (const tag of html.matchAll(TAG)) {
    const id = ID.exec(tag[0]);
    if (id === null || KIND.exec(tag[0])?.[1] !== "test") continue;
    for (const accept of (ACCEPTS.exec(tag[0])?.[1] ?? "").split(/\s+/).filter((s) => s !== "")) {
      out.push({ test: id[1], accept });
    }
  }
  return out;
}
