import { strict as assert } from "node:assert";

type Route = { model: string; effort: string };
type Options = Route & { label: string };

const routes = {
  review: { model: "review-model", effort: "medium" },
  risk: { model: "risk-model", effort: "high" },
};

async function run(args: unknown, calls: Options[]) {
  const source = await Deno.readTextFile(
    new URL("workflows/studio-review.js", import.meta.url),
  );
  const execute = new Function(
    "args",
    "agent",
    "pipeline",
    "parallel",
    "log",
    "phase",
    `return (async () => { ${
      source.replace("export const meta", "const meta")
    } })()`,
  );
  return await execute(
    args,
    (_prompt: string, options: Options) => {
      calls.push(options);
      if (options.label.startsWith("verify:")) {
        return Promise.resolve({ refuted: false, why: "confirmed" });
      }
      return Promise.resolve({
        outcome: "reviewed",
        reason: "looked",
        findings: [{
          id: "one",
          severity: "blocking",
          required_property: "invariant",
          evidence: "code",
        }],
      });
    },
    (
      items: string[],
      first: (seat: string) => unknown,
      second: (review: unknown, seat: string) => unknown,
    ) =>
      Promise.all(items.map(async (seat) => second(await first(seat), seat))),
    (tasks: (() => unknown)[]) => Promise.all(tasks.map((task) => task())),
    () => {},
    () => {},
  );
}

Deno.test("studio routes every seat and verifier without inheriting the lead", async () => {
  const calls: Options[] = [];
  const result = await run(
    { context: "changed files", ir: "ir.html", team: "studio", routes },
    calls,
  );
  assert.equal(calls.length, 8);
  assert.equal(result.confirmed.length, 4);
  for (const call of calls) {
    const expected = call.label.includes(":architect")
      ? routes.risk
      : routes.review;
    assert.deepEqual(
      { model: call.model, effort: call.effort },
      expected,
      call.label,
    );
  }
});

Deno.test("studio runs a single rung seat when args.seat is supplied", async () => {
  const calls: Options[] = [];
  const result = await run(
    {
      context: "spec files",
      ir: "ir.html",
      team: "arcade",
      seat: "product",
      routes: { review: routes.review },
    },
    calls,
  );
  assert.equal(calls.length, 2);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0].seat, "product");
  for (const call of calls) {
    assert.deepEqual(
      { model: call.model, effort: call.effort },
      routes.review,
      call.label,
    );
  }
});

Deno.test("studio rejects incomplete routing before paying for any seat", async () => {
  for (
    const incomplete of [undefined, {}, { ...routes, risk: {} }, {
      ...routes,
      review: { model: "" },
    }]
  ) {
    const calls: Options[] = [];
    await assert.rejects(
      run({ context: "diff", ir: "ir.html", routes: incomplete }, calls),
      /routes/,
    );
    assert.equal(calls.length, 0);
  }
});
