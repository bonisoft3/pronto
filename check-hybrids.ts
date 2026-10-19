// pronto's `hybrids` lint: what the Mecha machines an app declares in
// `state.hybrids` can do, proved over their declarations.
//
//   deno run --allow-read check-hybrids.ts <appDir>
//
// Generation refuses a machine the runtime could not run as declared: a rule
// without a contract, a write the context cannot hold. What is left are
// properties of a machine that runs — a rule reading what the event reaching it
// does not carry, a state nothing moves on from, a projected value its column
// refuses — and each is a finding here, all of them at once, rather than a
// generation that stops at the first. They are functions of the machine and
// the surface declared beside it, and know no app.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any error is reported.

import { readCheckInputs } from "./check-inputs.ts";
import { carries, moving } from "./mecha-contracts.ts";
import type { MechaReducerMachine } from "./mecha-reducer.ts";
import { fitting, type SurfaceEntity } from "./mecha-surface.ts";

type Finding = { severity: "error" | "advisory"; path: string; message: string };

export function machineFindings(hybrids: Record<string, MechaReducerMachine>, entities: Record<string, SurfaceEntity>): Finding[] {
  return Object.values(hybrids).flatMap((m) =>
    [...carries(m), ...moving(m), ...fitting(m, entities)].map((message) => ({
      severity: "error" as const,
      path: "program.cue",
      message: `${m.name}: ${message}`,
    }))
  );
}

if (import.meta.main) {
  const appDir = Deno.args[0];
  if (appDir === undefined) throw new Error("usage: check-hybrids.ts <appDir>");
  const inputs = await readCheckInputs<SurfaceEntity, unknown, unknown, MechaReducerMachine>(appDir);
  const found = machineFindings(inputs.hybrids, inputs.entities);
  console.log(JSON.stringify(found, null, 2));
  if (found.some((f) => f.severity === "error")) Deno.exit(1);
}
