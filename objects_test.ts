// The bijection's program side: what a program claims the ir carries, and which
// claims are owed. Presence is by reach (decisions/2026-08-27-review-by-consequence.md):
// a tab row is machine-checked only; device or above owes an element.
import { fileURLToPath } from "node:url";
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { chartDeclarations, declarations, handlersOwed, KINDS, reachOf } from "./objects.ts";

const program = {
  state: {
    entities: {
      Tick: { ir: "Tick", table: "tick", durability: "tab", validations: { "no-skip": { ir: "no-skip" } } },
      Game: { ir: "Game", table: "game", durability: "device", validations: {} },
      Goal: { ir: "Goal", table: "goal", durability: "live", validations: { "own-goal": { ir: "own-goal" } } },
    },
    pipelines: {},
    machines: { PaymentMachine: { ir: "PaymentMachine" } },
    effects: { charge: { ir: "charge" } },
  },
  surface: {
    screens: { board: { ir: "board", states: ["loading", "empty"] } },
    flows: {},
    handlers: { metronome: { ir: "metronome", src: "shell/handlers/bump.js" }, resume: { ir: "resume", src: "shell/handlers/resume.js" }, submit: { ir: "submit", src: "shell/handlers/submit.js" } },
  },
  meta: { tests: {}, decisions: {} },
  capabilities: { hatches: {}, vendored: {} },
};

Deno.test("machine and effect are compared kinds, read off state.machines and state.effects", () => {
  assertEquals(KINDS.includes("machine" as never), true);
  assertEquals(KINDS.includes("effect" as never), true);
  const decls = declarations(program);
  assertEquals(decls.find((d) => d.kind === "machine")?.id, "PaymentMachine");
  assertEquals(decls.find((d) => d.kind === "effect")?.id, "charge");
});

Deno.test("a tab entity and its validations are claimed but not owed; device or above are owed", () => {
  const owed = Object.fromEntries(declarations(program).filter((d) => d.kind === "entity" || d.kind === "validation").map((d) => [d.id, d.owed]));
  assertEquals(owed, { Tick: false, "no-skip": false, Game: true, Goal: true, "own-goal": true });
});

Deno.test("a raw pipeline owes a hatch element instead of a platform pipeline claim", () => {
  const p = { ...program, state: { ...program.state, pipelines: {
    raw: { ir: "authored", raw: true },
    derived: { ir: "projection" },
  } } };
  assertEquals(declarations(p).filter((d) => d.where.startsWith("pipelines.")), [
    { kind: "hatch", id: "authored", where: "pipelines.raw", owed: true },
    { kind: "pipeline", id: "projection", where: "pipelines.derived", owed: true },
  ]);
});

Deno.test("reach is the farthest durability a write lands on", () => {
  assertEquals(reachOf([]), "tab");
  assertEquals(reachOf(["tab", "device"]), "device");
  assertEquals(reachOf(["live", "tab", "server"]), "server");
});

Deno.test("a chart is a machine claimed as <entity ir>-<field>, once however many screens carry it, owed by reach", () => {
  const charts = [
    { screen: "board", table: "tick", field: "beat", writes: ["tick"], refs: ["bump"] },
    { screen: "board", table: "game", field: "mode", writes: ["game"], refs: [] },
    { screen: "shelf", table: "game", field: "mode", writes: ["game"], refs: [] },
    // A tab row whose chart writes a live one reaches live.
    { screen: "board", table: "tick", field: "sync", writes: ["goal"], refs: ["submit"] },
  ].map((chart) => ({ ...chart, machine: JSON.stringify({ field: chart.field, initial: "idle", states: { idle: {} } }) }));
  const decls = chartDeclarations(charts, program.state.entities);
  assertEquals(decls.map((d) => [d.id, d.owed, d.where]), [
    ["Tick-beat", false, "screens.board.tick.beat"],
    ["Game-mode", true, "screens.board.game.mode"],
    ["Tick-sync", true, "screens.board.tick.sync"],
  ]);
  assertThrows(() => chartDeclarations([{ screen: "board", table: "ghost", field: "x", machine: "{}", writes: [], refs: [] }], program.state.entities), Error, "ghost");
});

Deno.test("a handler only a tab-reaching chart names is machine-checked with it; one named by an owed chart, or by no chart, keeps its element", () => {
  const charts = [
    { screen: "board", table: "tick", field: "beat", writes: ["tick"], refs: ["bump"] },
    { screen: "board", table: "tick", field: "sync", writes: ["goal"], refs: ["submit"] },
  ];
  const stemToIr = new Map([["bump", "metronome"], ["resume", "resume"], ["submit", "submit"]]);
  const owed = Object.fromEntries(handlersOwed(declarations(program), charts, program.state.entities, stemToIr).filter((d) => d.kind === "handler").map((d) => [d.id, d.owed]));
  assertEquals(owed, { metronome: false, resume: true, submit: true });
});

Deno.test("pronto's durability-to-level table is the terminal's", async () => {
  const run = async (cwd: string, args: string[]) => {
    const out = await new Deno.Command("cue", { args, cwd, stdout: "piped", stderr: "piped" }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    return JSON.parse(new TextDecoder().decode(out.stdout));
  };
  const here = fileURLToPath(new URL(".", import.meta.url));
  const ours = await run(here, ["export", ".:pronto", "-e", "#DurabilityEffectLevel", "--out", "json"]);
  const theirs = await run(fileURLToPath(new URL("../omnishell", import.meta.url)), ["export", ".:terminal", "-e", "#Machine.#DurabilityEffectLevel", "--out", "json"]);
  assertEquals(ours, theirs);
});

Deno.test("distinct charts of one field keep separate IR claims and their own reach", () => {
  const base = { table: "tick", field: "beat", writes: ["tick"], refs: [] };
  const idle = { field: "beat", initial: "idle", states: { idle: {} } };
  const charts = [
    { ...base, screen: "board", machine: JSON.stringify(idle) },
    { ...base, screen: "shelf", machine: JSON.stringify({ states: idle.states, initial: idle.initial, field: idle.field }) },
    { ...base, screen: "board", writes: ["goal"], machine: JSON.stringify({ ...idle, states: { idle: { on: { tick: "idle" } } } }) },
  ];
  assertEquals(chartDeclarations(charts, program.state.entities).map(({ id, owed }) => ({ id, owed })), [
    { id: "Tick-beat-1", owed: false },
    { id: "Tick-beat-2", owed: true },
  ]);
});

Deno.test("a lifecycle machine confined to a tab is claimed but does not owe an IR element", () => {
  const p = { ...program, state: { ...program.state, machines: {
    LocalRules: { ir: "LocalRules", level: "ephemeral" },
    SavedRules: { ir: "SavedRules", level: "local" },
    SharedRules: { ir: "SharedRules", level: "replicated" },
  } } };
  assertEquals(declarations(p).filter(d => d.kind === "machine").map(d => [d.id, d.owed]), [
    ["LocalRules", false], ["SavedRules", true], ["SharedRules", true],
  ]);
});
