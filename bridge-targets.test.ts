import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const BUILT = '{activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}';
const program = (bridge: string, transport = BUILT) =>
  paymentProgram().replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {bridge: "fetch", idempotent: false}\n      reentry: "repeat"',
  ) +
  `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: ${bridge}\n` +
  `_cluster: surface: targets: transport: ${transport}\n`;

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


// Cloudflare ships the image the publish builds from the container's
// Dockerfile, so the bridge needs no appliance form and a container that only
// pulls an image has nothing to ship.
Deno.test("a bridge on cloudflare needs a built container and no appliance form", async () => {
  const cloudflare = await emitFiles(program('{container: "transport", targets: ["cloudflare"]}')) as unknown as Record<string, Manifest>;
  assertEquals(cloudflare["services/airlock/effects.json"].data.effects.charge.bridge, { name: "fetch", targets: ["cloudflare"], simulated: false });
  const both = await emitFiles(program('{container: "transport", targets: ["docker", "cloudflare"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8090"], port: 8090}}')) as unknown as Record<string, Manifest>;
  assertEquals(both["services/airlock/effects.json"].data.effects.charge.bridge, { name: "fetch", targets: ["docker", "cloudflare"], simulated: false });
  const pulled = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["cloudflare"]}', '{activate: "", dockerfile: {from: null}, compose: image: "ghcr.io/example/transport:1"}'));
  assert(!pulled.success, "a bridge on cloudflare whose container pulls its image was accepted");
  assertStringIncludes(pulled.stderr, "builds no image from a Dockerfile");
});

// The mail action's cloudflare lowering is Email Routing, so the container a
// `cloudflare` target would ship is one nothing calls, built from a compose
// alias `docker build` cannot resolve.
Deno.test("an Activepieces bridge cannot name cloudflare", async () => {
  const activepieces = `
app: capabilities: hatches: smtp: {
  kind: "container", note: "trusted integration"
  activepieces: {
    lock: "./pieces/integrations.lock"
    pieces: mail: {local: "./pieces/mail", export: "mail"}
    actions: sendMail: {
      piece: "mail", action: "send-mail"
      inputSchema: "./pieces/mail/send.input.schema.json"
      outputSchema: "./pieces/mail/send.output.schema.json"
      fixedProps: {host: "smtp.example.test"}
      idempotencyKeyProp: "requestKey"
    }
  }
}
`;
  const mail = (bridge: string) =>
    paymentProgram().replace(
      'sink: {origin: "https://api.acquirer.example", idempotent: true}',
      'sink: {bridge: "mail", idempotent: false}\n      reentry: "unknown"',
    ) + `\napp: state: bridges: mail: ${bridge}\n` + activepieces;
  const docker = await cue(["export", "-", "-e", "out"], mail('{container: "smtp", action: "sendMail", targets: ["docker"], appliance: {srcs: ["/app"], command: ["node", "/app/main.js"], port: 8090}}'));
  assert(docker.success, docker.stderr);
  const cloudflare = await cue(["export", "-", "-e", "out"], mail('{container: "smtp", action: "sendMail", targets: ["cloudflare"]}'));
  assert(!cloudflare.success, "an Activepieces bridge on cloudflare was accepted");
  assertStringIncludes(cloudflare.stderr, "names cloudflare, where its Activepieces action runs without a container");
});

// A secret named as a bridge's binding would be the dispatcher's one name
// twice over: a Durable Object namespace and a string.
Deno.test("an effect's secret cannot take a bridge's name", async () => {
  const bridged = await cue(["export", "-", "-e", "out"], program('{container: "transport"}').replace('reentry: "repeat"', 'reentry: "repeat"\n      secrets: ["BRIDGE_FETCH"]'));
  assert(!bridged.success, "a secret named as the bridge's binding was accepted");
  assertStringIncludes(bridged.stderr, "BRIDGE_");
  const credential = (secret: string) => cue(["export", "-", "-e", "out"], paymentProgram({ effect: `sink: credential: {secret: "${secret}"}` }));
  assert((await credential("ACQUIRER_KEY")).success);
  assert(!(await credential("BRIDGE_FETCH_URL")).success, "a credential named as a bridge's mesh address was accepted");
});

// An app released on cloudflare may reach a bridge: one naming cloudflare runs
// there as a container, and one that does not settles its effects failed at
// run time as not deployed (container-bridges.md#Targets), so neither is a
// compile error.
Deno.test("an app on cloudflare compiles with a bridge whether or not the bridge runs there", async () => {
  const onCloudflare = (bridge: string) => program(bridge).replace("targets: []", 'targets: ["cloudflare"]').replace("clocks: []", 'clocks: ["cloudflare"]');
  const runs = await cue(["export", "-", "-e", "out"], onCloudflare('{container: "transport", targets: ["cloudflare"]}'));
  assert(runs.success, runs.stderr);
  const settles = await cue(["export", "-", "-e", "out"], onCloudflare('{container: "transport", targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8090"], port: 8090}}'));
  assert(settles.success, settles.stderr);
});
