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
  const gcp = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["gcp"]}'));
  assert(!gcp.success, "a bridge on gcp, whose airlock has no daprd, was accepted");
  assertStringIncludes(gcp.stderr, "bridges.fetch.targets");
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
  const sized = await emitFiles(program('{container: "transport", targets: ["cloudflare"], instance_type: "standard-1"}')) as unknown as Record<string, { data: { bridges?: unknown } }>;
  assertEquals(sized[".pronto/cluster.json"].data.bridges, [{
    name: "fetch",
    container: "transport",
    port: 8080,
    targets: ["cloudflare"],
    instance_type: "standard-1",
    build: "transport-appliance",
  }]);
  const dockerSized = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["docker"], instance_type: "standard-1", appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8090"], port: 8090}}'));
  assert(!dockerSized.success, "a bridge without cloudflare in targets accepted instance_type");
  assertStringIncludes(dockerSized.stderr, "instance_type");
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

// A release tells an effect's secret from the airlock's wiring by name: one
// named as the wiring would be written into a manifest as wiring.
Deno.test("an effect's secret cannot take the airlock's own environment's name", async () => {
  for (const secret of ["BLOB_URL", "PORT", "ORIGIN", "AIRLOCK_TARGET", "AIRLOCK_DIR", "MESH_URL", "DATABASE_URL", "PGPASSWORD", "PGOPTIONS", "AIRLOCK_APP_DIR", "BAYT_LOCAL_WORK_DIR", "SAYT_PLATFORM", "HTTPS_PROXY", "DENO_DIR", "LD_PRELOAD", "PATH", "RCLONE_SECRET_KEY", "REDIS_URL", "OIDC_GOOGLE_CLIENT_ID"]) {
    const wired = await cue(["export", "-", "-e", "out"], program('{container: "transport"}').replace('reentry: "repeat"', `reentry: "repeat"\n      secrets: ["${secret}"]`));
    assert(!wired.success, `a secret named ${secret} was accepted`);
    assertStringIncludes(wired.stderr, `invalid value "${secret}"`);
  }
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

// An effect's sink on cloudflare may be another bridge than its own: the edge
// calls that one, and the effect is called there when that one runs there.
Deno.test("an effect's bridge on cloudflare is its cloudflare sink's", async () => {
  type Emitted = Record<string, { data: { effects?: Record<string, { bridge?: unknown; edgeBridge?: string }> } }>;
  const code = program('{container: "transport"}')
    .replace('sink: {bridge: "fetch", idempotent: false}', 'sink: {bridge: "fetch", idempotent: false, targets: cloudflare: bridge: "remote"}')
    .replace("targets: []", 'targets: ["cloudflare"]').replace("clocks: []", 'clocks: ["cloudflare"]') +
    'app: state: bridges: remote: {container: "relay", targets: ["cloudflare"]}\n' +
    `app: capabilities: hatches: relay: {kind: "container", note: "a relay on the edge"}\n_cluster: surface: targets: relay: ${BUILT}\n`;
  const emitted = await emitFiles(code) as unknown as Emitted;
  const charge = emitted["services/airlock/effects.json"].data.effects!.charge;
  assertEquals(charge.bridge, { name: "fetch", targets: ["cloudflare"], simulated: false });
  assertEquals(charge.edgeBridge, "remote");
  // Its sink on cloudflare a bridge cloudflare does not run, its own an
  // origin: the edge's airlock settles it not deployed, as it would its own.
  const targeted = await emitFiles(
    paymentProgram().replace(
      'sink: {origin: "https://api.acquirer.example", idempotent: true}',
      'sink: {origin: "https://api.acquirer.example", idempotent: false, targets: cloudflare: bridge: "fetch"}\n      reentry: "repeat"',
    ).replace("targets: []", 'targets: ["cloudflare"]').replace("clocks: []", 'clocks: ["cloudflare"]') +
      `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: {container: "transport"}\n_cluster: surface: targets: transport: ${BUILT}\n`,
  ) as unknown as Emitted;
  const only = targeted["services/airlock/effects.json"].data.effects!.charge;
  assertEquals(only.bridge, { name: "fetch", targets: ["docker", "k8s"], simulated: true });
  assertEquals(only.edgeBridge, undefined);
  const { parseManifest, undeployed } = await import(new URL("../../libraries/mecha/services/airlock/reentry.ts", import.meta.url).href) as {
    parseManifest: (text: string) => Record<string, unknown>;
    undeployed: (effect: unknown, target: string) => { data: { reason: string } } | null;
  };
  const declared = parseManifest(JSON.stringify(targeted["services/airlock/effects.json"].data)).charge;
  assertEquals(undeployed(declared, "cloudflare")?.data.reason, "not deployed");
  assertEquals(undeployed(declared, "local"), null);
  // A target of the app's past those a bridge may name counts where its sink
  // there is reachable: gcp's airlock is told its target, and calls it.
  const onGcp = await emitFiles(
    paymentProgram().replace(
      'sink: {origin: "https://api.acquirer.example", idempotent: true}',
      'sink: {origin: "https://api.acquirer.example", idempotent: false, targets: k8s: bridge: "fetch"}\n      reentry: "repeat"',
    ).replace("targets: []", 'targets: ["gcp"]') +
      `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: {container: "transport", targets: ["k8s"]}\n_cluster: surface: targets: transport: ${BUILT}\n`,
  ) as unknown as Emitted;
  assertEquals(onGcp["services/airlock/effects.json"].data.effects!.charge.bridge, { name: "fetch", targets: ["docker", "cloudflare", "k8s", "gcp"], simulated: true });
});

// k8s runs the container's own image as a Deployment the airlock's daprd
// calls by the container's name, as cloudflare runs it as a Cloudflare
// Container: built from its Dockerfile as `<container>-appliance`, its own
// process the image's.
Deno.test("a bridge on k8s ships its built container, which the daprd there reaches by name", async () => {
  type Emitted = Record<string, { data: { effects?: Record<string, { bridge?: unknown }>; bridges?: unknown; endpoints?: unknown; targets?: Record<string, unknown> } }>;
  const k8s = await emitFiles(program('{container: "transport", targets: ["k8s"]}')) as unknown as Emitted;
  assertEquals(k8s["services/airlock/effects.json"].data.effects!.charge.bridge, { name: "fetch", targets: ["k8s"], simulated: false });
  assertEquals(k8s[".pronto/cluster.json"].data.bridges, [{ name: "fetch", container: "transport", port: 8080, targets: ["k8s"], build: "transport-appliance" }]);
  assertEquals(k8s[".pronto/cluster.json"].data.endpoints, { k8s: { charge: "http://transport:8080" } });
  assert((k8s["bayt.json"].data.targets as Record<string, unknown>)["transport-appliance"] !== undefined, "the k8s release has no target to bake the bridge's image from");
  const pulled = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["k8s"]}', '{activate: "", dockerfile: {from: null}, compose: image: "ghcr.io/example/transport:1"}'));
  assert(!pulled.success, "a bridge on k8s whose container pulls its image was accepted");
  assertStringIncludes(pulled.stderr, "names k8s but its container transport builds no image from a Dockerfile");
  const commanded = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["k8s"]}', '{activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: command: ["fetch"]}'));
  assert(!commanded.success, "a bridge on k8s whose process only compose runs was accepted");
  assertStringIncludes(commanded.stderr, "names k8s but its container transport sets compose.command");
  const placed = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["k8s"]}', '{activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: working_dir: "/srv"}'));
  assert(!placed.success, "a bridge on k8s whose directory only compose states was accepted");
  assertStringIncludes(placed.stderr, "names k8s but its container transport sets compose.working_dir");
  const empty = await cue(["export", "-", "-e", "out"], program('{container: "transport", targets: ["k8s"]}', '{activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {volumes: [], privileged: false}}'));
  assert(empty.success, empty.stderr);
});

// An effect's endpoint on k8s is its sink there: an origin for k8s over a
// bridge elsewhere, as an app keeps simulators on docker and the vendor's
// API on its clusters. One reached on k8s only through a bridge k8s does not
// run would be dialed and never answer, where the airlock settles the
// effect's own bridge as not deployed.
Deno.test("an effect's endpoint on k8s is its k8s sink", async () => {
  type Emitted = Record<string, { data: { endpoints?: unknown; spec?: { baseUrl: string }; effects?: Record<string, { bridge?: unknown }> } }>;
  const origin = await emitFiles(program('{container: "transport", targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch"], port: 8090}}').replace(
    'sink: {bridge: "fetch", idempotent: false}',
    'sink: {bridge: "fetch", idempotent: false, targets: k8s: origin: "https://api.acquirer.example"}',
  )) as unknown as Emitted;
  assertEquals(origin[".pronto/cluster.json"].data.endpoints, { k8s: { charge: "https://api.acquirer.example" } });
  assertEquals(origin["services/airlock/dapr/charge.yaml"].data.spec!.baseUrl, "http://transport:8080");
  // Its own bridge runs on docker alone, and its sink on k8s is an origin, so
  // the airlock there calls it rather than settling it not deployed.
  assertEquals(origin["services/airlock/effects.json"].data.effects!.charge.bridge, { name: "fetch", targets: ["docker", "k8s"], simulated: false });
  // By URL, so pronto's own type check, which holds no mecha, never resolves it.
  const { parseManifest, undeployed } = await import(new URL("../../libraries/mecha/services/airlock/reentry.ts", import.meta.url).href) as {
    parseManifest: (text: string) => Record<string, unknown>;
    undeployed: (effect: unknown, target: string) => { data: { reason: string } } | null;
  };
  const charge = parseManifest(JSON.stringify(origin["services/airlock/effects.json"].data)).charge;
  assertEquals(undeployed(charge, "k8s"), null);
  assertEquals(undeployed(charge, "docker"), null);
  assertEquals(undeployed(charge, "cloudflare")?.data.reason, "not deployed");
  const plain = await emitFiles(paymentProgram()) as unknown as Emitted;
  assertEquals(plain[".pronto/cluster.json"].data.endpoints, { k8s: { charge: "https://api.acquirer.example" } });
  const unreached = await cue(["export", "-", "-e", "out"], paymentProgram().replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {origin: "https://api.acquirer.example", idempotent: false, targets: k8s: bridge: "fetch"}\n      reentry: "repeat"',
  ) + '\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: {container: "transport"}\n_cluster: surface: targets: transport: ' + BUILT + '\n');
  assert(!unreached.success, "an effect reaching on k8s a bridge k8s does not run was accepted");
  assertStringIncludes(unreached.stderr, "effect charge reaches bridge fetch on k8s, which fetch does not name in its targets");
});
