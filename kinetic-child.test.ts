// A Cortex `via: "kinetic"` child (cortex.cue #KineticActor), held by #App
// (`_cortexRefusal`, one sentence per violation) and carried to the terminal in
// shell.yaml's `kinetic`. Each refusal is asserted by its sentence, so a
// fixture failing elsewhere does not pass as the refusal under test.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles } from "./effects-fixtures.ts";

const actor = ({ engine = "race", sound = "voice", presenter = "painter" } = {}) => `{
      via: "kinetic"
      handler: "shell/handlers/run.js"
      engine: "${engine}"
      sound: "${sound}"
      presenter: "${presenter}"
      bindings: {up: ["ArrowUp", "gamepad:axis:1:-"]}
      seats: [{up: ["KeyW"]}, {up: ["ArrowUp"]}]
      menu: {up: ["ArrowUp", "gamepad:axis:1:-"], confirm: ["Enter"]}
      pause: ["Escape"]
    }`;

const google = ` --ice-servers '[{"urls":"stun:stun.l.google.com:19302"}]'`;

const program = ({ child = actor(), markup = `<main data-live="run"><div data-kinetic="race" data-on-milestone="run"></div></main>`, targets = "[]", statics = "[]", durability = "tab" } = {}) => `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-kinetic"
    description: "test"
    ir: sha256: ""
    targets: ${targets}
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: Run: {
      table: "run"
      durability: "${durability}"
      fields: [
        {name: "id", type: "string", pk: true},
        {name: "seed", type: "int32"},
      ]
    }
    cortex: root: {
      config: {id: "root", initial: "arena", states: arena: {meta: screen: "arena", invoke: [{src: "race"}]}}
      setup: actors: race: ${child}
    }
  }
  capabilities: {hatches: {}, vendored: painter: {
    isolation: "agent"
    ports: {reads: [], raises: []}
    scripts: []
    src: "shell/engine/present.js"
    files: ["shell/engine/present.js"]
    note: "paints the race"
  }}
  surface: {
    screens: arena: {
      title: "Arena"
      route: "/"
      markup: ${JSON.stringify(markup)}
      reads: [{table: "run", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
      forms: []
      states: []
    }
    engines: {
      race: {src: "shell/engine/engine.js", note: "the race"}
      voice: {src: "shell/engine/sound.js", role: "sound", note: "its sound"}
    }
    handlers: {}
    design: {}
    flows: {}
  }
}

_terminal: (pronto.#DefaultTerminal & {code: app}).out
_cluster: (pronto.#DefaultCluster & {code: app, statics: ${statics}}).out
_loop: (pronto.#DefaultLoop & {code: app, terminal: _terminal, cluster: _cluster}).out
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}).files
`;

async function refused(code: string, sentence: string) {
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, false, `vet passed where the refusal was: ${sentence}`);
  assertStringIncludes(res.stderr, sentence);
}

Deno.test("a kinetic child passes, and shell.yaml carries its graphs, presenter and mappers", async () => {
  const vet = await cue(["vet", "-c", "-"], program());
  assertEquals(vet.success, true, vet.stderr);
  const files = await emitFiles(program()) as unknown as Record<string, { data: { kinetic: unknown } }>;
  assertEquals(files["shell/shell.yaml"].data.kinetic, {
    race: {
      engine: "shell/engines/race.json",
      sound: "shell/engines/voice.json",
      presenter: "painter",
      bindings: { up: ["ArrowUp", "gamepad:axis:1:-"] },
      seats: [{ up: ["KeyW"] }, { up: ["ArrowUp"] }],
      menu: { up: ["ArrowUp", "gamepad:axis:1:-"], confirm: ["Enter"] },
      pause: ["Escape"],
    },
  });
  assertEquals(files["shell/handlers/race.js"], undefined, "a kinetic child composes no handler over a machine");
});

Deno.test("a kinetic child names a declared engine, sound role and presenter", async () => {
  await refused(program({ child: actor({ engine: "voice" }) }), "root.arena: no engine voice races the kinetic child race");
  await refused(program({ child: actor({ engine: "nobody" }) }), "root.arena: no engine nobody races the kinetic child race");
  await refused(program({ child: actor({ sound: "race" }) }), "root.arena: no sound role race voices the kinetic child race");
  await refused(program({ child: actor({ presenter: "nobody" }) }), "root.arena: no presenter nobody paints the kinetic child race");
});

Deno.test("a kinetic child's screen mounts it", async () => {
  await refused(program({ markup: `<main data-live="run"></main>` }), `root.arena: no data-kinetic=\\"race\\" mounts the kinetic child on its screen`);
});

// STUN is the release target's, never the app's (distribution's #IceServers):
// a dev or CI stack gathers host candidates only, so no test reaches a server
// outside it, and a release that lost its list would still duel on one network
// and fail only between two homes.
Deno.test("each release target writes its own ICE servers, and a dev or CI stack none", async () => {
  const files = await emitFiles(program({ targets: '["cloudflare", "docker"]', statics: "_terminal.surface.statics", durability: "server" }));
  // deno-lint-ignore no-explicit-any
  const data = (name: string) => (files[name] as unknown as { data: any }).data;
  assertEquals(data("shell/shell.json").iceServers, [], "the config every stack reads names none");
  const named: string[] = [];
  const walk = (value: unknown, at: string[]) => {
    if (typeof value === "string" && value.includes("--ice-servers")) named.push(at.join("."));
    else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...at, k]);
  };
  walk(files, []);
  assertEquals(named.sort(), [
    ".say.yaml.data.say.release.rulemap.cloudflare.cmds.0.do",
    "bayt.json.data.files.checks.yaml.say.release.rulemap.cloudflare.cmds.0.do",
    "bayt.json.data.targets.served-release.dockerfile.epilogue.0",
  ], "only release@cloudflare's build and the container targets' tree name ICE servers");
  assertStringIncludes(data(".say.yaml").say.release.rulemap.cloudflare.cmds[0].do, ` --ice-servers '[{"urls":"stun:stun.cloudflare.com:3478"}]'`);
  const targets = data("bayt.json").targets;
  assertEquals(targets["served-release"].dockerfile.epilogue[0].endsWith(google), true);
  const copied = targets["release-docker"].dockerfile.copy.filter((c: { from: { ref?: string } | null }) => c.from?.ref === ":served-release");
  assertEquals(copied.map((c: { srcs: string[]; dst: string }) => [c.srcs, c.dst]), [
    [["/served/omnishell/"], "/omnishell/"],
    [["/served/"], "/srv/"],
    [["/served.scripts"], "/etc/caddy/release-scripts"],
  ], "the image serves the release's tree and names its inline scripts");
});

// gcp and k8s bake the door over this tree (k8s/release.nu release-tree, held
// by k8s/release_test.nu), so each target alone emits it.
Deno.test("gcp and k8s each emit the container targets' tree, with Google's list", async () => {
  for (const target of ["gcp", "k8s"]) {
    const files = await emitFiles(program({ targets: `["${target}"]`, statics: "_terminal.surface.statics", durability: "server" }));
    // deno-lint-ignore no-explicit-any
    const targets = (files["bayt.json"] as unknown as { data: any }).data.targets;
    assertEquals(targets["served-release"]?.dockerfile.epilogue[0].endsWith(google), true, target);
    assertEquals(targets["served"].dockerfile.epilogue[0].includes("--ice-servers"), false, `${target}: the dev stack's tree names none`);
  }
});
