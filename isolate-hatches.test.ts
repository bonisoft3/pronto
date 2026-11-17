// An isolate hatch is a container of another shape: a module in the Workers
// format that pronto bundles and serves itself ([[docs/isolate-hatches]]).
// Its bridge lowers as a container bridge's wherever a container runs, with
// the container, port and appliance form derived, and on cloudflare as a
// Worker of its own (bundle/edge-dispatcher_test.ts).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { parse } from "jsr:@std/yaml@1.0.5";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const HATCH = '{kind: "isolate", note: "renders documents", entrypoint: "isolates/pdf/main.ts", files: ["isolates/pdf/main.ts", "isolates/pdf/deno.json", "isolates/pdf/add.wasm", "isolates/pdf/add.wasm.js"], memory: 96}';

const program = (bridge: string, hatch = HATCH, targets = "[]") =>
  paymentProgram().replace("targets: []", `targets: ${targets}`).replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {bridge: "fetch", idempotent: false}\n      reentry: "repeat"',
  ) +
  `\napp: capabilities: hatches: pdf: ${hatch}\napp: state: bridges: fetch: ${bridge}\n`;

type Emitted = Record<string, { data: { effects?: Record<string, { bridge?: unknown }>; bridges?: unknown; targets?: Record<string, { dockerfile?: { epilogue?: string[]; cmd?: string[]; copy?: { srcs: string[]; dst: string }[] } }> } }>;

Deno.test("an isolate bridge is a container bridge whose container pronto derives", async () => {
  const files = await emitFiles(program('{isolate: "pdf", targets: ["docker", "cloudflare"]}')) as unknown as Emitted;
  assertEquals(files["services/airlock/effects.json"].data.effects!.charge.bridge, { name: "fetch", targets: ["docker", "cloudflare"], simulated: false });
  // The edge builds the isolate by the script every release runs.
  const [listed] = files[".pronto/cluster.json"].data.bridges as { isolate: { build: string } }[];
  assertStringIncludes(listed.isolate.build, '"bundle", "--platform=browser", "--packages=bundle"');
  const build = listed.isolate.build;
  // The edge's tests run the build its fixture carries: it is this one.
  const fixture = JSON.parse(await Deno.readTextFile(new URL("./testdata/edge-isolate/.pronto/cluster.json", import.meta.url))) as { bridges: { isolate: { build: string } }[] };
  assertEquals(fixture.bridges[0].isolate.build, build, "testdata/edge-isolate's build is stale: copy mecha's #IsolateBuild into it");
  assertEquals(files[".pronto/cluster.json"].data.bridges, [{
    name: "fetch",
    container: "pdf",
    port: 8080,
    targets: ["docker", "cloudflare"],
    build: "pdf-appliance",
    isolate: {
      entrypoint: "isolates/pdf/main.ts",
      files: ["isolates/pdf/main.ts", "isolates/pdf/deno.json", "isolates/pdf/add.wasm", "isolates/pdf/add.wasm.js"],
      memory: 96,
      build,
    },
  }]);
  // The hatch is a bayt target: one cmd builds the module, in the image and
  // on the host alike, into its outs, and its process serves the build's
  // entry through the host, its old space bounded by V8's own limit.
  type Target = { name: string; cmd: Record<string, { do: string; shell: string }>; outs: { globs: string[] }; srcs: { globs: string[] }; entrypoint: { do: string }; dockerfile: { workdir: string; preamble?: string[]; epilogue?: string[] } };
  const target = (files["bayt.json"].data as unknown as { targets: Record<string, Target> }).targets["pdf-appliance"];
  assertStringIncludes(target.cmd.builtin.do, "ISOLATE_ROOT=. ISOLATE_OUT='.isolate/pdf' ISOLATE_ENTRYPOINT='isolates/pdf/main.ts'");
  assertEquals(target.outs.globs, []);
  assertEquals(target.srcs.globs, ["isolates/pdf/main.ts", "isolates/pdf/deno.json", "isolates/pdf/add.wasm", "isolates/pdf/add.wasm.js"]);
  assertEquals(target.entrypoint.do, `exec deno 'run' '--no-config' '--allow-net' '--allow-read' '--allow-run' '--allow-sys=networkInterfaces' '.isolate/pdf/host.js' '.isolate/pdf/entry.js' "$PORT" '50000' '96'`);
  assertEquals(target.dockerfile.workdir, "/isolate");
  // No Dockerfile lines of its own: bayt writes them from the target.
  assertEquals(target.dockerfile.preamble ?? [], []);
  assertEquals(target.dockerfile.epilogue ?? [], []);
});

// The docker appliance runs the isolate as a process of the airlock's own
// Deno, its host serving the bundle its image built on a port of its own,
// which the airlock's daprd dials by the container's name.
const releaseDocker = async (code: string) => {
  const res = await cue(["export", "-", "-e", '_build.project.targets["release-docker"]', "--out", "json"], code);
  assert(res.success, res.stderr);
  const rd = JSON.parse(res.stdout) as { deps: string[]; dockerfile: { preamble: string[]; copy: { from?: { ref?: string }; srcs: string[]; dst: string }[] } };
  const heredoc = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"))!;
  return { rd, heredoc, overlay: parse(heredoc.split("\n").slice(1, -1).join("\n")) as { processes: Record<string, { command: string }> } };
};

Deno.test("an isolate on docker runs in the appliance as the airlock's Deno serving its bundle", async () => {
  const res = await cue(["export", "-", "-e", '_build.project.targets["release-docker"]', "--out", "json"], program('{isolate: "pdf", targets: ["docker"]}', HATCH, '["docker"]'));
  assert(res.success, res.stderr);
  const rd = JSON.parse(res.stdout) as { deps: string[]; dockerfile: { preamble: string[]; epilogue: string[]; copy: { from?: { ref?: string }; srcs: string[]; dst: string }[] } };
  assert(rd.deps.includes(":pdf-appliance:outs"), `the isolate's build is no dependency: ${rd.deps}`);
  for (const f of ["host.js", "runner.js", "entry.js", "bundle.js", "shims.js", "add.wasm", "add.wasm.js"].map((f) => `/isolate/.isolate/pdf/${f}`)) {
    assert(rd.dockerfile.copy.some((c) => c.from?.ref === ":pdf-appliance" && c.srcs[0] === f && c.dst === f), `${f} is not copied from the isolate's image`);
  }
  const heredoc = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"))!;
  const overlay = parse(heredoc.split("\n").slice(1, -1).join("\n")) as { processes: Record<string, { command: string; environment?: string[] }> };
  assertStringIncludes(overlay.processes.pdf.command, "'airlock-deno' 'run' '--no-config' '--allow-net' '--allow-read' '--allow-run' '--allow-sys=networkInterfaces' '/isolate/.isolate/pdf/host.js' '/isolate/.isolate/pdf/entry.js' '9100' '50000' '96'");
  assertStringIncludes(heredoc, "BRIDGE_FETCH_URL=http://pdf:9100");
  assertStringIncludes(heredoc, "portcheck --port 9100");
  // The door's port, which whoever starts the appliance may move, is refused
  // where the isolate listens; the entrypoint the appliance writes still parses.
  const writer = rd.dockerfile.epilogue.find((l) => l.includes("> /usr/local/bin/appliance-entrypoint.sh"))!;
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/entrypoint.sh`;
    const written = await new Deno.Command("sh", { args: ["-c", writer.replace(/^RUN /, "").replace(/ > \/usr\/local\/bin\/appliance-entrypoint\.sh && chmod 755 \/usr\/local\/bin\/appliance-entrypoint\.sh$/, ` > ${script}`)] }).output();
    assert(written.success, new TextDecoder().decode(written.stderr));
    const text = await Deno.readTextFile(script);
    assertStringIncludes(text, `if [ "$PORT" = 9100 ]; then echo "appliance: PORT 9100 is where the bridge process pdf listens; set another" >&2; exit 1; fi`);
    assert((await new Deno.Command("sh", { args: ["-n", script] }).output()).success, "the appliance's entrypoint does not parse");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an isolate hatch and its bridge are refused where they disagree", async () => {
  const refused = async (code: string, message: string) => {
    const res = await cue(["export", "-", "-e", "out"], code);
    assert(!res.success, `accepted: ${message}`);
    assertStringIncludes(res.stderr, message);
  };
  await refused(program('{isolate: "nothing"}'), "bridge fetch names undeclared isolate hatch: nothing");
  await refused(
    program('{isolate: "pdf"}', HATCH) + '\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: other: {isolate: "transport"}\n',
    "bridge other names hatch transport by isolate, which is not an isolate",
  );
  await refused(program('{container: "pdf"}'), "bridge fetch names hatch pdf, which is not a container");
  await refused(
    program('{isolate: "pdf"}', HATCH.replace('entrypoint: "isolates/pdf/main.ts"', 'entrypoint: "isolates/pdf/other.ts"')),
    "isolate hatch pdf's entrypoint isolates/pdf/other.ts is not one of its files",
  );
  await refused(program('{isolate: "pdf", targets: ["cloudflare"], instance_type: "standard-1"}'), "an isolate runs as a Worker there");
  await refused(program('{isolate: "pdf"}', HATCH.replace('"isolates/pdf/deno.json"', '"isolates/pdf/deno.json", ".isolate/pdf/x.ts"')), "isolate hatch pdf's .isolate/pdf/x.ts is under .isolate/");
  await refused(program('{isolate: "pdf", targets: ["cloudflare"], appliance: {srcs: ["/custom"], command: ["custom"], port: 9090}}'), "bridge fetch states an appliance form, which pronto derives for an isolate");
  // A Cloudflare Worker's isolate holds 128 MiB.
  const big = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf"}', HATCH.replace("memory: 96", "memory: 256")));
  assert(!big.success, "an isolate past 128 MiB was accepted");
  assertStringIncludes(big.stderr, "memory");
  // Its container is the hatch's: one port, the bridge's.
  const port = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf", port: 9000}'));
  assert(!port.success, "an isolate bridge on a port of its own was accepted");
});

// Ports and bundles belong to the hatch: two isolates in one directory keep
// their own bundles, two bridges on one isolate are one process, and a port a
// container bridge's appliance form takes is passed over. The charge effect
// reaches a second bridge through its cloudflare sink.
const reaching = (second: string, declarations: string) =>
  program('{isolate: "pdf", targets: ["docker"]}', HATCH, '["docker", "cloudflare"]').replace(
    'sink: {bridge: "fetch", idempotent: false}',
    `sink: {bridge: "fetch", idempotent: false, targets: cloudflare: bridge: "${second}"}`,
  ) + declarations;

Deno.test("an isolate's bundle and appliance port are its hatch's own", async () => {
  const neighbours = await releaseDocker(reaching("sheets",
    'app: capabilities: hatches: sheet: {kind: "isolate", note: "writes sheets", entrypoint: "isolates/pdf/sheet.ts", files: ["isolates/pdf/sheet.ts"]}\n' +
    'app: state: bridges: sheets: {isolate: "sheet", targets: ["docker", "cloudflare"]}\n'));
  assertStringIncludes(neighbours.overlay.processes.pdf.command, "'/isolate/.isolate/pdf/entry.js' '9100'");
  assertStringIncludes(neighbours.overlay.processes.sheet.command, "'/isolate/.isolate/sheet/entry.js' '9101'");
  assert(neighbours.rd.dockerfile.copy.some((c) => c.from?.ref === ":sheet-appliance" && c.srcs[0] === "/isolate/.isolate/sheet/bundle.js"));

  // On docker only: on cloudflare a container, an isolate's too, is one bridge's.
  const shared = await releaseDocker(reaching("render", 'app: state: bridges: render: {isolate: "pdf", targets: ["docker"]}\n'));
  assertStringIncludes(shared.overlay.processes.pdf.command, "'/isolate/.isolate/pdf/entry.js' '9100'");
  assertStringIncludes(shared.heredoc, "BRIDGE_FETCH_URL=http://pdf:9100");
  assertStringIncludes(shared.heredoc, "BRIDGE_RENDER_URL=http://pdf:9100");

  const beside = await releaseDocker(reaching("other",
    'app: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\n' +
    'app: state: bridges: other: {container: "transport", targets: ["docker", "cloudflare"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch"], port: 9100}}\n' +
    '_cluster: surface: targets: transport: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}\n'));
  assertStringIncludes(beside.overlay.processes.pdf.command, "'9101' '50000' '96'");
});

// A root-level module is a module, and its WebAssembly shims, which land in
// one directory beside the bundle, have names of their own.
Deno.test("an isolate may sit at the app's root, and its WebAssembly files have names of their own", async () => {
  const root = await emitFiles(program('{isolate: "pdf", targets: ["cloudflare"]}', '{kind: "isolate", note: "renders", entrypoint: "main.ts", files: ["main.ts", "deno.json"]}')) as unknown as Emitted;
  assertStringIncludes(JSON.stringify(root["bayt.json"]), "ISOLATE_ENTRYPOINT='main.ts'");
  const res = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf"}', HATCH.replace('"isolates/pdf/add.wasm.js"', '"isolates/pdf/add.wasm.js", "isolates/pdf/lib/add.wasm.js"')));
  assert(!res.success, "two WebAssembly shims of one name were accepted");
  assertStringIncludes(res.stderr, "isolate hatch pdf has two files named add.wasm.js");
});

// A stock isolate is pronto's own module: the hatch names it, and the
// emission writes it into the app, where its build reads it as any other.
Deno.test("a stock isolate is pronto's module, written into the app", async () => {
  const stock = '{kind: "isolate", note: "renders receipts", stock: "pdf", memory: 96}';
  const files = await emitFiles(program('{isolate: "pdf", targets: ["docker", "cloudflare"]}', stock)) as unknown as Record<string, { format: string; text?: string; data?: { bridges?: { isolate: { entrypoint: string; files: string[] } }[] } }>;
  const sources = ["main.ts", "deno.json", "deno.lock"];
  for (const f of sources) {
    const written = files[`.pronto/isolates/pdf/${f}`];
    assert(written !== undefined, `.pronto/isolates/pdf/${f} is not written`);
    assertEquals(written.text, await Deno.readTextFile(new URL(`./isolates/pdf/${f}`, import.meta.url)));
  }
  // main.ts says it is generated; the module's config and lock stay as Deno wrote them.
  assertEquals(files[".pronto/isolates/pdf/main.ts"].format, "js");
  assertEquals(files[".pronto/isolates/pdf/deno.lock"].format, "text");
  const [bridge] = files[".pronto/cluster.json"].data!.bridges!;
  assertEquals(bridge.isolate.entrypoint, ".pronto/isolates/pdf/main.ts");
  assertEquals(bridge.isolate.files, sources.map((f) => `.pronto/isolates/pdf/${f}`));
  // Its image builds from the files written, as any isolate's does.
  const target = (files["bayt.json"].data as unknown as { targets: Record<string, { srcs: { globs: string[] }; cmd: Record<string, { do: string }> }> }).targets["pdf-appliance"];
  assertEquals(target.srcs.globs, sources.map((f) => `.pronto/isolates/pdf/${f}`));
  assertStringIncludes(target.cmd.builtin.do, "ISOLATE_ENTRYPOINT='.pronto/isolates/pdf/main.ts'");
  // pdfmake is pinned to one version, the lock's.
  assertStringIncludes(files[".pronto/isolates/pdf/deno.json"].text!, '"npm:/pdfmake@0.3.13/"');

  // The module is pronto's: a hatch naming a stock isolate names no module of its own.
  const res = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf"}', stock.replace('stock: "pdf"', 'stock: "pdf", entrypoint: "isolates/pdf/main.ts"')));
  assert(!res.success, "a stock isolate with an entrypoint of its own was accepted");
  assertStringIncludes(res.stderr, "hatches.pdf.entrypoint: conflicting values");
  const unknown = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf"}', stock.replace('stock: "pdf"', 'stock: "xlsx"')));
  assert(!unknown.success, "a stock isolate pronto does not ship was accepted");
  assertStringIncludes(unknown.stderr, "hatches.pdf.stock: conflicting values");
  const container = await cue(["export", "-", "-e", "out"], program('{isolate: "pdf"}', '{kind: "container", note: "a native transport", stock: "pdf"}'));
  assert(!container.success, "a container hatch naming a stock isolate was accepted");
  assertStringIncludes(container.stderr, "hatches.pdf.stock: field not allowed");
});
