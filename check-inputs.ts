import type { TypeTable } from "./portable-types.ts";

export type CheckInputs<Entity = unknown, Hatch = unknown, DuckStream = unknown, Machine = unknown> = {
  version: 1;
  types: TypeTable;
  entities: Record<string, Entity>;
  // The Mecha machines, as the compilers read them.
  hybrids: Record<string, Machine>;
  hatches: Record<string, Hatch>;
  rawMigrations: { name: string; src: string }[];
  duckstreams: Record<string, DuckStream>;
};

export async function readCheckInputs<Entity = unknown, Hatch = unknown, DuckStream = unknown, Machine = unknown>(
  appDir: string,
): Promise<CheckInputs<Entity, Hatch, DuckStream, Machine>> {
  const path = `${appDir}/.pronto/check-inputs.json`;
  const value = JSON.parse(await Deno.readTextFile(path));
  const record = (item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!record(value) || value.version !== 1 || !record(value.entities) || !record(value.hatches) || !record(value.hybrids) ||
    !Array.isArray(value.rawMigrations) || !record(value.duckstreams) ||
    !record(value.types) || !record(value.types.types) || !record(value.types.aliases)) {
    throw new Error(`${path}: invalid checker inputs; regenerate the application`);
  }
  return value;
}
