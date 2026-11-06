// A database function's fixtures: a reshaping of a provider's round, one that
// never finishes, one that throws and one whose answer is not JSON.
export const ROUND = `const score = side => side === undefined ? null : side.current;
(round) => round.events.map(e => ({
  id: e.id,
  home: e.homeTeam.name,
  away: e.awayTeam.name,
  score: [score(e.homeScore), score(e.awayScore)],
}))`;
export const SPIN = `(input) => { while (true) {} }`;
export const THROW = `(input) => { throw new Error("unparsable " + input.kind); }`;
export const LOOSE = `(input) => ({ value: input.n / 0 })`;

export const round = {
  events: [
    { id: 1, homeTeam: { name: "Atalanta" }, awayTeam: { name: "Lazio" }, homeScore: { current: 2 }, awayScore: { current: 1 } },
    { id: 2, homeTeam: { name: "Roma" }, awayTeam: { name: "Inter" } },
  ],
};
export const reshaped = [
  { id: 1, home: "Atalanta", away: "Lazio", score: [2, 1] },
  { id: 2, home: "Roma", away: "Inter", score: [null, null] },
];

/** Writes the fixtures where an app keeps its rules, and answers its directory. */
export async function functionApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pronto-functions-" });
  await Deno.mkdir(`${dir}/rules`);
  for (const [name, source] of Object.entries({ round: ROUND, spin: SPIN, fail: THROW, loose: LOOSE })) {
    await Deno.writeTextFile(`${dir}/rules/${name}.js`, source);
  }
  return dir;
}
export const declared = {
  round: { fuel: 10000, rules: "rules/round.js" },
  spin: { fuel: 10000, rules: "rules/spin.js" },
  fail: { fuel: 10000, rules: "rules/fail.js" },
  loose: { fuel: 10000, rules: "rules/loose.js" },
};
