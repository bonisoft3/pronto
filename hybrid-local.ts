import { evaluateCaged } from "../omnishell/interpreter/jessie.js";
import { fuelMeter } from "../omnishell/instrument.ts";

// Each command starts with a fresh compartment and budget, just like PLV8.
// Retaining the rule functions would retain arbitrary module closure state.
export async function executeHybrid(source: string, fuel: number, input: unknown): Promise<unknown> {
  const meter = fuelMeter(fuel);
  const execute = await evaluateCaged(source, meter.endowments);
  return JSON.parse(execute(JSON.stringify(input)));
}
