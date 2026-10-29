// omnishell at the tag pronto's CUE module requires, so this module loads by
// URL (docs/component-contracts.md#platform-pins).
import { evaluateCaged } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.21.4/interpreter/jessie.js";
import { METER } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.21.4/instrument.ts";

type Runner = {
  reset: (limit: number) => void;
  run: (json: string) => string;
};
const runners = new Map<string, Promise<Runner>>();

// Each command starts with a fresh rules closure and budget, just like PLV8,
// while reusing the compartment and hardened spec across invocations.
export async function executeHybrid(source: string, fuel: number, input: unknown): Promise<unknown> {
  let cached = runners.get(source);
  if (!cached) {
    let spent = 0;
    let limit = fuel;
    const reset = (n: number) => {
      spent = 0;
      limit = n;
    };
    const reusable = source
      .replace("\n    const rules = ", "\n    return json => {\n    const rules = ")
      .replace("\n    return json => {\n      const answer = ", "\n      const answer = ");
    cached = evaluateCaged(reusable, {
      [METER]: () => {
        spent++;
        if (spent > limit) throw new RangeError(`Jessie fuel limit exceeded (${limit} steps)`);
      },
    }).then((run) => ({ reset, run: run as (json: string) => string }));
    runners.set(source, cached);
  }
  const runner = await cached;
  runner.reset(fuel);
  return JSON.parse(runner.run(JSON.stringify(input)));
}
