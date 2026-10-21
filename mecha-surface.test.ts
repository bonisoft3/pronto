import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.11";
import { fixture } from "./testdata/hybrid-fixtures.ts";
import type { MechaReducerMachine } from "./mecha-reducer.ts";
import { misfit, partsOf, surfaceOf, type SurfaceEntity } from "./mecha-surface.ts";
import { machineFindings } from "./check-hybrids.ts";
import { run } from "./testdata/hybrid-fixtures.ts";

const owned = { durability: "live", access: { scope: "private", owner: "actor" } };
const seat = (name: string, extra: SurfaceEntity["fields"] = []): SurfaceEntity => ({
  ...owned, table: `${name}_seat`, fields: [
    { name: "id", type: "text", pk: true }, { name: "instance_id", type: "uuid" }, { name: "actor", type: "uuid" }, { name: "seat", type: "text" },
    { name: "revision", type: "bigint" }, { name: "phase", type: "text" }, { name: "view", type: "json" }, ...extra,
  ],
});
const command = (name: string): SurfaceEntity => ({
  ...owned, table: `${name}_command`, fields: [
    { name: "id", type: "text", pk: true }, { name: "instance_id", type: "uuid" }, { name: "actor", type: "uuid" }, { name: "request", type: "json" },
    { name: "outcome", type: "text" }, { name: "reason", type: "text" }, { name: "revision", type: "bigint" },
  ],
});

Deno.test("a machine's surface is the entities its parts need, each held to the protocol", async () => {
  const { spec } = await fixture();
  const machine: MechaReducerMachine = { ...spec, initialize: { reduce: "initial", input: { type: "object", fields: {} } } };
  assertEquals(partsOf(machine), ["seat", "command"]);
  // A seat's extra column is the view's field of that name, filled by the machine.
  assertEquals(surfaceOf(machine, { S: seat(spec.name, [{ name: "turn", type: "text" }]), C: command(spec.name) }), { seat: ["turn"], public: [] });
  assertThrows(() => surfaceOf(machine, { S: seat(spec.name) }), Error, "command surface needs an entity");
  assertThrows(() => surfaceOf(machine, { S: seat(spec.name, [{ name: "invented", type: "text" }]), C: command(spec.name) }), Error, "neither the protocol's nor a field of the view");
  assertThrows(() => surfaceOf(machine, { S: { ...seat(spec.name), durability: "server" }, C: command(spec.name) }), Error, "live");
  assertThrows(() => surfaceOf(machine, { S: { ...seat(spec.name), access: { scope: "public" } }, C: command(spec.name) }), Error, "private owned by actor");
  // A view is the machine's value, held as json under the shape's cel; text would hand a handler a string to parse.
  const asText = seat(spec.name).fields.map((f) => f.name === "view" ? { ...f, type: "text" } : f);
  assertThrows(() => surfaceOf(machine, { S: { ...seat(spec.name), fields: asText }, C: command(spec.name) }), Error, "the protocol's is json");
});

// A value its column refused aborted the step that projected it, for every
// reader, whatever the rules computed. Every value a view's shape admits must
// fit the column it fills, and a constraint no reading can prove is a finding.
Deno.test("every value a projection admits fits the column it fills", () => {
  const col = (type: string, cel?: string) => ({ name: "c", type, ...(cel ? { cel } : {}) });
  const text = (maxLength: number, values?: string[]) => ({ type: "string" as const, maxLength, ...(values ? { values } : {}) });
  const int = (min: number, max: number) => ({ type: "integer" as const, min, max });
  assertEquals(misfit(col("text", "this.size() <= 10"), text(10)), null);
  assertStringIncludes(misfit(col("text", "this.size() <= 10"), text(11)) ?? "fits", "lengths 0..10, and the value's reach 0..11");
  // A set states the lengths its members have.
  assertEquals(misfit(col("text", "this.size() <= 6"), text(64, ["1v1", "2v2v2"])), null);
  assertEquals(misfit(col("text", "this in ['', 'accepted', 'rejected']"), text(8, ["", "accepted"])), null);
  assertStringIncludes(misfit(col("text", "this in ['', 'accepted']"), text(8, ["", "accepted", "refused"])) ?? "fits", "may be refused");
  assertStringIncludes(misfit(col("text", "this in ['a']"), text(1)) ?? "fits", "any string");
  assertEquals(misfit(col("int", "this >= 0 && this <= 30"), int(0, 30)), null);
  assertStringIncludes(misfit(col("int", "this >= 0 && this <= 30"), int(0, 31)) ?? "fits", "0..30, and the value reaches 0..31");
  assertStringIncludes(misfit(col("int"), int(0, 2 ** 40)) ?? "fits", "is int");
  assertStringIncludes(misfit(col("text"), int(0, 1)) ?? "fits", "an integer");
  assertStringIncludes(misfit(col("text", "this.size() <= 64"), { type: "array", maxItems: 3, items: int(0, 1) }) ?? "fits", "JSON text no shape bounds");
  assertStringIncludes(misfit(col("text", "this.trim().size() > 0"), text(8)) ?? "fits", "no value can be shown to fit");
  assertEquals(misfit(col("text", "this.matches('^[a-c]$')"), text(1, ["a", "b"])), null);
  assertStringIncludes(misfit(col("text", "this.matches('^[a-c]$')"), text(1, ["a", "d"])) ?? "fits", "may be d");
});

Deno.test("Truco's surfaces fit the projections that fill them", async () => {
  const exported = await run("cue", ["export", "./apps/truco", "-e", "code.state", "--out", "json"]);
  if (!exported.ok) throw new Error(exported.err);
  const state = JSON.parse(exported.out) as { hybrids: Record<string, { reducer: MechaReducerMachine }>; entities: Record<string, SurfaceEntity> };
  const checked = Object.values(state.entities).flatMap((e) => e.fields).filter((f) => (f as { cel?: string }).cel !== undefined);
  assertEquals(checked.length > 0, true, "the entities reach the check with their constraints");
  const hybrids = Object.fromEntries(Object.entries(state.hybrids).map(([n, h]) => [n, h.reducer]));
  assertEquals(machineFindings(hybrids, state.entities), []);
  // One variant name longer than its column, and the match is a finding.
  const seat = Object.values(state.entities).find((e) => e.table === "truco_match_seat")!;
  (seat.fields.find((f) => f.name === "variant") as { cel?: string }).cel = "this.size() <= 8";
  assertEquals(machineFindings(hybrids, state.entities), [{ severity: "error", path: "program.cue",
    message: "truco_match: truco_match_seat.variant admits lengths 0..8, and the value's reach 4..10" }]);
});
