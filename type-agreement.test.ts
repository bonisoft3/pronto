// The contract between the two sides of a type: CUE holds the definition
// (types.cue `valid`, which a seed row unifies with) and the client holds
// the transformations that must land inside it. Both are asked the same
// question here — is this value already canonical? — over the same values.
//
// Two invariants, and the second is why `beyond` exists:
//
//   1. Whatever the client calls canonical, the program's pattern accepts.
//      A violation means the client would write a row the program refuses.
//   2. Where the program accepts and the client refuses, the type names a
//      check under `beyond`. A type with `beyond: []` agrees exactly, so a
//      disagreement there is a pattern that drifted from the code.
//
// Not every named check can show as a residue: CUE's own string type excludes
// an unpaired surrogate and its JSON has no NaN, so `scalar-values` and
// `finite-numbers` close a gap in the EMITTED pattern that the language the
// pattern was written in does not have. Those are exercised by the client's
// own suite (types.test.ts); what is checked here is that no name in the
// vocabulary is dead, since a `beyond` nothing reads is a claim — which the
// json entry was, spelling RFC 8785, until it was measured.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundTypes, typeTable } from "./type-table.ts";
import type { TypeCheck, TypeField } from "./portable-types.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));
const table = typeTable();
const types = boundTypes();

const VALUES: Record<string, unknown[]> = {
  string: ["", "x", "é", "a b", "1"],
  bool: [true, false, "true", "t", 1],
  int32: [0, -2147483648, 2147483647, 2147483648, 1.5, "1"],
  int64: ["0", "-9223372036854775808", "9223372036854775807", "9223372036854775808", "01", "1.0", 1, "-0"],
  double: [0, 1.5, 1e308, "1.5"],
  bytes: ["", "AAAA", "AA==", "AA", "\\x00ff", "****"],
  uuid: ["98bdd8ed-cccc-44c2-820c-11236fa5f63e", "98BDD8ED-CCCC-44C2-820C-11236FA5F63E", "nope"],
  timestamp: [
    "2026-09-22T14:18:21.846230Z", "0001-01-01T00:00:00.000000Z", "9999-12-31T23:59:59.999999Z",
    "2026-99-99T99:99:99.000000Z", "2026-02-30T00:00:00.000000Z", "2026-09-22T14:18:21.84623Z",
    "2026-09-22 14:18:21.846230Z", "0000-01-01T00:00:00.000000Z",
  ],
  date: ["2031-03-19", "2024-02-29", "2031-02-30", "2031-13-01", "0000-01-01", "31-03-19"],
  time: ["14:18:21.500000", "00:00:00.000000", "24:00:00.000000", "14:18:21.5", "14:18:21"],
  timezone: ["UTC", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Not/AZone", "+01:00"],
  duration: ["PT0S", "PT28800S", "PT1800.5S", "PT315576000000S", "PT315576000001S", "PT08S", "08:00:00", "PT30M"],
  // 13 integer digits where the field's profile allows 12: a scale and a
  // precision are a field's, so no carrier-wide pattern can hold them.
  decimal: ["0", "37.1", "-1.5", "-0", "37.10", "1e3", ".5", "1234567890123.5"],
  json: [{ b: 1, a: 2 }, [1, 2], "x", 1, null, { nested: { deep: [true] } }],
  geojson: [
    { type: "Point", coordinates: [1, 2] },
    { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: null },
    { type: "Point", coordinates: [181, 0] },
    { type: "Point" },
    { coordinates: [1, 2] },
    // A ring that does not close: RFC 7946 requires it and no pattern can say so.
    { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
  ],
};

/** The vocabulary `beyond` draws from, read from the CUE that closes it. */
function checkVocabulary(): TypeCheck[] {
  const out = new Deno.Command("cue", {
    args: ["export", ".", "-e", "#typeChecks"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!out.success) throw new Error(`cue export of #typeChecks failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  return JSON.parse(new TextDecoder().decode(out.stdout)) as TypeCheck[];
}

const fieldOf = (type: string): TypeField => ({
  name: "v",
  type: type as TypeField["type"],
  ...(type === "decimal" ? { precision: 18, scale: 6 } : {}),
});

/** Whether the client says this value is already in its canonical form. */
function clientAccepts(typeName: string, value: unknown): boolean {
  try {
    return JSON.stringify(types.normalizeValue(fieldOf(typeName), value)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

/**
 * Whether CUE's `valid` admits it. One process per value: a value that misses
 * a required field is incomplete rather than bottom, so a batched disjunction
 * gives no verdict on the structural types.
 */
async function programAccepts(typeName: string, value: unknown): Promise<boolean> {
  const scratch = await Deno.makeTempDir({ prefix: "type-agreement-" });
  try {
    await Deno.writeTextFile(
      join(scratch, "table.cue"),
      (await Deno.readTextFile(join(dir, "types.cue"))).replace(/^package pronto$/m, "package probe"),
    );
    await Deno.writeTextFile(join(scratch, "case.cue"), `package probe\n\nx: ${JSON.stringify(value)} & #TypeConstraint["${typeName}"].valid\n`);
    const out = await new Deno.Command("cue", {
      args: ["export", "table.cue", "case.cue", "-e", "x"],
      cwd: scratch,
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

Deno.test({
  name: "what the client calls canonical is what the program's pattern admits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    assertEquals(Object.keys(VALUES).sort(), Object.keys(table.types).sort(), "every type is exercised");
    const wrong: string[] = [];
    const residue: Record<string, number> = {};
    for (const [typeName, values] of Object.entries(VALUES)) {
      const verdicts = await Promise.all(values.map(async (value) => ({
        value,
        client: clientAccepts(typeName, value),
        program: await programAccepts(typeName, value),
      })));
      for (const { value, client, program } of verdicts) {
        const shown = `${typeName} ${JSON.stringify(value)}`;
        if (client && !program) wrong.push(`${shown}: the client canonicalizes it, the program's pattern refuses it`);
        if (!client && program) {
          residue[typeName] = (residue[typeName] ?? 0) + 1;
          if (table.types[typeName].beyond.length === 0) {
            wrong.push(`${shown}: the program admits it and the client refuses it, with no check named under beyond`);
          }
        }
      }
    }
    const named = new Set(Object.values(table.types).flatMap((entry) => entry.beyond));
    for (const check of checkVocabulary()) {
      if (!named.has(check)) wrong.push(`${check} is in the vocabulary and no type asks for it`);
    }
    assert(wrong.length === 0, wrong.join("\n"));
  },
});
