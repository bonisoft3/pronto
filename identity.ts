// Entity identity: the one writer of type ids and ordinals, and the check that
// what was minted is still there.
//
//   identity.ts mint  <appDir>   stamp what has no identity, grow the snapshot
//   identity.ts check <appDir>   findings as JSON; an error exits 1
//
// The snapshot (.pronto/identity.json) is history, not a derivation: only `mint`
// writes it and only by growing it, so a program that lost an identity cannot
// launder the loss by regenerating. The argument is
// docs/types-and-identity.md#identity, "Identity is append-only, and no model
// mints it".

import { boundTypes, boundCarriers } from "./type-table.ts";
import { exportJson } from "./cue.ts";
import { ifMissing } from "./missing.ts";

export type FieldId = { name: string; type: string; retired: boolean; precision?: number; scale?: number };
export type EntityId = { name: string; fields: Record<string, FieldId> };
export type Identities = Record<string, EntityId>;
export type Finding = { severity: "error" | "advisory"; path: string; message: string };

type ProgramField = { name: string; type: string; ordinal?: number; retired?: boolean; precision?: number; scale?: number };
type ProgramEntity = { name: string; table: string; id?: string; fields: ProgramField[] };

const SNAPSHOT = ".pronto/identity.json";

/** What the program holds, keyed the way a holder keys it. */
export function identitiesOf(entities: ProgramEntity[]): Identities {
  const out: Identities = {};
  for (const e of entities) {
    if (e.id === undefined) continue;
    const fields: Record<string, FieldId> = {};
    for (const f of e.fields) if (f.ordinal !== undefined) fields[String(f.ordinal)] = {
      name: f.name, type: f.type, retired: f.retired ?? false,
      ...(f.precision === undefined ? {} : { precision: f.precision, scale: f.scale }),
    };
    out[e.id] = { name: e.table, fields };
  }
  return out;
}

/** Everything the snapshot holds must still be in the program, under any label
 * and with the type it had: a rename is free, a disappearance and a retyping
 * are not. */
export function lost(snapshot: Identities, program: Identities): Finding[] {
  const types = boundTypes();
  const findings: Finding[] = [];
  for (const [id, was] of Object.entries(snapshot)) {
    const now = program[id];
    if (now === undefined) {
      findings.push({ severity: "error", path: "program.cue", message: `entity ${id} (was "${was.name}") is gone: an entity retires, it is never removed` });
      continue;
    }
    for (const [ordinal, field] of Object.entries(was.fields)) {
      const kept = now.fields[ordinal];
      if (kept === undefined) {
        findings.push({ severity: "error", path: "program.cue", message: `${now.name} lost ordinal ${ordinal} (was "${field.name}"): mark it retired instead` });
      } else if (types.canonicalType(kept.type) !== types.canonicalType(field.type)) {
        findings.push({ severity: "error", path: "program.cue", message: `${now.name}.${kept.name} (ordinal ${ordinal}) was ${field.type} and is ${kept.type}: a type change is a retirement beside an addition` });
      } else if (field.precision !== undefined && (kept.precision !== field.precision || kept.scale !== field.scale)) {
        findings.push({ severity: "error", path: "program.cue", message: `${now.name}.${kept.name}: decimal precision/scale changed` });
      } else if (field.retired && !kept.retired) {
        findings.push({ severity: "error", path: "program.cue", message: `${now.name}.${kept.name} (ordinal ${ordinal}) was retired and is live again: holders already dropped it` });
      }
    }
  }
  return findings;
}

/** Two entities may not share an id, which is what a copied block looks like. */
export function collisions(entities: ProgramEntity[]): Finding[] {
  const seen = new Map<string, string>();
  const findings: Finding[] = [];
  for (const e of entities) {
    if (e.id === undefined) continue;
    const other = seen.get(e.id);
    if (other !== undefined) findings.push({ severity: "error", path: "program.cue", message: `${other} and ${e.name} share type id ${e.id}` });
    seen.set(e.id, e.name);
  }
  return findings;
}

/** The ir carries identity as attributes; where it carries one, it agrees. */
export function irDisagreements(ir: string, entities: ProgramEntity[]): Finding[] {
  const findings: Finding[] = [];
  for (const e of entities) {
    if (e.id === undefined) continue;
    const section = sectionOf(ir, e.name);
    if (section === undefined) continue;
    const stamped = /data-type-id="([^"]*)"/.exec(section.open)?.[1];
    if (stamped !== e.id) {
      findings.push({ severity: "error", path: "ir.html", message: `#${e.name} carries type id ${stamped ?? "none"} and the program ${e.id}` });
    }
    for (const row of section.body.matchAll(/<tr data-ordinal="(\d+)"><td>([^<]*)<\/td>/g)) {
      const field = e.fields.find((f) => f.ordinal === Number(row[1]));
      if (field?.name !== row[2]) {
        findings.push({ severity: "error", path: "ir.html", message: `#${e.name} row "${row[2]}" carries ordinal ${row[1]}, which the program gives to ${field?.name ?? "nothing"}` });
      }
    }
  }
  return findings;
}

function sectionOf(ir: string, name: string): { open: string; body: string; at: number } | undefined {
  const open = new RegExp(`<section id="${name}"[^>]*data-kind="entity"[^>]*>`).exec(ir);
  if (open === null) return undefined;
  // To whichever comes first, its close or the next section's open: an entity
  // section that was never closed would otherwise own its neighbour's rows.
  const rest = ir.slice(open.index + open[0].length);
  const end = open.index + open[0].length + rest.search(/<\/section>|<section /);
  return { open: open[0], body: ir.slice(open.index, end), at: open.index };
}

async function exportEntities(appDir: string): Promise<ProgramEntity[]> {
  return Object.values(await exportJson<Record<string, ProgramEntity>>(appDir, "code.state.entities"));
}

async function readSnapshot(appDir: string): Promise<Identities | undefined> {
  const text = await ifMissing(Deno.readTextFile(`${appDir}/${SNAPSHOT}`), undefined);
  return text === undefined ? undefined : JSON.parse(text);
}

/** 64 random bits with the top one set, as `capnp id` mints them. */
function mintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  bytes[0] |= 0x80;
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stamps an entity's block in CUE source. It reads the shape every program
 * has — `Name: {` opening the entity, then `fields: [` holding `{name: "…", …}`
 * literals, one or several to a line — and refuses any other rather than
 * guessing, since a field it missed would mint a gap. Only the `fields` list is
 * read: a seed row may open with `name:` too. */
export function stampCue(source: string, e: ProgramEntity, id: string | undefined): string {
  const lines = source.split("\n");
  const open = lines.findIndex((l) => new RegExp(`^\\s*${e.name}: \\{\\s*$`).test(l));
  if (open < 0) throw new Error(`no "${e.name}: {" line opens the entity`);
  const indent = /^\s*/.exec(lines[open])![0];
  const close = lines.findIndex((l, i) => i > open && l === `${indent}}`);
  if (close < 0) throw new Error(`${e.name}: the entity's block does not close at its own indent`);
  const first = lines.findIndex((l, i) => i > open && i < close && l.startsWith(`${indent}\tfields: [`));
  const last = lines.findIndex((l, i) => i >= first && i < close && (l === `${indent}\t]` || (i === first && l.trimEnd().endsWith("]"))));
  if (first < 0 || last < 0) throw new Error(`${e.name}: no \`fields: [\` list closing at its own indent`);
  let next = Math.max(0, ...e.fields.map((f) => f.ordinal ?? 0));
  const seen = new Set<string>();
  for (let i = first; i <= last; i++) {
    lines[i] = lines[i].replace(/\{(ordinal: \d+, )?name: "([^"]+)"/g, (whole, had: string | undefined, name: string) => {
      if (!e.fields.some((f) => f.name === name)) return whole;
      seen.add(name);
      return had === undefined ? `{ordinal: ${++next}, name: "${name}"` : whole;
    });
  }
  if (seen.size !== e.fields.length) {
    const missed = e.fields.filter((f) => !seen.has(f.name)).map((f) => f.name);
    throw new Error(`${e.name}: ${missed.join(", ")} not declared as a {name: "…"} literal in its fields list: mint reads no other shape`);
  }
  if (id !== undefined) lines.splice(open + 1, 0, `${indent}\tid: "${id}"`);
  return lines.join("\n");
}

export function stampIr(ir: string, e: Required<Pick<ProgramEntity, "id">> & ProgramEntity): string {
  const section = sectionOf(ir, e.name);
  if (section === undefined) return ir;
  let body = section.body;
  if (!section.open.includes("data-type-id=")) {
    body = body.replace(section.open, section.open.replace(/>$/, ` data-type-id="${e.id}">`));
  }
  for (const f of e.fields) {
    body = body.replace(`<tr><td>${f.name}</td>`, `<tr data-ordinal="${f.ordinal}"><td>${f.name}</td>`);
  }
  return ir.slice(0, section.at) + body + ir.slice(section.at + section.body.length);
}

async function cueFiles(appDir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(appDir)) {
    if (entry.isFile && entry.name.endsWith(".cue") && !/^program_(derived|cel|terminal|validations)\.cue$/.test(entry.name)) {
      files.push(`${appDir}/${entry.name}`);
    }
  }
  return files.sort();
}

async function mint(appDir: string): Promise<void> {
  const before = await exportEntities(appDir);
  // Every stamp is computed before any is written: a refusal halfway would
  // otherwise leave a program that is part minted and a snapshot that is not.
  const sources = new Map<string, string>();
  for (const file of await cueFiles(appDir)) sources.set(file, await Deno.readTextFile(file));
  for (const e of before) {
    if (e.id !== undefined && e.fields.every((f) => f.ordinal !== undefined)) continue;
    const home = [...sources].find(([, text]) => new RegExp(`^\\s*${e.name}: \\{\\s*$`, "m").test(text));
    if (home === undefined) throw new Error(`${e.name} is declared in no .cue file of ${appDir}`);
    sources.set(home[0], stampCue(home[1], e, e.id === undefined ? mintId() : undefined));
  }
  for (const [file, text] of sources) await Deno.writeTextFile(file, text);

  const after = await exportEntities(appDir);
  const unminted = after.filter((e) => e.id === undefined).map((e) => e.name);
  if (unminted.length > 0) throw new Error(`still unminted after stamping: ${unminted.join(", ")}`);

  const irPath = `${appDir}/ir.html`;
  let ir = await Deno.readTextFile(irPath);
  for (const e of after) ir = stampIr(ir, e as Required<Pick<ProgramEntity, "id">> & ProgramEntity);
  await Deno.writeTextFile(irPath, ir);

  const program = identitiesOf(after);
  const snapshot = (await readSnapshot(appDir)) ?? {};
  const findings = lost(snapshot, program);
  if (findings.length > 0) throw new Error(`refusing to grow the snapshot over a loss:\n${findings.map((f) => f.message).join("\n")}`);
  await Deno.writeTextFile(`${appDir}/${SNAPSHOT}`, JSON.stringify(program, null, 2) + "\n");
  console.log(`minted: ${after.length} entities, ${after.reduce((n, e) => n + e.fields.length, 0)} fields`);
}

async function check(appDir: string): Promise<void> {
  const entities = await exportEntities(appDir);
  const program = identitiesOf(entities);
  const snapshot = await readSnapshot(appDir);
  const findings: Finding[] = [...collisions(entities)];
  const unminted = entities.filter((e) => e.id === undefined).map((e) => e.name);
  if (Object.keys(program).length > 0 && unminted.length > 0) {
    findings.push({ severity: "error", path: "program.cue", message: `no identity yet: ${unminted.join(", ")} — run identity.ts mint` });
  }
  for (const e of entities) {
    const bare = e.id === undefined ? [] : e.fields.filter((f) => f.ordinal === undefined).map((f) => f.name);
    if (bare.length > 0) findings.push({ severity: "error", path: "program.cue", message: `${e.name} has fields with no ordinal: ${bare.join(", ")} — run identity.ts mint` });
  }
  if (snapshot === undefined) {
    if (Object.keys(program).length > 0) {
      findings.push({ severity: "error", path: SNAPSHOT, message: "the program carries identities and no snapshot records them: only mint writes ids" });
    }
  } else {
    findings.push(...lost(snapshot, program));
    for (const [id, e] of Object.entries(program)) {
      const known = snapshot[id];
      const fresh = known === undefined ? Object.keys(e.fields) : Object.keys(e.fields).filter((o) => known.fields[o] === undefined);
      if (fresh.length > 0) {
        findings.push({ severity: "error", path: "program.cue", message: `${e.name} carries ${known === undefined ? `type id ${id}` : `ordinals ${fresh.join(", ")}`} that mint never wrote: an id nothing recorded cannot be told from a corrupted one` });
      }
    }
  }
  findings.push(...irDisagreements(await Deno.readTextFile(`${appDir}/ir.html`), entities));
  console.log(JSON.stringify(findings, null, 2));
  if (findings.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  const [verb, appDir = "."] = Deno.args;
  if (verb === "mint") await mint(appDir);
  else if (verb === "check") await check(appDir);
  else throw new Error("usage: identity.ts mint|check <appDir>");
}
