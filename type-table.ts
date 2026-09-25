// The type table, read from the CUE that states it (types.cue). Every
// tool here that converts or judges a type value binds this one, so what
// the program says a value is and what a holder does with it cannot drift
// apart into two statements.
import { fileURLToPath } from "node:url";
import { types, type TypeTable, type Types, type CarrierTable, type Carriers } from "./portable-types.ts";

// fileURLToPath, not URL.pathname: this is a cwd for spawning `cue`, and on
// Windows pathname yields "/C:/…", which no process can be started in.
const dir = fileURLToPath(new URL(".", import.meta.url));
let table: TypeTable | undefined;
let bound: Types | undefined;

export function typeTable(): TypeTable {
  if (table === undefined) {
    const out = new Deno.Command("cue", {
      args: ["export", ".", "-e", "{types: #types, aliases: #typeAlias}"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!out.success) throw new Error(`cue export of the type table failed: ${new TextDecoder().decode(out.stderr).trim()}`);
    table = JSON.parse(new TextDecoder().decode(out.stdout)) as TypeTable;
  }
  return table;
}

export const carrierTable = typeTable;

/** The table bound to the client's transformations, read once per process. */
export function boundTypes(): Types {
  bound ??= types(typeTable());
  return bound;
}

export const boundCarriers = boundTypes;

