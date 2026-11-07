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

Deno.test("a bridge on docker needs its appliance form, and one on a target that lowers none is refused", async () => {
  const bare = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["docker"]}'));
  assert(!bare.success, "a bridge on docker without an appliance form was accepted");
  assertStringIncludes(bare.stderr, "appliance");
  const k8s = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["k8s"]}'));
  assert(!k8s.success, "a bridge on k8s, whose release runs no airlock, was accepted");
  assertStringIncludes(k8s.stderr, "bridges.fetch.targets");
  const held = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch"]}}'));
  assert(!held.success, "a bridge served on the appliance door's port 8080 was accepted");
  assertStringIncludes(held.stderr, "appliance port is one the docker appliance");
  const docker = await emitFiles(program('{container: "transport", targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8090"], port: 8090}}')) as unknown as Record<string, Manifest>;
  assertEquals(docker["services/airlock/effects.json"].data.effects.charge.bridge, { name: "fetch", targets: ["docker"], simulated: false });
});

