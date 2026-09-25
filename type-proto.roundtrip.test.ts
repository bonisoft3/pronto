import { deepStrictEqual, strict as assert } from "node:assert"
import { createFileRegistry, fromBinary, fromJson, toBinary, toJson } from "npm:@bufbuild/protobuf@2.14.1"
import { FileDescriptorSetSchema } from "npm:@bufbuild/protobuf@2.14.1/wkt"
import { generateProto } from "./type-proto.ts"
import { type TypeField } from "./portable-types.ts"
import { boundTypes } from "./type-table.ts"

const { fromProtoJSONValue, normalizeValue, toProtoJSONValue } = boundTypes()

const fields: TypeField[] = [
  { name: "string_value", type: "string" },
  { name: "bool_value", type: "bool" },
  { name: "int32_value", type: "int32" },
  { name: "int64_value", type: "int64" },
  { name: "double_value", type: "double" },
  { name: "bytes_value", type: "bytes" },
  { name: "uuid_value", type: "uuid" },
  { name: "timestamp_value", type: "timestamp" },
  { name: "date_value", type: "date" },
  { name: "time_value", type: "time" },
  { name: "timezone_value", type: "timezone" },
  { name: "duration_value", type: "duration" },
  { name: "decimal_value", type: "decimal", precision: 38, scale: 6 },
  { name: "json_value", type: "json" },
  { name: "geojson_value", type: "geojson" },
]

const canonical: Record<string, unknown> = {
  string_value: "café 😀",
  bool_value: false,
  int32_value: -2_147_483_648,
  int64_value: "9223372036854775807",
  double_value: 5e-324,
  bytes_value: "AP+A",
  uuid_value: "00112233-4455-6677-8899-aabbccddeeff",
  timestamp_value: "2026-09-21T12:00:00.123456Z",
  date_value: "2026-09-21",
  time_value: "09:30:00.123456",
  timezone_value: "America/Sao_Paulo",
  duration_value: "PT5400.123456S",
  decimal_value: "37.125",
  json_value: { a: [null, true, 0.1, "9007199254740993"] },
  geojson_value: { type: "Point", coordinates: [-46.6333, -23.5505] },
}

async function generatedSchema() {
  const directory = await Deno.makeTempDir({ prefix: "type-proto-" })
  try {
    const proto = generateProto({
      AllTypes: {
        name: "AllTypes",
        id: "0xc75ee275aaa2d971",
        fields: fields.map((field, index) => ({ ...field, ordinal: index + 1 })),
      },
    })
    const source = `${directory}/types.proto`
    const descriptor = `${directory}/types.bin`
    await Deno.writeTextFile(source, proto)
    const result = await new Deno.Command("protoc", {
      args: ["-I", directory, "--include_imports", `--descriptor_set_out=${descriptor}`, source],
      stdout: "piped",
      stderr: "piped",
    }).output()
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
    return createFileRegistry(fromBinary(FileDescriptorSetSchema, await Deno.readFile(descriptor))).getMessage("pronto.entities.AllTypes")!
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
}

Deno.test("generated protobuf carries every canonical type through ProtoJSON and binary", async () => {
  const schema = await generatedSchema()
  const protoJson = Object.fromEntries(fields.map((field) => [field.name, toProtoJSONValue(field, canonical[field.name])]))
  const message = fromJson(schema, protoJson as never)
  const binary = toBinary(schema, message)
  assert(binary.byteLength > 0)
  const jsonAfterBinary = toJson(schema, fromBinary(schema, binary), { useProtoFieldName: true }) as Record<string, unknown>

  deepStrictEqual(jsonAfterBinary, protoJson)
  for (const field of fields) {
    deepStrictEqual(fromProtoJSONValue(field, jsonAfterBinary[field.name]), normalizeValue(field, canonical[field.name]))
  }
})
