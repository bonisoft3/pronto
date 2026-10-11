// A vendored unit's ports and memo, held by #App (`_unitRefusal`, one
// sentence per violation) and by #emit (a memo no answer could carry). Each
// refusal is asserted by its sentence, so a fixture failing elsewhere does not
// pass as the refusal under test; the well-formed program pins what shell.yaml
// carries to the terminal.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const answer = ({ fields = `{name: "uci", type: "string"}`, uniques = `[{name: "uq_answer_question", cols: ["fen", "nodes"]}]` } = {}) => `
      Answer: {
        table: "answer"
        durability: "device"
        uniques: ${uniques}
        fields: [
          {name: "id", type: "string", pk: true},
          {name: "fen", type: "string"},
          {name: "nodes", type: "string"},
          ${fields},
        ]
      }`;

const engine = ({ isolation = `"agent"`, reads = `["Payment"]`, raises = `["answer"]`, memo = `{entity: "Answer", key: ["fen", "nodes"]}` } = {}) => `
    engine: {
      isolation: ${isolation}
      ports: {reads: ${reads}, raises: ${raises}}
      ${memo === "" ? "" : `memo: ${memo}`}
      src: "shell/units/engine/unit.js"
      files: ["shell/units/engine/unit.js"]
      note: "an oracle"
    }`;

const program = (unit = engine(), entity = answer()) => paymentProgram({ entity, vendored: unit });

async function refused(code: string, sentence: string) {
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, false, `vet passed where the refusal was: ${sentence}`);
  assertStringIncludes(res.stderr, sentence);
}

Deno.test("an agent with a memo passes, and shell.yaml carries its ports as tables and its memo as table, key and columns", async () => {
  const vet = await cue(["vet", "-c", "-"], program());
  assert(vet.success, vet.stderr);
  const files = await emitFiles(program()) as unknown as Record<string, { data: { units: unknown } }>;
  assertEquals(files["shell/shell.yaml"].data.units, {
    engine: {
      isolation: "agent",
      ports: { reads: ["payment"], raises: ["answer"] },
      memo: { table: "answer", key: ["fen", "nodes"], columns: ["fen", "nodes", "uci"] },
      src: "shell/units/engine/unit.js",
    },
  });
});

Deno.test("a read naming no entity is refused", async () => {
  await refused(program(engine({ reads: `["Nope"]` })), "unit engine reads Nope, which is no declared entity");
});

Deno.test("an agent without a memo is refused: an agent is a question whose answer lands in a memo", async () => {
  await refused(program(engine({ memo: "" })), "unit engine is an agent with no memo: an agent is a question whose answer lands in a memo; a unit that acts on the world is a process hatch");
});

Deno.test("a memo on a realm is refused: only an agent asks a question", async () => {
  await refused(program(engine({ isolation: `"realm"` })), "unit engine is a realm with a memo: only an agent asks a question");
});

Deno.test("a memo naming no entity is refused", async () => {
  await refused(program(engine({ memo: `{entity: "Nope", key: ["fen"]}` })), "unit engine memo names Nope, which is no declared entity");
});

Deno.test("a memo keyed on a field the entity lacks is refused", async () => {
  await refused(program(engine({ memo: `{entity: "Answer", key: ["fen", "depth"]}` })), "unit engine memo keys on depth, which is not a field of Answer");
});

Deno.test("a memo entity with no unique over exactly the key is refused: the natural key an answer resolves against", async () => {
  await refused(
    program(engine(), answer({ uniques: `[{name: "uq_answer_fen", cols: ["fen"]}]` })),
    "unit engine memo on Answer has no unique over exactly (fen, nodes): the natural key an answer resolves against",
  );
});

Deno.test("a memo column that is not text is refused: an answer crosses the seat as strings", async () => {
  await refused(
    program(engine(), answer({ fields: `{name: "score", type: "int32"}` })),
    "unit engine memo on Answer: column score is int32, and an answer crosses the seat as strings",
  );
});

Deno.test("a memo unit raising other than one event is refused: a question has one answer", async () => {
  await refused(program(engine({ raises: `["answer", "verdict"]` })), "unit engine has a memo and raises 2 events: a question has one answer");
});

Deno.test("a memo wider than the seat's detail is refused by #emit: an answer carries every column in one event", async () => {
  const wide = Array.from({ length: 7 }, (_, i) => `{name: "c${i}", type: "string"}`).join(", ");
  await refused(program(engine(), answer({ fields: wide })), "unit engine memo on Answer has 9 columns, and the agent seat carries an answer of at most 8");
});
