// A vendored unit's ports and memo, held by #App (`_unitRefusal`, one
// sentence per violation) and by #emit (a memo no answer could carry). Each
// refusal is asserted by its sentence, so a fixture failing elsewhere does not
// pass as the refusal under test; the well-formed program pins what shell.yaml
// carries to the terminal.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { DETAIL_BYTES, REALM_GRANTS } from "../omnishell/interpreter/hatch.js";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const answer = ({ fields = `{name: "uci", type: "string"}`, uniques = `[{name: "uq_answer_question", cols: ["fen", "nodes"]}]`, cel = "", durability = "device" } = {}) => `
      Answer: {
        table: "answer"
        durability: "${durability}"
        uniques: ${uniques}
        ${cel}
        fields: [
          {name: "id", type: "string", pk: true},
          {name: "fen", type: "string"},
          {name: "nodes", type: "string"},
          ${fields},
        ]
      }`;

const engine = ({ isolation = `"agent"`, reads = `["Payment"]`, raises = `{answer: {}}`, memo = `{entity: "Answer", key: ["fen", "nodes"]}` } = {}) => `
    engine: {
      isolation: ${isolation}
      ports: {reads: ${reads}, raises: ${raises}}
      ${memo === "" ? "" : `memo: ${memo}`}
      src: "shell/units/engine/unit.js"
      files: ["shell/units/engine/unit.js"]
      note: "an oracle"
    }`;

const STRING = { type: "string", maxLength: 65536 };

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
      ports: { reads: ["payment"], raises: { answer: { type: "object", fields: { fen: STRING, nodes: STRING, uci: STRING } } } },
      memo: { table: "answer", key: ["fen", "nodes"], columns: ["fen", "nodes", "uci"] },
      files: ["shell/units/engine/unit.js"],
      src: "shell/units/engine/unit.js",
    },
  });
});

Deno.test("the host registers a memo even when no screen reads or writes its table", async () => {
  for (const durability of ["tab", "device", "offline", "live", "server"]) {
    const files = await emitFiles(program(engine(), answer({ durability }))) as unknown as Record<string, { data: {
      tables: string[];
      local?: Record<string, string>;
      schema: Record<string, { durability: string; fields: { name: string }[] }>;
      uniques: Record<string, string[][]>;
    } }>;
    const shell = files["shell/shell.yaml"].data;
    assertEquals(shell.schema.answer.durability, durability);
    assertEquals(shell.schema.answer.fields.map((f) => f.name), ["id", "fen", "nodes", "uci"]);
    assertEquals(shell.uniques.answer, [["fen", "nodes"]]);
    const local = durability === "tab" || durability === "device";
    assertEquals(shell.local?.answer, local ? durability : undefined);
    assertEquals(shell.tables.includes("answer"), !local);
  }
});

Deno.test("memo keys cannot name primary or retired fields that the answer does not carry", async () => {
  for (const key of [["id"], ["id", "fen"], ["gone"]]) {
    await refused(program(
      engine({ memo: `{entity: "Answer", key: ${JSON.stringify(key)}}` }),
      answer({ fields: `{name: "gone", type: "string", retired: true}`, uniques: `[{name: "uq_answer_key", cols: ${JSON.stringify(key)}}]` }),
    ), `unit engine memo keys on ${key[0]}, which is not an active non-primary field of Answer`);
  }
});

Deno.test("a read naming no entity is refused", async () => {
  await refused(program(engine({ reads: `["Nope"]` })), "unit engine reads Nope, which is no declared entity");
});

const BABYLON = "https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js";
const presenter = ({ raises = "{}", scripts = `["${BABYLON}"]` } = {}) => `
    painter: {
      isolation: "agent"
      ports: {reads: [], raises: ${raises}}
      scripts: ${scripts}
      src: "shell/units/painter/unit.js"
      files: ["shell/units/painter/unit.js", "assets/manifest.json"]
      note: "paints the kinetic plane"
    }`;

Deno.test("an agent without a memo is a presenter, and shell.yaml carries its scripts' integrity, what it reads and its worker's policy", async () => {
  const vet = await cue(["vet", "-c", "-"], program(presenter()));
  assert(vet.success, vet.stderr);
  const files = await emitFiles(program(presenter())) as unknown as Record<string, { data: { units: unknown; presenter: { policy: string } } }>;
  assertEquals(files["shell/shell.yaml"].data.units, {
    painter: {
      isolation: "agent",
      ports: { reads: [], raises: {} },
      role: "presenter",
      scripts: [{ url: BABYLON, integrity: "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC" }],
      files: ["shell/units/painter/unit.js", "assets/manifest.json"],
      seed: false,
      src: "shell/units/painter/unit.js",
    },
  });
  assertStringIncludes(files["shell/shell.yaml"].data.presenter.policy, "connect-src blob:;");
  assertEquals((files["shell/shell.yaml"].data.presenter as unknown as { scripted: string[] }).scripted, ["script", "worker", "sharedworker", "serviceworker"]);
});

// A presenter's worker is unsealed: what it computes depends on its thread's
// timing, so an event from it would land a nondeterministic source in a chart.
Deno.test("a presenter that raises is refused: it paints and raises nothing", async () => {
  await refused(program(presenter({ raises: `{drawn: {type: "object", fields: {}}}` })), "unit painter is an agent presenter and raises drawn: what it computes is a function of its thread's timing, not of anything a person did, so it paints and raises nothing");
});

Deno.test("scripts on a unit that is no agent presenter are refused", async () => {
  await refused(program(engine({ isolation: `"realm"`, memo: "", raises: "{}" }).replace("note:", `scripts: ["${BABYLON}"]\n      note:`)), "unit engine names scripts and is no agent presenter: only a presenter's worker runs the terminal's pinned scripts");
});

Deno.test("a script the terminal does not offer is refused", async () => {
  const res = await cue(["export", "-", "-e", "out"], program(presenter({ scripts: `["https://cdn.example/x.js"]` })));
  assertEquals(res.success, false);
  assertStringIncludes(res.stderr, `undefined field: "https://cdn.example/x.js"`);
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
  await refused(program(engine({ raises: `{answer: {}, verdict: {}}` })), "unit engine has a memo and raises 2 events: a question has one answer");
});

Deno.test("a memo's answer is shaped by its entity: each column text bounded by its declared size", async () => {
  const files = await emitFiles(program(engine(), answer({ cel: `cel: bounds: {uci: {sizeMax: 5}}` }))) as unknown as Record<string, { data: { units: { engine: { ports: { raises: unknown } } } } }>;
  assertEquals(files["shell/shell.yaml"].data.units.engine.ports.raises, {
    answer: { type: "object", fields: { fen: STRING, nodes: STRING, uci: { type: "string", maxLength: 5 } } },
  });
});

Deno.test("a memo declaring its answer's fields is refused: the shape is derived from what it lands in", async () => {
  await refused(
    program(engine({ raises: `{answer: {type: "object", fields: {uci: {type: "string", maxLength: 4}}}}` })),
    "unit engine has a memo and declares fields for answer: an answer's shape is the memo's key and columns, derived",
  );
});

Deno.test("a realm unit carries each raise's declared shape to the terminal", async () => {
  const raises = `{pin: {type: "object", fields: {latitude: {type: "string", maxLength: 32}, zoom: {type: "integer", min: 0, max: 22}}}}`;
  const files = await emitFiles(program(engine({ isolation: `"realm"`, memo: "", raises }))) as unknown as Record<string, { data: { units: { engine: { ports: { raises: unknown } } } } }>;
  assertEquals(files["shell/shell.yaml"].data.units.engine.ports.raises, {
    pin: { type: "object", fields: { latitude: { type: "string", maxLength: 32 }, zoom: { type: "integer", min: 0, max: 22 } } },
  });
});

Deno.test("a realm's declared grant reaches the terminal, and a grant on any other seat is refused", async () => {
  const realm = engine({ isolation: `"realm"`, memo: "", raises: "{}" }).replace("note:", `grants: ["geolocation"]\n      note:`);
  const files = await emitFiles(program(realm)) as unknown as Record<string, { data: { units: { engine: { grants: unknown } } } }>;
  assertEquals(files["shell/shell.yaml"].data.units.engine.grants, ["geolocation"]);
  // Loaded outside the seat's frame, a realm's document would run at this
  // origin under no policy: the door sends it the seat's sandbox.
  const caddy = (files as unknown as Record<string, { text: string }>)["docker/Caddyfile"].text;
  assertStringIncludes(caddy, `@realm path /shell/units/engine/unit.js`);
  assertStringIncludes(caddy, `header @realm Content-Security-Policy "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'"`);
  await refused(
    program(engine().replace("note:", `grants: ["geolocation"]\n      note:`)),
    "unit engine is seated as agent and asks for geolocation: only a realm's frame is delegated a permission",
  );
});

// The seat's one bound is published once, as the terminal's offer; hatch.js
// states it again, and this is what holds the two equal.
Deno.test("the seat's size bound is the terminal's published offer", async () => {
  const res = await cue(["export", "-", "-e", "out", "--out", "json"], `
package test

import terminal "bonisoft.org/plugins/omnishell:terminal"

out: [terminal.#Terminal.capabilities.hatch.agent.detail, terminal.#Terminal.capabilities.hatch.realm.detail, terminal.#Terminal.capabilities.hatch.realm.grants]
`);
  assert(res.success, res.stderr);
  assertEquals(JSON.parse(res.stdout), [{ bytes: DETAIL_BYTES }, { bytes: DETAIL_BYTES }, [...REALM_GRANTS]]);
});
