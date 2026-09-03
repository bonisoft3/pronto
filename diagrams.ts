// The diagram front end: the one place a mermaid block becomes data.
//
// mermaid's own parser is the only one that reads these. @mermaid-js/parser is
// Langium-based and answers "Unknown diagram type" for flowchart and for
// stateDiagram alike, so a standalone parse is not available at any version —
// and mermaid's parser wants a DOM, which linkedom supplies.
//
// A vertex's shape and an edge's stroke are the claim: an ir draws an entity as
// a cylinder and a read as a dotted arrow, and both are what an invariant is
// written against. The label carries the name and, by convention, a
// parenthesised kind.

import { parseHTML } from "npm:linkedom@0.18.4";

// A node id is unique to its own block and no further: thenote reuses `U`, `V`
// and `C` across sixteen diagrams for unrelated things. Every row carries the
// diagram it came from, or one block's claim answers for another's.
export type Node = { diagram: number; id: string; label: string; shape: string };
export type Edge = { diagram: number; source: string; target: string; stroke: string; label: string };

/** Both container spellings the corpus uses — thenote and realworld write
 * <pre class="mermaid">, truco and xpense write <div class="mermaid"> — with the
 * class in any attribute position, since an id may precede it. */
const BLOCK = /<(pre|div)\s([^>]*)>([\s\S]*?)<\/\1>/g;
const MERMAID = /(^|\s)class="mermaid"/;

/** The ir is html, so its diagram source arrives entity-encoded; mermaid is
 * handed the characters an author typed. */
const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

let parser: { getDiagramFromText: (src: string) => Promise<{ db: DiagramDb }> } | null = null;
let restore: (() => void) | null = null;
type DiagramDb = {
  getVertices: () => Map<string, RawVertex> | Record<string, RawVertex>;
  getEdges: () => RawEdge[];
  clear?: () => void;
};
type RawVertex = { id: string; text?: string; type?: string };
type RawEdge = { start: string; end: string; text?: string; stroke?: string };

/** mermaid initialised against a linkedom document, once per process: DOMPurify
 * resolves to a factory rather than an instance without a window, and every
 * parse then fails on `sanitize is not a function`. */
async function mermaid() {
  if (parser !== null) return parser;
  // linkedom's window is not the DOM lib's Window, and TypeScript resolves the
  // name to the global type; the cast is at the boundary so nothing past it
  // pretends to know the shape.
  const dom = parseHTML("<!doctype html><html><body></body></html>") as unknown as {
    window: Record<string, unknown>;
    document: unknown;
  };
  const { window, document } = dom;
  // Installed for mermaid's initialise and taken back off. write.ts keeps
  // emitting after derive() returns, and a dependency that feature-detects
  // `typeof window` would silently take its browser branch under Deno.
  const globals: Record<string, unknown> = {
    window,
    document,
    Node: window.Node,
    Element: window.Element,
    DocumentFragment: window.DocumentFragment,
    HTMLElement: window.HTMLElement,
    NodeFilter: window.NodeFilter,
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const had = Object.keys(globals).map((k) => [k, k in g, g[k]] as const);
  Object.assign(g, globals);
  restore = () => {
    for (const [k, present, was] of had) {
      if (present) g[k] = was;
      else delete g[k];
    }
  };
  const m = await import("npm:mermaid@11.9.0");
  const api = (m.default ?? m) as unknown as {
    initialize: (c: unknown) => void;
    mermaidAPI: { getDiagramFromText: (src: string) => Promise<{ db: DiagramDb }> };
  };
  api.initialize({ startOnLoad: false, securityLevel: "loose" });
  parser = api.mermaidAPI;
  return parser;
}

/** Every node and edge of every mermaid block in one ir, in document order. A
 * block mermaid itself rejects is an error: an ir that renders a broken diagram
 * to a reviewer states nothing this pass can check. */
export async function irDiagrams(html: string): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const api = await mermaid();
  let diagram = 0;
  for (const block of html.matchAll(BLOCK)) {
    if (!MERMAID.test(block[2])) continue;
    const src = decode(block[3]).trim();
    diagram++;
    let db: DiagramDb;
    try {
      db = (await api.getDiagramFromText(src)).db;
      // getVertices/getEdges are the flowchart db's. A stateDiagram answers
      // getStates/getRelations, and reading through the wrong pair would throw a
      // TypeError with no diagram named; SPEC.md permits the kind, so it is
      // refused by name until an emitter here reads it.
      if (typeof db.getVertices !== "function" || typeof db.getEdges !== "function") {
        throw new Error("its diagram kind states no vertices; only flowchart and graph are read");
      }
    } catch (e) {
      throw new Error(`mermaid block ${diagram} (<${block[1]}>): ${(e as Error).message}`);
    }
    const vs = db.getVertices();
    const seen = new Set<string>();
    for (const v of vs instanceof Map ? [...vs.values()] : Object.values(vs)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      nodes.push({ diagram, id: v.id, label: v.text ?? v.id, shape: v.type ?? "square" });
    }
    for (const e of db.getEdges()) {
      edges.push({ diagram, source: e.start, target: e.end, stroke: e.stroke ?? "normal", label: e.text ?? "" });
    }
    db.clear?.();
  }
  restore?.();
  restore = null;
  return { nodes, edges };
}

/**
 * The kind a label names, as `Article (crud)` — or null where the label is
 * prose, which most of the corpus is. The kind is the leading word of the
 * parenthetical and anything after a colon is its detail, because truco writes
 * `arena (screen: /)` and `dealer (engine: deck, manilhas, …)`.
 */
export function labelledKind(label: string): { name: string; kind: string } | null {
  const m = /^(.*?)\s*\(([a-z][a-z ]*?)\s*(?::[^)]*)?\)\s*$/.exec(label);
  return m === null ? null : { name: m[1].trim(), kind: m[2].trim() };
}
