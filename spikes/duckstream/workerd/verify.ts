const origin = Deno.args[0];
if (!origin) {
  throw Error(
    "Usage: deno run -A verify.ts http://localhost:18881 [report.json]",
  );
}
function expected(count: number, edited: boolean) {
  const groups = new Map<
    string,
    {
      site_name: string;
      pageviews: number;
      visitors: Set<number>;
      bounces: number;
    }
  >();
  function add(site: number, visitor: number, bounce: number) {
    const key = `site-${site}`;
    const group = groups.get(key) ||
      { site_name: key, pageviews: 0, visitors: new Set<number>(), bounces: 0 };
    group.pageviews++;
    group.visitors.add(visitor);
    group.bounces += bounce;
    groups.set(key, group);
  }
  for (let i = 0; i < count; i++) {
    if (edited && i === 1) continue;
    add(edited && i === 0 ? 1 : i % 100, i % 25000, Number(i % 17 === 0));
  }
  if (edited) add(2, -1, 0);
  return [...groups.values()].sort((a, b) =>
    a.site_name < b.site_name ? -1 : a.site_name > b.site_name ? 1 : 0
  )
    .map((row) => ({ ...row, visitors: row.visitors.size }));
}
const report = [];
let previous = 0;
for (const count of [1200, 100000, 1000000, 1200]) {
  const start = performance.now();
  const response = await fetch(`${origin}?rows=${count}`);
  if (!response.ok) throw Error(await response.text());
  const result = await response.json();
  const requestMs = Math.round(performance.now() - start);
  for (
    const [key, value] of Object.entries({
      count,
      scalar: [{ answer: 42, utc: "2026-01-01 15:00:00+00" }],
      aggregate: expected(count, false),
      updated: expected(count, true),
    })
  ) {
    if (JSON.stringify(result[key]) !== JSON.stringify(value)) {
      throw Error(`Mismatch ${key} for ${count}`);
    }
  }
  if (result.runs <= previous) throw Error("Durable counter did not advance");
  previous = result.runs;
  report.push({
    count,
    memory: result.memory,
    requestMs,
    runs: result.runs,
    groups: 100,
    exactRowsVerified: true,
  });
}
const invalid = await fetch(`${origin}?rows=2`);
if (invalid.status !== 400) throw Error("Unbounded fixture accepted");
const text = JSON.stringify(
  { runtime: origin, results: report, invalidFixtureRejected: true },
  null,
  2,
) + "\n";
if (Deno.args[1]) await Deno.writeTextFile(Deno.args[1], text);
console.log(text);
