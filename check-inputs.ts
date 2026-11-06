import type { TypeTable } from "./portable-types.ts";

export type CheckInputs<Entity = unknown, Hatch = unknown, DuckStream = unknown, Machine = unknown> = {
  version: 1;
  terminal?: boolean;
  types: TypeTable;
  entities: Record<string, Entity>;
  // The Mecha machines, as the compilers read them.
  reducers: Record<string, Machine>;
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
  if (!record(value) || value.version !== 1 || (value.terminal !== undefined && typeof value.terminal !== "boolean") || !record(value.entities) || !record(value.hatches) || !record(value.reducers) ||
    !Array.isArray(value.rawMigrations) || !record(value.duckstreams) ||
    !record(value.types) || !record(value.types.types) || !record(value.types.aliases)) {
    throw new Error(`${path}: invalid checker inputs; regenerate the application`);
  }
  return value;
}
