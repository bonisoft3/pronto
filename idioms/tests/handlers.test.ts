// A handler file is one arrow expression, not a module: evaluating its text
// yields the function, the way the terminal's compartment does.
type Update = { op: string; entity?: string; id: string; row?: Record<string, unknown> };
type Reply = { updates: Update[]; then?: { type: string; seed?: boolean } };
type Handler = (state: { items?: unknown[]; rows?: Record<string, unknown[]> }, event: Record<string, unknown>) => Reply;

const load = async (name: string): Promise<Handler> =>
  (0, eval)(await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`, import.meta.url)));

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const plus = Array.from({ length: 25 }, (_, i) => {
  const r = Math.floor(i / 5), c = i % 5;
  return { id: `r${r}c${c}`, on: r === 2 || c === 2 ? "yes" : "no" };
});

Deno.test("count tells its buttons apart by element id", async () => {
  const count = await load("count");
  const state = { items: [{ id: "counter", n: 4 }] };
  assertEquals(count(state, { type: "click", id: "counter", from: "inc" }).updates, [{ op: "patch", id: "counter", row: { n: 5 } }]);
  assertEquals(count(state, { type: "click", id: "counter", from: "dec" }).updates, [{ op: "patch", id: "counter", row: { n: 3 } }]);
});

// A write past the CEL bound is refused where no region hears it, so the button
// would look dead; the handler states nothing instead.
Deno.test("count stops at its bound rather than writing a refused row", async () => {
  const count = await load("count");
  assertEquals(count({ items: [{ id: "counter", n: 99 }] }, { type: "click", id: "counter", from: "inc" }).updates, []);
  assertEquals(count({ items: [{ id: "counter", n: -99 }] }, { type: "click", id: "counter", from: "dec" }).updates, []);
});

Deno.test("press on the centre of the plus flips five lights and counts one move", async () => {
  const press = await load("press");
  const { updates } = press({ rows: { light: plus, board: [{ id: "board", moves: 0, lit: 9 }] } }, { type: "click", id: "r2c2", from: "" });
  assertEquals(updates.filter((u) => u.entity === "light").map((u) => u.id).sort(), ["r1c2", "r2c1", "r2c2", "r2c3", "r3c2"]);
  assertEquals(updates.at(-1), { op: "patch", entity: "board", id: "board", row: { moves: 1 } });
});

// A fold that restated an unchanged count would wake itself forever.
Deno.test("tally writes the lit count only when it changed", async () => {
  const tally = await load("tally");
  assertEquals(tally({ rows: { light: plus, board: [{ id: "board", moves: 0, lit: 9 }] } }, { type: "mutation" }).updates, []);
  assertEquals(tally({ rows: { light: plus, board: [{ id: "board", moves: 1, lit: 5 }] } }, { type: "mutation" }).updates, [
    { op: "patch", entity: "board", id: "board", row: { lit: 9 } },
  ]);
});

Deno.test("roll asks for a draw, then turns the same draw into the same face", async () => {
  const roll = await load("roll");
  const state = { items: [{ id: "clock", n: 0, run: "paused", face: 1 }] };
  assertEquals(roll(state, { type: "click", id: "clock", from: "roll" }).then, { type: "drawn", seed: true });
  assertEquals(roll(state, { type: "drawn", seed: 3_000_000_005 }).updates, [{ op: "patch", id: "clock", row: { face: 6 } }]);
});
