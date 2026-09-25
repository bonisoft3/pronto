// A seed row's spelling is CUE's to judge, through #TypeConstraint[...].valid, and
// this is what CUE cannot say: the checks the table names under `beyond`, run
// by the same client code every other holder runs.
import { type TypeField, type CarrierField } from "./portable-types.ts";
import { boundTypes, typeTable } from "./type-table.ts";

export type TypeEntity = { fields: TypeField[]; seed?: Record<string, unknown>[] };
export type CarrierEntity = TypeEntity;

export function checkTypeSeeds(entities: Record<string, TypeEntity>): void {
  const table = typeTable(), types = boundTypes();
  for (const [entity, { fields, seed = [] }] of Object.entries(entities)) {
    for (const [index, row] of seed.entries()) {
      for (const field of fields) {
        if (!(field.name in row) || row[field.name] === null) continue;
        if (table.aliases[field.type] !== undefined) continue;
        const value = row[field.name];
        const normalized = types.normalizeValue(field, value);
        if (JSON.stringify(normalized) !== JSON.stringify(value)) {
          throw new Error(`${entity}.seed[${index}].${field.name}: noncanonical ${field.type}`);
        }
      }
    }
  }
}

export const checkCarrierSeeds = checkTypeSeeds;

