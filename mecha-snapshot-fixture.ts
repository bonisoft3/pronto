// The compute batch machine as mecha's snapshot coordinator runs it:
// compute/machine.ts and its rules through the Cortex durable compiler,
// stepped as mecha-local.ts steps a command.
import { compileCortexDurable } from "./cortex-durable.ts";
import { terminal } from "./mecha-fixtures.ts";
import { executeMecha } from "../omnishell/test/mecha-local.ts";
import { batchMachine } from "./compute/machine.ts";
import type { BatchMachine } from "../../libraries/mecha/packages/compute-snapshot/src/index.ts";

const compiled = await compileCortexDurable(batchMachine, await Deno.readTextFile(new URL("compute/rules.js", import.meta.url)), terminal);

export const machine: BatchMachine = {
  execute: (input) => executeMecha(compiled.source, batchMachine.machine.fuel, input) as ReturnType<BatchMachine["execute"]>,
};
