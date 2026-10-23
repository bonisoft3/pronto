// A Mecha machine's surface: the live entities a reader reaches it through
// (docs/decisions/2026-09-29-hybrid-machines.md, "A Mecha machine's surface is
// rows"). The app declares them like any entity, so they carry an ir section
// and identity; this checks each against the machine and names the columns
// past the protocol's own, which the machine fills from its projection's
// field of the same name. A view, a request and an input are json columns
// whose cel is the machine's shape (cel-shape.cue), vetted by schema.cue.
import type { MechaReducerMachine, Shape, Surface } from "./mecha-reducer.ts";
import { opens } from "./mecha-ports.ts";
import { exactBounds } from "./bounds.ts";
import { parseCel } from "./cel.ts";

type Field = { name: string; type: string; pk?: boolean; cel?: string };
export type SurfaceEntity = { table: string; durability: string; access?: { scope: string; owner?: string }; fields: Field[]; indexes?: { on: string }[] };

const ALIAS: Record<string, string> = { text: "string", int: "int32", bigint: "int64", timestamptz: "timestamp" };
// A seat's view, a command's request and an open's input hold a value of the
// machine's own shape, so they are json columns: the terminal hands a handler
// the value, and the column's cel, rendered from the shape (cel-shape.cue),
// is what the database and the battery judge it by.
const PARTS = {
  seat: { scope: "private", fields: { id: "string", instance_id: "uuid", actor: "uuid", seat: "string", revision: "int64", phase: "string", view: "json" } },
  command: { scope: "private", fields: { id: "string", instance_id: "uuid", actor: "uuid", request: "json", outcome: "string", reason: "string", revision: "int64" } },
  open: { scope: "private", fields: { id: "string", instance_id: "uuid", actor: "uuid", kind: "string", input: "json", outcome: "string", reason: "string" } },
  public: { scope: "public", fields: { id: "string" } },
  lease: { scope: "private", fields: { id: "string", actor: "uuid", beat: "int32" } },
} as const;
type Part = keyof typeof PARTS;

/** The parts a machine has: every instance has seats; a reader commands it
 * where it declares a reader's event, opens it by row unless a lease does,
 * and reads it publicly where it publishes. */
export function partsOf(m: MechaReducerMachine): Part[] {
  return [
    ...(m.initialize ? ["seat" as const] : []),
    ...(Object.values(m.events).some((e) => e.tier === "omnishell") ? ["command" as const] : []),
    ...(opens(m) ? ["open" as const] : []),
    ...(m.public ? ["public" as const] : []),
    ...(m.ports?.lease ? ["lease" as const] : []),
  ];
}

const fieldsOf = (shape: Shape | undefined) => shape?.type === "object" ? Object.keys(shape.fields) : [];

/** Why some value of `shape` would not fit a column, or null: its type, and
 * every bound its CEL states. A value the column refused would abort the step that
 * projected it, for every reader, whatever the rules computed. The CEL is read
 * only where it is read whole; a constraint saying more than ranges, lengths,
 * a set or a pattern is refused rather than trusted. */
export function misfit(field: Field, shape: Shape): string | null {
  const type = ALIAS[field.type] ?? field.type;
  if (shape.type === "integer") {
    if (type !== "int32" && type !== "int64") return `is ${field.type}, and the value it holds an integer`;
    if (type === "int32" && (shape.min < -(2 ** 31) || shape.max > 2 ** 31 - 1)) return `is int, and the value reaches ${shape.min}..${shape.max}`;
  } else if (shape.type === "boolean") {
    if (type !== "bool" && type !== "boolean") return `is ${field.type}, and the value it holds a boolean`;
  } else if (type !== "string") return `is ${field.type}, and the value it holds ${shape.type === "string" ? "a string" : "JSON text"}`;
  if (field.cel === undefined) return null;
  const b = exactBounds(parseCel(field.cel));
  if (b === null) return `states ${field.cel}, which is more than ranges, lengths, a set or a pattern, so no value can be shown to fit it`;
  const values = shape.type === "string" ? shape.values : undefined;
  if (b.enumValues) {
    const outside = values === undefined ? null : values.filter((v) => !b.enumValues!.includes(v));
    if (outside === null) return `admits ${b.enumValues.join(", ")}, and the value is any string`;
    if (outside.length) return `admits ${b.enumValues.join(", ")}, and the value may be ${outside.join(", ")}`;
    return null;
  }
  if (b.intMin !== undefined || b.intMax !== undefined) {
    if (shape.type !== "integer") return `bounds an integer, and the value is not one`;
    if (shape.min < (b.intMin ?? -Infinity) || shape.max > (b.intMax ?? Infinity)) {
      return `admits ${b.intMin ?? "-∞"}..${b.intMax ?? "∞"}, and the value reaches ${shape.min}..${shape.max}`;
    }
  }
  if (b.sizeMin !== undefined || b.sizeMax !== undefined || b.regex !== undefined) {
    if (shape.type !== "string") return `bounds text, and the value is ${shape.type === "integer" || shape.type === "boolean" ? `a ${shape.type}` : "JSON text no shape bounds"}`;
    const lengths = values === undefined ? [0, shape.maxLength] : [Math.min(...values.map((v) => v.length)), Math.max(...values.map((v) => v.length))];
    if (lengths[0] < (b.sizeMin ?? 0) || lengths[1] > (b.sizeMax ?? Infinity)) {
      return `admits lengths ${b.sizeMin ?? 0}..${b.sizeMax ?? "∞"}, and the value's reach ${lengths[0]}..${lengths[1]}`;
    }
    if (b.regex !== undefined) {
      const pattern = new RegExp(b.regex);
      if (values === undefined) return `matches ${b.regex}, and the value is any string`;
      const unmatched = values.filter((v) => !pattern.test(v));
      if (unmatched.length) return `matches ${b.regex}, and the value may be ${unmatched.join(", ")}`;
    }
  }
  return null;
}

export function surfaceOf(m: MechaReducerMachine, entities: Record<string, SurfaceEntity>): Surface {
  const byTable = new Map(Object.values(entities).map((e) => [e.table, e]));
  const extra: Record<string, string[]> = { seat: [], public: [] };
  for (const part of partsOf(m)) {
    const table = `${m.name}_${part}`;
    const entity = byTable.get(table);
    if (!entity) throw new Error(`${m.name}: its ${part} surface needs an entity on table ${table}`);
    const spec = PARTS[part];
    if (entity.durability !== "live") throw new Error(`${table}: a machine's surface is live`);
    if (entity.access?.scope !== spec.scope || (spec.scope === "private" && entity.access.owner !== "actor")) {
      throw new Error(`${table}: access must be ${spec.scope}${spec.scope === "private" ? " owned by actor" : ""}`);
    }
    const declared = new Map(entity.fields.map((f) => [f.name, f]));
    for (const [name, type] of Object.entries(spec.fields)) {
      const field = declared.get(name);
      if (!field) throw new Error(`${table}: missing protocol column ${name}`);
      if ((ALIAS[field.type] ?? field.type) !== type) throw new Error(`${table}.${name} is ${field.type}, the protocol's is ${type}`);
    }
    if (!declared.get("id")?.pk) throw new Error(`${table}: id is the key`);
    // A renewal prunes its actor's lapsed leases, found by actor: by a scan, it would read and
    // try to lock every reader's.
    if (part === "lease" && !entity.indexes?.some((i) => i.on === "actor")) throw new Error(`${table}: indexes must hold {on: "actor"}, which the renewal prunes by`);
    const projected = fieldsOf(part === "seat" ? m.view : part === "public" ? m.public : undefined);
    for (const name of declared.keys()) {
      if (Object.hasOwn(spec.fields, name)) continue;
      if (!projected.includes(name)) throw new Error(`${table}.${name} is neither the protocol's nor a field of the ${part === "seat" ? "view" : part === "public" ? "public projection" : part}`);
      extra[part].push(name);
    }
  }
  return { seat: extra.seat, public: extra.public };
}

/** Every surface column some value its machine projects would not fit: the
 * view's and the public projection's fields, and the seat's phase. */
export function fitting(m: MechaReducerMachine, entities: Record<string, SurfaceEntity>): string[] {
  const byTable = new Map(Object.values(entities).map((e) => [e.table, e]));
  const found: string[] = [];
  // The protocol fills its own columns, whatever the projection names alike;
  // only the phase among them is the machine's value.
  const check = (part: Part, shape: Shape | undefined, columns: [string, Shape][]) => {
    const table = `${m.name}_${part}`;
    const entity = byTable.get(table);
    if (!entity || shape?.type !== "object") return;
    for (const field of entity.fields) {
      const own = columns.find(([name]) => name === field.name)?.[1];
      if (own === undefined && Object.hasOwn(PARTS[part].fields, field.name)) continue;
      const source = own ?? shape.fields[field.name];
      if (source === undefined) continue;
      const why = misfit(field, source);
      if (why !== null) found.push(`${table}.${field.name} ${why}`);
    }
  };
  const parts = partsOf(m);
  if (parts.includes("seat") && m.state.type === "object") check("seat", m.view, [["phase", m.state.fields.phase]]);
  if (parts.includes("public")) check("public", m.public, []);
  return found;
}
