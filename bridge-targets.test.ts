import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const program = (bridge: string) =>
  paymentProgram().replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {bridge: "fetch", idempotent: false}\n      reentry: "repeat"',
  ) +
  `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: ${bridge}\n` +
  `_cluster: surface: targets: transport: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}\n`;

type Manifest = { data: { effects: Record<string, { bridge?: unknown }> } };

Deno.test("an effect through a bridge tells the airlock where the bridge runs: its simulator locally, no release yet", async () => {
  const bare = await emitFiles(program('{container: "transport"}')) as unknown as Record<string, Manifest>;
  assertEquals(bare["services/airlock/effects.json"].data.effects.charge.bridge, { name: "fetch", targets: [], simulated: false });
  const simulated = await emitFiles(program('{container: "transport", simulator: dockerfile: from: name: "alpine:3.22"}')) as unknown as Record<string, Manifest>;
  assertEquals(simulated["services/airlock/effects.json"].data.effects.charge.bridge, { name: "fetch", targets: [], simulated: true });
});

Deno.test("a bridge naming a release target that does not lower it is refused, not left to fail every call", async () => {
  const result = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["docker"]}'));
  assert(!result.success, "a bridge on docker, whose appliance runs no airlock, was accepted");
  assertStringIncludes(result.stderr, "bridges.fetch.targets");
});
