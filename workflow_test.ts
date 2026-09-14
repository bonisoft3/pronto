import { strict as assert } from "node:assert";

type Route = { model: string; effort: string };
type Options = Route & { label: string };

const routes = {
  review: { model: "review-model", effort: "medium" },
  risk: { model: "risk-model", effort: "high" },
  advisor: { model: "advisor-model", effort: "high" },
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
      if (options.label === "advisor") return Promise.resolve("advice");
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

Deno.test("studio routes every seat, verifier, and advisor without inheriting the lead", async () => {
  const calls: Options[] = [];
  const result = await run(
    { context: "changed files", ir: "ir.html", routes },
    calls,
  );
  assert.equal(calls.length, 11);
  assert.equal(result.confirmed.length, 5);
  for (const call of calls) {
    const expected = call.label === "advisor"
      ? routes.advisor
      : call.label.includes(":backend")
      ? routes.risk
      : routes.review;
    assert.deepEqual(
      { model: call.model, effort: call.effort },
      expected,
      call.label,
    );
  }
});

Deno.test("studio rejects incomplete routing before paying for any seat", async () => {
  for (
    const incomplete of [undefined, {}, { ...routes, risk: {} }, {
      ...routes,
      advisor: { model: "" },
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
