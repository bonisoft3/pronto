// The fact store: what an app states, as rows.
//
// Two rungs contribute, and every row says which one it came from. `claim` is
// where they meet: an id asserted by a rung under a kind. What must agree with
// what, and in which direction disagreement is a finding, is `pairing` — rows,
// not queries. invariants.sql states the modality rule the pairings encode.
//
// Written to .pronto/facts.json at generate, read by check-facts.ts at lint.
// The tables are the seam: nothing downstream re-reads program.cue or ir.html.

import type { IrAccept, IrPath } from "./acceptance.ts";
import type { Edge, Node } from "./diagrams.ts";
import { labelledKind } from "./diagrams.ts";
import type { Exception, Literal, Step } from "./styles.ts";

export type Facts = Record<string, Record<string, unknown>[]>;

export type FactEntity = {
  table: string;
  durability: string;
  fields?: { name: string; type?: string; cel?: string }[];
};
export type FactScreen = { name: string; entities: string[] };
export type FactChart = { screen: string; table: string; machine: string };

type Chart = {
  field: string;
  initial: string;
  on?: Record<string, unknown>;
  states: Record<string, { on?: Record<string, unknown>; after?: Record<string, unknown> }>;
};

/** The target a transition names, whatever spelling it wears: a bare string, a
 * candidate object, or the first of a candidate list. */
function target(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.length > 0 ? target(t[0]) : null;
  if (t !== null && typeof t === "object") {
    const v = (t as { target?: unknown }).target;
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** Rows from what the program states and its markup carries. */
export function programFacts(
  entities: Record<string, FactEntity>,
  screens: FactScreen[],
  charts: FactChart[],
): Facts {
  const entity: Record<string, unknown>[] = [];
  const field: Record<string, unknown>[] = [];
  for (const [name, e] of Object.entries(entities)) {
    entity.push({ name, "table": e.table, durability: e.durability });
    for (const f of e.fields ?? []) {
      field.push({ entity: name, name: f.name, type: f.type ?? null, cel: f.cel ?? null });
    }
  }
  const screen = screens.map((s) => ({ name: s.name }));
  const reads = screens.flatMap((s) => s.entities.map((e) => ({ screen: s.name, entity: e })));

  const chart: Record<string, unknown>[] = [];
  const chart_state: Record<string, unknown>[] = [];
  const transition: Record<string, unknown>[] = [];
  for (const c of charts) {
    const m = JSON.parse(c.machine) as Chart;
    chart.push({ screen: c.screen, "table": c.table, field: m.field, initial: m.initial });
    for (const [state, body] of Object.entries(m.states)) {
      chart_state.push({ screen: c.screen, "table": c.table, field: m.field, state });
      const own = body.on ?? {};
      // No invariant reads these yet. The obvious one — a state no arrow
      // targets — is unsound: a chart's field is a column, and a row already
      // holding a value renders that state without any transition producing it.
      // shadcnui's checkbox reaches `mixed` exactly that way.
      //
      // The table rides along because a screen may mount two charts over one
      // field name — the gallery does — and a row keyed on screen and field
      // alone joins each chart to the other's entity.
      //
      // from_state/to_state, because `from` and `to` are SQL keywords and a
      // quoted identifier in every query that touches them is a tax.
      const arrow = (event: string, tr: unknown) => {
        const to = target(tr);
        if (to === null) return;
        transition.push({
          screen: c.screen,
          "table": c.table,
          field: m.field,
          from_state: state,
          event,
          to_state: to,
        });
      };
      for (const [event, tr] of Object.entries(own)) arrow(event, tr);
      // An arrow is an arrow however the terminal arms it: `after` is a delayed
      // transition under the trace key canonical.ts gives it, and a root-level
      // `on` applies in every state that does not declare the same key
      // (machine.cue).
      for (const [delay, tr] of Object.entries(body.after ?? {})) arrow(`after:${delay}`, tr);
      for (const [event, tr] of Object.entries(m.on ?? {})) {
        if (!(event in own)) arrow(event, tr);
      }
    }
  }
  return { entity, field, screen, reads, chart, chart_state, transition };
}

/** Rows from the ir's diagrams. `name` and `kind` are null where the label is
 * prose rather than the `Article (crud)` convention — most of the corpus. */
export function diagramFacts(nodes: Node[], edges: Edge[]): Facts {
  return {
    diagram_node: nodes.map((n) => {
      const k = labelledKind(n.label);
      return {
        diagram: n.diagram,
        id: n.id,
        label: n.label,
        shape: n.shape,
        name: k?.name ?? null,
        kind: k?.kind ?? null,
      };
    }),
    diagram_edge: edges.map((e) => ({
      diagram: e.diagram,
      source: e.source,
      target: e.target,
      // The ir's own convention: dotted is a read, solid a write. No invariant
      // reads it yet — the read edge cannot be checked until a screen's derived
      // `reads` witnesses an embedded read, which it does not.
      stroke: e.stroke,
      label: e.label,
    })),
  };
}

/** .pronto/facts.json: tables sorted by name, rows one per line so a changed
 * fact is a changed line under review. */
export function renderFacts(facts: Facts): string {
  const tables = Object.keys(facts).sort().map((t) => {
    const rows = facts[t].map((r) => `    ${JSON.stringify(r)}`);
    return `  ${JSON.stringify(t)}: [\n${rows.join(",\n")}\n  ]`;
  });
  return `{\n${tables.join(",\n")}\n}\n`;
}

/**
 * Rows from the acceptance ledger and the two rungs that cite it. `where` names
 * the citing field so a finding can say which one made the promise, and the ir
 * and program path tables are separate so a gap is blamed on whichever side is
 * missing rather than on the ledger.
 */
export function acceptanceFacts(
  claimIds: string[],
  irPathRows: IrPath[],
  irAcceptRows: IrAccept[],
  tests: Record<string, string[]>,
  paths: Record<string, Record<string, string[]>>,
): Facts {
  const accept_citation: Record<string, unknown>[] = [];
  for (const [test, ids] of Object.entries(tests)) {
    for (const id of ids) accept_citation.push({ id, where: `tests.${test}` });
  }
  const path: Record<string, unknown>[] = [];
  for (const [screen, named] of Object.entries(paths)) {
    for (const [name, ids] of Object.entries(named)) {
      path.push({ screen, name });
      for (const id of ids) accept_citation.push({ id, where: `screens.${screen}.paths.${name}` });
    }
  }
  return {
    claim: [
      ...claimIds.map((id) => ({ rung: "acceptance", kind: "accept", id, where: null })),
      ...accept_citation.map((c) => ({ rung: "program", kind: "accept-citation", ...c })),
      ...irAcceptRows.map((r) => ({
        rung: "ir",
        kind: "accept-citation",
        id: r.accept,
        where: `tests.${r.test}`,
      })),
      ...path.map((p) => ({ rung: "program", kind: "path", id: `${p.screen}.${p.name}`, where: null })),
      ...irPathRows.map((r) => ({ rung: "ir", kind: "path", id: `${r.screen}.${r.name}`, where: null })),
    ],
    pairing: [
      {
        severity: "error",
        kind_a: "accept-citation",
        rung_a: "program",
        kind_b: "accept",
        rung_b: "acceptance",
        noun: "acceptance id",
        a_missing: "is accepted by the program, and acceptance.md does not promise it",
        b_missing: null,
      },
      {
        severity: "error",
        kind_a: "accept-citation",
        rung_a: "ir",
        kind_b: "accept",
        rung_b: "acceptance",
        noun: "acceptance id",
        a_missing: "is cited by an ir test, and acceptance.md does not promise it",
        b_missing: null,
      },
      {
        // Only the program-side direction. An ir path the program has not
        // declared is reported against the claim it would have settled, which
        // names what the gap costs; saying it again per path would report the
        // same gap once more for every path.
        severity: "error",
        kind_a: "path",
        rung_a: "ir",
        kind_b: "path",
        rung_b: "program",
        noun: "storyboard path",
        a_missing: null,
        b_missing: "is declared by the program, and no storyboard in ir.html designs it",
      },
    ],
    unique_claim: [
      { rung: "acceptance", kind: "accept" },
      { rung: "ir", kind: "path" },
      { rung: "program", kind: "path" },
    ],
    ir_path_accept: irPathRows.flatMap((r) =>
      r.accepts.map((accept) => ({ screen: r.screen, name: r.name, accept }))
    ),
  };
}

/**
 * The bijection surface as rows: every id the ir defines under a compared kind,
 * every id a program object claims back through its `ir` field, and each
 * screen's route on both sides. `where` names the program field so a finding can
 * point at the declaration rather than the id.
 *
 * A frame id is composed, not parsed: objects.ts builds it as
 * `${screen.ir}-${state}` and compares it whole, and these rows keep that.
 */
export function bijectionFacts(
  comparedKinds: readonly string[],
  irByKind: Map<string, string[]>,
  irRouteByScreen: Map<string, string | null>,
  decls: { kind: string; id: string; where: string }[],
  code: Record<string, unknown>,
): Facts {
  const claim: Record<string, unknown>[] = [];
  for (const [kind, ids] of irByKind) {
    for (const id of ids) claim.push({ rung: "ir", kind, id, where: null });
  }
  for (const d of decls) claim.push({ rung: "program", kind: d.kind, id: d.id, where: d.where });
  const screens = (code as { surface?: { screens?: Record<string, { ir: string; route?: string }> } })
    .surface?.screens ?? {};
  return {
    claim,
    unique_claim: comparedKinds.flatMap((kind) => [
      { rung: "ir", kind },
      { rung: "program", kind },
    ]),
    // One row per set two rungs must agree about, and per direction in which
    // disagreement is a finding. A tenth compared kind is a row; the query that
    // reads them does not change. The wording is authored here rather than
    // generated, because what a finding says is what makes it actionable.
    pairing: comparedKinds.map((kind) => ({
      severity: "error",
      kind_a: kind,
      rung_a: "ir",
      kind_b: kind,
      rung_b: "program",
      noun: kind,
      a_missing: "has no counterpart in program.cue",
      b_missing: "has no counterpart in ir.html",
    })),
    ir_route: [...irRouteByScreen].map(([id, route]) => ({ id, route })),
    program_route: Object.entries(screens).map(([key, s]) => ({
      id: s.ir,
      route: s.route ?? null,
      where: `screens.${key}`,
    })),
  };
}

/**
 * What the derivation read and what it wrote, each with the sha256 it had at
 * the time. check-facts re-hashes them before running a query, which is the one
 * precondition a query cannot state: every row below assumes the files these
 * name have not moved since. A source that has moved means the rows are stale;
 * a derived file that has moved was edited by hand.
 */
export function artifactFacts(hashes: { path: string; sha256: string; derived: boolean }[]): Facts {
  return { artifact: hashes.map((h) => ({ path: h.path, sha256: h.sha256, derived: h.derived })) };
}

/** Every constraint the program states, and every one the checked-in IR holds:
 * the two must name the same set, which invariants.sql asks. */
export function celFacts(sites: { entity: string; col: string | null; cel: string }[], irs: string[]): Facts {
  return {
    cel_site: sites.map((s) => ({ entity: s.entity, col: s.col, cel: s.cel })),
    cel_ir: irs.map((cel) => ({ cel })),
  };
}

/** Several builders contribute to one table — `claim` and `pairing` each come
 * from two — so parts are concatenated. Spreading them into one object literal
 * would keep only the last. */
export function mergeFacts(...parts: Facts[]): Facts {
  const out: Facts = {};
  for (const part of parts) {
    for (const [table, rows] of Object.entries(part)) out[table] = [...(out[table] ?? []), ...rows];
  }
  return out;
}

/**
 * Custom properties, by the stylesheet that declares them. The shared layer's
 * are `owned`; a screen's are its own. invariants.sql asks for the overlap.
 */
export function styleFacts(
  owned: Iterable<string>,
  app: { path: string; tokens: Iterable<string> }[],
): Facts {
  return {
    owned_token: [...owned].map((token) => ({ token })),
    app_token: app.flatMap((s) => [...s.tokens].map((token) => ({ path: s.path, token }))),
  };
}

/**
 * The literal rule's two sides, both off one cue export: what the shared layer
 * publishes under a name, and what an app's stylesheets write as a number.
 *
 * `exception_reason` carries the closed enum so the query joins against data
 * rather than restating the list, the way `denied_identifier` already does; and
 * `design_budget` carries the declared pending count, because a ceiling the
 * query invented would not be a diff a reviewer sees.
 */
export function literalFacts(
  steps: Step[],
  sheets: { path: string; literals: Literal[]; exceptions: Exception[] }[],
  reasons: readonly string[],
  pendingLiterals: number,
): Facts {
  return {
    scale_step: steps,
    app_literal: sheets.flatMap((s) => s.literals.map((l) => ({ path: s.path, ...l }))),
    literal_exception: sheets.flatMap((s) => s.exceptions.map((e) => ({ path: s.path, ...e }))),
    exception_reason: reasons.map((reason) => ({ reason })),
    design_budget: [{ pending_literals: pendingLiterals }],
  };
}

/**
 * The bytes a vendored vocabulary declares, and the names this platform refuses
 * of them. One hop upstream of the design.css rules below: those hold each
 * app's block equal to the export, and these hold the export equal to the
 * archive it quotes.
 */
export function vendorFacts(vendored: {
  sources: { name: string; origin: string; version: string }[];
  declarations: { source: string; token: string; value: string }[];
  exclusions: { source: string; pattern: string; reason: string }[];
}): Facts {
  return {
    vendor_source: vendored.sources.map(({ name, origin, version }) => ({ name, origin, version })),
    vendor_declaration: vendored.declarations,
    vendor_exclusion: vendored.exclusions,
  };
}

/**
 * What #scale publishes, and where each step's bytes are answerable. A step's
 * `source` is its bucket's, so the quotation joins it to the archive its own
 * bucket names rather than to whichever tree declares the name; `kind` says
 * whether there is an archive at all.
 */
export function scaleFacts(
  sources: { name: string; kind: string; origin: string; version: string }[],
  published: { token: string; value: string; source: string; kind: string }[],
): Facts {
  return {
    scale_source: sources,
    scale_declaration: published,
  };
}

/**
 * The emitted design.css read back as rows. It comes out of the same export as
 * the CSS itself, so these grade the emission rather than whatever happens to be
 * checked in.
 *
 * `block` is the selector a token is declared under; the emitter owns exactly
 * two — `:where(html)` for the rungs and `:root` for the roles — and the
 * invariants name the third if one ever appears.
 */
export function designCssFacts(
  declarations: {
    selector: string;
    token: string;
    value: string;
    colored: boolean;
    refs: string[];
  }[],
): Facts {
  return {
    design_declaration: declarations.map((d) => ({
      block: d.selector,
      token: d.token,
      value: d.value,
      colored: d.colored,
    })),
    design_reference: declarations.flatMap((d) =>
      d.refs.map((ref) => ({ block: d.selector, token: d.token, ref }))
    ),
  };
}

/** What the image serves, and what each stylesheet asks it for; invariants.sql's
 * import rule says why that is a join. */
export function importFacts(
  served: { file: string; target: string }[],
  imports: { path: string; target: string; line: number; resolved: string | null }[],
): Facts {
  return {
    served_file: served,
    app_import: imports,
  };
}

/**
 * What each Jessie module reaches for and what it evaluates to, beside the list
 * of identifiers it may not reach for. The scan and the query read one list.
 */
export function jessieFactRows(
  denied: { name: string; reason: string }[],
  modules: { path: string; references: string[]; completion: string }[],
): Facts {
  return {
    denied_identifier: denied.map((d) => ({ name: d.name, reason: d.reason })),
    handler_reference: modules.flatMap((m) => m.references.map((name) => ({ path: m.path, name }))),
    handler: modules.map((m) => ({ path: m.path, completion: m.completion })),
  };
}

/** A SHA-256 digest as lowercase hex, the one spelling every artifact row uses. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
