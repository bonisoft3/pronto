import { dedupReads, dedupWrites } from "./derive.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

Deno.test("dedupReads deduplicates identical reads and remaps enclosing lists indices", () => {
  const reads = [
    // 0: enclosing outer live read
    { table: "ui", kind: "live" as const, nested: false, lists: [], route: "view" as const, clauses: [{ col: "id", op: "eq" }], embeds: [], orders: [] },
    // 1: duplicate sibling reads under outer
    { table: "company", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "company", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    // 3: second enclosing live read (index shifts from 3 -> 2)
    { table: "advance_payment", kind: "live" as const, nested: false, lists: [], route: "view" as const, clauses: [], embeds: [], orders: ["pos"] },
    // 4: nested read pointing to index 3, followed by identical duplicate also pointing to 3
    { table: "tag", kind: "reads" as const, nested: true, lists: [3], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "tag", kind: "reads" as const, nested: true, lists: [3], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    // 6: same table/nested/route as index 4, but distinct enclosing list [0] — must be preserved
    { table: "tag", kind: "reads" as const, nested: true, lists: [0], route: "whole" as const, clauses: [], embeds: [], orders: [] },
  ];

  const deduped = dedupReads(reads);
  assert(deduped.length === 5, `expected 5 reads, got ${deduped.length}`);
  assert(deduped[0].table === "ui", "index 0 preserved");
  assert(deduped[1].table === "company", "first company kept at index 1");
  assert(deduped[2].table === "advance_payment", "advance_payment shifted to index 2");
  assert(deduped[3].table === "tag" && JSON.stringify(deduped[3].lists) === "[2]", `expected lists [2], got ${JSON.stringify(deduped[3].lists)}`);
  assert(deduped[4].table === "tag" && JSON.stringify(deduped[4].lists) === "[0]", `distinct lists [0] preserved, got ${JSON.stringify(deduped[4].lists)}`);
});

Deno.test("dedupReads remaps forward lists references and cascading duplicate parents", () => {
  const reads = [
    // 0 & 1: duplicate outer company reads
    { table: "company", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "company", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    // 2: child read placed before its named enclosing list template (forward index 4)
    { table: "tag", kind: "reads" as const, nested: true, lists: [4], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    // 3: first named list template under company[0]
    { table: "player", kind: "live" as const, nested: true, lists: [0], route: "view" as const, clauses: [], embeds: [], orders: [] },
    // 4: duplicate named list template under duplicate company[1] — collapses into 3 after pass 1 remaps [1] -> [0]
    { table: "player", kind: "live" as const, nested: true, lists: [1], route: "view" as const, clauses: [], embeds: [], orders: [] },
  ];

  const deduped = dedupReads(reads);
  assert(deduped.length === 3, `expected 3 reads, got ${deduped.length}`);
  assert(deduped[0].table === "company", "index 0 preserved");
  assert(deduped[1].table === "tag" && JSON.stringify(deduped[1].lists) === "[2]", `expected forward lists [2], got ${JSON.stringify(deduped[1].lists)}`);
  assert(deduped[2].table === "player" && JSON.stringify(deduped[2].lists) === "[0]", `expected player lists [0], got ${JSON.stringify(deduped[2].lists)}`);
});

Deno.test("dedupReads sorts remapped lists and merges order-equivalent reads", () => {
  const reads = [
    { table: "a", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "a", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "b", kind: "reads" as const, nested: false, lists: [], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    // lists: [2, 1] remaps to [1, 0] -> sorted to [0, 1], merging with index 4
    { table: "tag", kind: "reads" as const, nested: true, lists: [2, 1], route: "whole" as const, clauses: [], embeds: [], orders: [] },
    { table: "tag", kind: "reads" as const, nested: true, lists: [0, 2], route: "whole" as const, clauses: [], embeds: [], orders: [] },
  ];

  const deduped = dedupReads(reads);
  assert(deduped.length === 3, `expected 3 reads, got ${deduped.length}`);
  assert(deduped[2].table === "tag" && JSON.stringify(deduped[2].lists) === "[0,1]", `expected sorted lists [0,1], got ${JSON.stringify(deduped[2].lists)}`);
});

Deno.test("dedupReads throws on out-of-range lists index", () => {
  const reads = [
    { table: "tag", kind: "reads" as const, nested: true, lists: [5], route: "whole" as const, clauses: [], embeds: [], orders: [] },
  ];
  let threw = false;
  try {
    dedupReads(reads);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("read index 5 out of 1");
  }
  assert(threw, "expected dedupReads to throw on out-of-range lists index");
});

Deno.test("dedupWrites deduplicates exact duplicates while preserving order", () => {
  const writes = [
    { table: "ui", op: "update", filter: "id=eq.home" },
    { table: "ui", op: "update", filter: "id=eq.home" },
    { table: "draft", op: "insert" },
    { table: "ui", op: "update", filter: "id=eq.other" },
  ];
  const deduped = dedupWrites(writes);
  assert(deduped.length === 3, `expected 3 writes, got ${deduped.length}`);
  assert(deduped[0].table === "ui" && deduped[0].filter === "id=eq.home", "first write preserved");
  assert(deduped[1].table === "draft", "second distinct write preserved");
  assert(deduped[2].filter === "id=eq.other", "third distinct write preserved");
});
