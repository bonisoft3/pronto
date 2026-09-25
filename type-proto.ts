import { type TypeField, type CarrierField } from "./portable-types.ts";
import { boundTypes, boundCarriers } from "./type-table.ts";

export type ProtoEntity = {
  name: string;
  id?: string;
  fields: (TypeField & { ordinal?: number; retired?: boolean })[];
};

const types: Record<string, string> = {
  string: "string", bool: "bool", int32: "int32", int64: "int64", double: "double", bytes: "bytes",
  uuid: "string", decimal: "string", date: "string", time: "string", timezone: "string",
  timestamp: "google.protobuf.Timestamp", duration: "google.protobuf.Duration",
  json: "google.protobuf.Value", geojson: "google.protobuf.Value",
};

export function generateProto(entities: Record<string, ProtoEntity>): string {
  const bound = boundTypes();
  const messages = Object.values(entities).filter((e) => e.id !== undefined).sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) throw new Error(`invalid protobuf message name: ${e.name}`);
    const seen = new Set<number>();
    const fields = e.fields.map((f) => {
      const n = f.ordinal;
      if (n === undefined || !Number.isInteger(n) || n <= 0 || n > 536870911 || (n >= 19000 && n <= 19999) || seen.has(n)) {
        throw new Error(`${e.name}.${f.name}: missing, duplicate or invalid protobuf ordinal ${n}`);
      }
      seen.add(n);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) throw new Error(`invalid protobuf field name: ${f.name}`);
      if (f.retired) return `  reserved ${n};\n  reserved "${f.name}";`;
      const type = types[bound.canonicalType(f.type)];
      if (!type) throw new Error(`${e.name}.${f.name}: no protobuf type for ${f.type}`);
      return `  ${type.startsWith("google.") ? "" : "optional "}${type} ${f.name} = ${n} [json_name = "${f.name}"];`;
    });
    return `message ${e.name} {\n${fields.join("\n")}\n}`;
  });
  return `syntax = "proto3";\npackage pronto.entities;\n\nimport "google/protobuf/timestamp.proto";\nimport "google/protobuf/duration.proto";\nimport "google/protobuf/struct.proto";\n\n${messages.join("\n\n")}\n`;
}
