// The docker appliance target (docs/release-targets.md#docker): single-container
// image running PostgreSQL 18, PostgREST, Caddy, Auth, and process-compose.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { parse } from "jsr:@std/yaml@1.0.5";
import { cue, paymentProgram } from "./effects-fixtures.ts";

async function exportJson(expr: string, code: string) {
  const res = await cue(["export", "-", "-e", expr, "--out", "json"], code);
  return { ...res, value: res.success ? JSON.parse(res.stdout) : undefined };
}

Deno.test("docker is the default release target when targets is omitted", async () => {
  const code = paymentProgram().replace("targets: []", "");
  const res = await exportJson("app.meta.targets", code);
  assertEquals(res.success, true, res.stderr);
  assertEquals(res.value, ["docker"]);
});

Deno.test("explicit targets override the docker default", async () => {
  const pagesCode = paymentProgram().replace("targets: []", 'targets: ["pages"]');
  const pagesRes = await exportJson("app.meta.targets", pagesCode);
  assertEquals(pagesRes.success, true, pagesRes.stderr);
  assertEquals(pagesRes.value, ["pages"]);

  const emptyCode = paymentProgram(); // has explicit targets: []
  const emptyRes = await exportJson("app.meta.targets", emptyCode);
  assertEquals(emptyRes.success, true, emptyRes.stderr);
  assertEquals(emptyRes.value, []);
});

Deno.test("docker appliance target emits release-docker with PORT and ORIGIN knobs", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]');
  const res = await exportJson('_build.project.targets["release-docker"]', code);
  assertEquals(res.success, true, res.stderr);
  const rd = res.value;
  assert(rd, "release-docker target must be emitted");
  assertEquals(rd.compose.ports, ["${PORT:-8080}:${PORT:-8080}"]);

  const preamble = rd.dockerfile.preamble.join("\n");
  assertStringIncludes(preamble, "ENV PORT=8080");
  assertStringIncludes(preamble, "ENV PGDATA=/var/lib/pgsql/data");
  assertStringIncludes(preamble, "ENV ORIGIN=http://localhost:8080");
  assertStringIncludes(preamble, "ENV CADDY_TLS_HOST_PORT=8080");

  const epilogue = rd.dockerfile.epilogue.join("\n");
  assertStringIncludes(epilogue, 'export PORT="${PORT:-8080}"');
  assertStringIncludes(epilogue, 'export CADDY_TLS_HOST_PORT="${PORT}"');
  assertStringIncludes(epilogue, "WEBAUTHN_RP_ID");
  assertStringIncludes(epilogue, "WEBAUTHN_ORIGIN");
  assertStringIncludes(epilogue, "process-compose.yaml");
});

type Target = { deps: string[]; dockerfile: { defaultPreamble: unknown; preamble: string[]; epilogue: string[]; copy: { from?: { ref?: string; name?: string }; srcs: string[]; dst: string }[]; cmd: string[] } };

const bridged = (bridge: string) =>
  paymentProgram().replace("targets: []", 'targets: ["docker"]').replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {bridge: "fetch", idempotent: false}\n      reentry: "repeat"',
  ) +
  `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: ${bridge}\n` +
  `_cluster: surface: targets: transport: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}\n`;

// The appliance's own processes, as process-compose reads the overlay.
function overlayOf(rd: Target): { processes: Record<string, { command: string; availability?: { restart?: string }; environment?: string[] }> } {
  const heredoc = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"))!;
  return parse(heredoc.split("\n").slice(1, -1).join("\n")) as never;
}

async function releaseDocker(code: string): Promise<Target> {
  const res = await exportJson('_build.project.targets["release-docker"]', code);
  assertEquals(res.success, true, res.stderr);
  return res.value;
}

// The appliance runs the airlock beside its database: a program with effects
// once released an image whose invoking rows claimed their ledger and never ran.
Deno.test("release-docker runs a program's effects: the airlock, its daprd and the ledger's upgrade as processes", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  for (const dep of [":airlock:outs", ":airlock-mesh:outs", ":airlock-upgrade:outs"]) assert(rd.deps.includes(dep), `${dep} missing from ${rd.deps}`);
  const copied = rd.dockerfile.copy.map((c) => `${c.from?.ref ?? ""}${c.srcs.join(",")}>${c.dst}`);
  for (const c of [":airlock/usr/bin/deno>/usr/local/bin/airlock-deno", ":airlock/airlock>/airlock", ":airlock-mesh/daprd>/daprd", ":airlock-mesh/dapr>/dapr", ":airlock-upgrade/airlock-upgrade.sql>/airlock-upgrade.sql"]) {
    assert(copied.includes(c), `${c} not copied: ${copied.join(" ")}`);
  }
  const overlay = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"));
  assert(overlay, "the airlock's processes are not written into the appliance");
  for (const s of ["airlock-upgrade:", "airlock-mesh:", "airlock:", "main.ts", "DATABASE_URL=postgres://", "process_completed_successfully"]) assertStringIncludes(overlay, s);
  assert(!overlay.includes("AIRLOCK_TARGET"), "a program without bridges names no airlock target");
  assertEquals(rd.dockerfile.cmd.slice(0, 6), ["/usr/local/bin/process-compose", "up", "-f", "/.bayt/process-compose.yaml", "-f", "/.bayt/process-compose.appliance.yaml"]);
  assertEquals(rd.dockerfile.cmd.at(-1), "airlock");
  assertStringIncludes(rd.dockerfile.epilogue.join("\n"), "for n in crud database auth airlock-mesh airlock;");
});

Deno.test("a bridge on docker runs in the appliance as a process its daprd dials by the container's name", async () => {
  const rd = await releaseDocker(bridged('{container: "transport", port: 8090, targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8090"]}}'));
  assert(rd.deps.includes(":transport-appliance:outs"), `the bridge's build is no dependency: ${rd.deps}`);
  assert(rd.dockerfile.copy.some((c) => c.from?.ref === ":transport-appliance" && c.srcs[0] === "/bin/fetch" && c.dst === "/bin/fetch"), "the bridge's binary is not copied");
  const overlay = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"))!;
  for (const s of ["transport:", "/bin/fetch", "portcheck --port 8090", "AIRLOCK_TARGET=docker"]) assertStringIncludes(overlay, s);
  assertStringIncludes(rd.dockerfile.epilogue.join("\n"), "airlock-mesh airlock transport;");
});

// The binding reads its bridge's address from the environment, which the base
// processes set to the compose port: the appliance's daprd dialed a port nothing
// served until it named the appliance's.
Deno.test("a bridge served on another port in the appliance is dialed there, by the address its binding reads", async () => {
  const rd = await releaseDocker(bridged('{container: "transport", targets: ["docker"], appliance: {srcs: ["/bin/fetch"], command: ["/bin/fetch", "--listen", "127.0.0.1:8091"], port: 8091}}'));
  const overlay = rd.dockerfile.preamble.find((l) => l.includes("process-compose.appliance"))!;
  assertStringIncludes(overlay, "BRIDGE_FETCH_URL=http://transport:8091");
  assertStringIncludes(overlay, "portcheck --port 8091");
});

Deno.test("a bridge not deployed on docker starts nothing there, and its effects settle not deployed", async () => {
  const rd = await releaseDocker(bridged('{container: "transport"}'));
  assert(!rd.deps.includes(":transport-appliance:outs"), "an undeployed bridge's build is a dependency");
  const overlay = rd.dockerfile.preamble.find((l) => l.includes("/.bayt/process-compose.appliance.yaml"))!;
  assert(!overlay.includes("transport:"), "an undeployed bridge runs in the appliance");
  assertStringIncludes(overlay, "AIRLOCK_TARGET=docker");
});

Deno.test("release-docker refuses an effect answered by the AI gateway, which the appliance does not run", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]').replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {ai: "text", idempotent: true}',
  ).replace("capabilities: {hatches: {}", 'capabilities: {ai: {text: ["cheap"]}, hatches: {}');
  const res = await exportJson('_build.project.targets["release-docker"].dockerfile.preamble', code);
  assertEquals(res.success, true, res.stderr);
  assertStringIncludes(res.value[0], "does not yet run the AI gateway");
  assertStringIncludes(res.value[0], "exit 1");
});

Deno.test("a program without effects releases the appliance it did before", async () => {
  const code = paymentProgram({ machine: "pending: type: \"final\"" }).replace("targets: []", 'targets: ["docker"]').replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "");
  const rd = await releaseDocker(code);
  assert(!rd.dockerfile.preamble.some((l) => l.includes("process-compose.appliance")), "an appliance overlay without effects");
  assertEquals(rd.dockerfile.cmd, ["/usr/local/bin/process-compose", "up", "-f", "/.bayt/process-compose.yaml", "-t=false", "--no-server", "caddy"]);
  // The names each go in, or the entrypoint dies naming the one it could not
  // add: one swallowed write once left the airlock dialing nothing.
  const epilogue = rd.dockerfile.epilogue.join("\n");
  assertStringIncludes(epilogue, "for n in crud database auth;");
  assertStringIncludes(epilogue, "cannot name $n in /etc/hosts");
  assert(!epilogue.includes("2>/dev/null || true"), "a failed /etc/hosts write is swallowed");
});

// Leap ships neither pg_ivm, which the cluster preloads, nor the `plv8` language
// the database's Jessie names: an appliance without pg_ivm failed every start
// with "could not access file \"pg_ivm\"", and one without plv8 ran no
// validation, reducer or function.
Deno.test("every appliance carries pljs as plv8 and pg_ivm, built by the database image's recipe", async () => {
  const code = paymentProgram({ machine: "pending: type: \"final\"" }).replace("targets: []", 'targets: ["docker"]').replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "");
  const rd = await releaseDocker(code);
  // Built once, by mecha, against the server the appliance installs: the
  // per-app stage each docker app compiled the same toolchain in is gone.
  assert(!rd.deps.some((d) => d.includes("pg-extensions")), `a per-app extensions build: ${rd.deps}`);
  const copied = rd.dockerfile.copy.map((c) => `${c.from?.name ?? c.from?.ref ?? ""}${c.srcs.join(",")}>${c.dst}`);
  assert(copied.includes("libraries_mecha-extensions-image/pg-extensions/lib/>/usr/lib/postgresql18/lib64/"), copied.join(" "));
  assert(copied.includes("libraries_mecha-extensions-image/pg-extensions/extension/>/usr/share/postgresql18/extension/"), copied.join(" "));
  const server = JSON.stringify(rd.dockerfile.defaultPreamble);
  assertStringIncludes(server, "postgresql18-server=18.6-160000.1.1");
});

// The appliance once ran no change feed: an app's drains and pipelines, which
// compose's streams run off the logical slot, never ran there.
Deno.test("release-docker runs the change feed as compose does: Conduit, the bus and the streams", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]') + '\napp: state: drains: "settle-count": {on: ["payment"], call: "count_settled"}\n';
  const rd = await releaseDocker(code);
  for (const d of [":mesh-events:outs", ":conduit:outs", ":transform:outs"]) assert(rd.deps.includes(d), `${d} is no dependency: ${rd.deps}`);
  const copied = rd.dockerfile.copy.map((c) => `${c.from?.ref ?? ""}${c.srcs.join(",")}>${c.dst}`);
  for (const c of [
    ":mesh-events/daprd>/usr/local/bin/daprd",
    ":mesh-events/dapr/components/>/mesh-events/dapr/components/",
    ":conduit/app/conduit>/usr/local/bin/conduit",
    ":conduit/app/connectors/>/usr/local/bin/",
    ":transform/redpanda-connect>/usr/local/bin/redpanda-connect",
    ":transform/cdc-trace.yaml>/transform/cdc-trace.yaml",
    "docker/*.yaml>docker/",
  ]) assert(copied.includes(c), `${c} not copied: ${copied.join(" ")}`);
  // The whole docker/ once came along, its Caddyfile with it, which the door
  // prefers where it is: golaberto's appliance served its renderer's 502.
  assert(!copied.includes("docker>docker"), "the app's docker/ is copied whole, its Caddyfile with it");
  assert(rd.dockerfile.preamble.includes("ENV CADDY_CONFIG_FILE=/etc/caddy/Caddyfile"), "the door may load the app's docker/Caddyfile");
  const preamble = rd.dockerfile.preamble.join("\n");
  for (const s of ["ENV MECHA_MESH_DIR=/mesh-events", "ENV MECHA_TRANSFORM_DIR=/transform"]) assertStringIncludes(preamble, s);
  for (const p of ["conduit", "transform"]) assert(rd.dockerfile.cmd.includes(p), `${p} is not started: ${rd.dockerfile.cmd}`);
  const zypper = await exportJson('_build.project.targets["release-docker"].dockerfile.defaultPreamble', code);
  assertStringIncludes(JSON.stringify(zypper.value), "redis=8.2.0-bp160.1.3");
});

// The appliance refused computations, for want of the compute service and
// Feldera. It runs them on DuckDB snapshots, as launch@local does: no Feldera,
// whose Rust compile ran out of memory, and compute's files from its image.
Deno.test("release-docker runs a program's computations on DuckDB snapshots, without Feldera", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]') +
    '\napp: state: entities: Total: {table: "total", durability: "live", fields: [{name: "id", type: "uuid", pk: true}, {name: "n", type: "int"}]}\napp: state: computations: totals: to: ["Total"]\n';
  const rd = await releaseDocker(code);
  assert(!rd.dockerfile.preamble.some((l) => l.includes("does not yet run computations")), "computations refused");
  assert(rd.deps.includes(":compute:outs"), `compute is no dependency: ${rd.deps}`);
  assert(!rd.deps.some((d) => d.includes("feldera")), `Feldera is a dependency: ${rd.deps}`);
  const copied = rd.dockerfile.copy.map((c) => `${c.from?.ref ?? ""}${c.srcs.join(",")}>${c.dst}`);
  for (const c of [":compute/app/>/compute-app/", ":compute/deno-dir>/deno-dir", ":compute/durex>/durex"]) assert(copied.includes(c), `${c} not copied: ${copied.join(" ")}`);
  for (const e of ["ENV COMPUTE_APP_DIR=/compute-app", "ENV BAYT_LOCAL_DUCKDB_EXTENSIONS=/compute-app/extensions", "ENV DENO_DIR=/deno-dir"]) assert(rd.dockerfile.preamble.includes(e), e);
  for (const p of ["transform", "compute"]) assert(rd.dockerfile.cmd.includes(p), `${p} not started: ${rd.dockerfile.cmd}`);
  assert(rd.dockerfile.epilogue.includes("RUN touch /compute-app/extensions/.installed-v1.5.6"), "compute would install extensions at start");
});

Deno.test("a program without drains, pipelines or schedules starts no change feed, ticker or clock", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  for (const p of ["conduit", "transform", "ticker", "clock"]) assert(!rd.dockerfile.cmd.includes(p), `${p} started: ${rd.dockerfile.cmd}`);
  assert(![":conduit:outs", ":transform:outs", ":ticker:outs"].some((d) => rd.deps.includes(d)), `${rd.deps}`);
});

// The appliance applied only the schema initdb builds: an app whose forward
// migrations create what its drains call (golaberto's refresh_phase_rounds)
// started without them.
Deno.test("release-docker applies a program's forward migrations before what reads the schema", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]') +
    '\napp: state: migrations: "050_forward": operations: [{sql: {up: "SELECT 1;", onComplete: true}}]\n' +
    'app: state: drains: "settle-count": {on: ["payment"], call: "count_settled"}\n';
  const rd = await releaseDocker(code);
  assert(rd.deps.includes(":migrate:outs"), `the migrate image is no dependency: ${rd.deps}`);
  const copied = rd.dockerfile.copy.map((c) => `${c.from?.ref ?? ""}${c.srcs.join(",")}>${c.dst}`);
  for (const c of [":migrate/pgroll>/pgroll", ":migrate/migrate.sh>/migrate.sh", ":migrate/usr/local/bin/pgroll>/usr/local/bin/pgroll"]) {
    assert(copied.includes(c), `${c} not copied: ${copied.join(" ")}`);
  }
});

Deno.test("a program without forward migrations copies no migrate image", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  assert(!rd.deps.some((d) => d.startsWith(":migrate")), `${rd.deps}`);
});

// The appliance drops the renderer's handler and stubs Electric's. Cut at the
// first line that closed any block, both left golaberto's Caddyfile unbalanced:
// "unrecognized directive: :8080".
Deno.test("the appliance's Caddyfile edits keep its blocks balanced, and the image validates it", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  const edits = rd.dockerfile.epilogue.filter((l) => l.includes("/etc/caddy/Caddyfile") && l.startsWith("RUN awk"));
  assertEquals(edits.length, 2, edits.join("\n"));
  assertStringIncludes(rd.dockerfile.epilogue.join("\n"), "RUN caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile");
  const dir = await Deno.makeTempDir();
  const nested = [
    "(app) {",
    "  route {",
    "    handle /electric/* {",
    "      reverse_proxy {$UP:electric:3000} {",
    "        header_up X-A b",
    "      }",
    "    }",
    "    handle @rendered {",
    "      reverse_proxy {$R:render:8090} {",
    "        import bounded-render",
    "      }",
    "    }",
    "    handle {",
    "      file_server",
    "    }",
    "  }",
    "}",
    ":{$PORT:8080} {",
    "  import app",
    "}",
    "",
  ].join("\n");
  await Deno.writeTextFile(`${dir}/Caddyfile`, nested);
  for (const e of edits) {
    const sh = e.slice(4).replaceAll("/etc/caddy/Caddyfile", `${dir}/Caddyfile`).replaceAll("/tmp/Caddyfile", `${dir}/Caddyfile.tmp`).replaceAll("/etc/caddy/", `${dir}/`);
    const r = await new Deno.Command("sh", { args: ["-c", sh] }).output();
    assert(r.success, new TextDecoder().decode(r.stderr));
  }
  const out = await Deno.readTextFile(`${dir}/Caddyfile`);
  const depth = [...out].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
  assertEquals(depth, 0, out);
  assert(!out.includes("handle @rendered"), out);
  assert(!out.includes("reverse_proxy {$UP:electric:3000}"), out);
  assertStringIncludes(out, "header electric-handle stub");
  assertStringIncludes(out, "    handle {\n      file_server\n    }\n  }\n}\n:{$PORT:8080} {\n  import app\n}");
});

// A restarted appliance starts a temporary server to apply pending steps. Started
// without the server's options, it refused the change feed's slot ("wal_level <
// logical") and the appliance never came back.
Deno.test("the appliance's temporary server starts with the server's options", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  const script = rd.dockerfile.epilogue.find((l) => l.includes("/usr/local/bin/docker-entrypoint.sh"))!;
  assert(script.indexOf(`'if [ "$1" = "postgres" ]; then shift; fi'`) < script.indexOf("pg_ctl"), "options taken after the temporary start");
  assertEquals(script.split(`listen_addresses='\\'''\\'' $*" start`).length - 1, 2, script);
});

// An argument was single-quoted with nothing escaped: a quote in a bridge's
// command split the shell word, and a `$` was expanded by process-compose as
// it loaded the file, from the container's environment, not at run time.
Deno.test("a bridge's command reaches the shell as written, quotes and dollars included", async () => {
  const rd = await releaseDocker(bridged(`{container: "transport", targets: ["docker"], appliance: {srcs: ["/usr/local/bin/fetch"], command: ["sh", "-c", "exec fetch --name 'x' --port $PORT"], port: 8091}}`));
  assertEquals(overlayOf(rd).processes.transport.command, `'sh' '-c' 'exec fetch --name '\\''x'\\'' --port $$PORT'`);
  // The appliance's own commands keep the expansion they rely on.
  assertStringIncludes(overlayOf(rd).processes["airlock-upgrade"].command, "${POSTGRES_USER:-postgres}");
});

// The base timer-check read .bayt/bayt.timer-check.json, which the appliance
// never carries: crud waited on it, so a program with timers never started.
Deno.test("a program with timers checks them from the image's script in the appliance", async () => {
  const code = paymentProgram({ machine: `pending: after: "1000": "expired"\n        expired: type: "final"` })
    .replace("targets: []", 'targets: ["docker"]').replace("clocks: []", 'clocks: ["docker"]').replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "");
  const rd = await releaseDocker(code);
  assert(rd.deps.includes(":timer-check:outs"), `the timers' check is no dependency: ${rd.deps}`);
  assert(rd.dockerfile.copy.some((c) => c.from?.ref === ":timer-check" && c.srcs[0] === "/timer-check.sql" && c.dst === "/timer-check.sql"), "the timers' script is not copied");
  assertStringIncludes(overlayOf(rd).processes["timer-check"].command, "'--file=/timer-check.sql'");
  // The shared entrypoint every tier runs reads its build file, never a path it
  // probes for: a stray /timer-check.sql on a host would have run in its place.
  const check = await exportJson('_cluster.surface.targets["timer-check"].entrypoint.do', code);
  assertEquals(check.success, true, check.stderr);
  assert(!JSON.stringify(check.value).includes("path exists"), `the shared entrypoint probes the filesystem: ${check.value}`);
});

// Compose refuses to start an airlock without a secret an effect declares; the
// appliance's started it, and the handler ran with the secret undefined. A
// `${K:?…}` in the overlay is no refusal there: process-compose substitutes the
// message as the value.
Deno.test("the appliance does not start without a secret an effect declares", async () => {
  const rd = await releaseDocker(paymentProgram({ effect: 'secrets: ["ACQUIRER_KEY"]' }).replace("targets: []", 'targets: ["docker"]'));
  assert(!overlayOf(rd).processes.airlock.environment!.some((e) => e.includes("ACQUIRER_KEY")), "the overlay states the secret");
  const line = rd.dockerfile.epilogue.find((l) => l.includes("/usr/local/bin/appliance-entrypoint.sh"))!;
  const dir = await Deno.makeTempDir();
  const script = `${dir}/entrypoint.sh`;
  const write = line.replace(/^RUN /, "").replace(/ > \/usr\/local\/bin\/appliance-entrypoint\.sh && chmod 755 \/usr\/local\/bin\/appliance-entrypoint\.sh$/, ` > ${script}`);
  assert((await new Deno.Command("sh", { args: ["-c", write] }).output()).success, "the entrypoint does not write");
  // Its hosts step needs root; only the secrets step is under test here.
  await Deno.writeTextFile(script, (await Deno.readTextFile(script)).replace(/for n in [^\n]*\n[^\n]*\ndone\n/, ""));
  const missing = await new Deno.Command("sh", { args: [script, "true"], env: { ACQUIRER_KEY: "" } }).output();
  assert(!missing.success, "started without the secret");
  assertStringIncludes(new TextDecoder().decode(missing.stderr), "ACQUIRER_KEY is required: an effect declares it");
  const given = await new Deno.Command("sh", { args: [script, "true"], env: { ACQUIRER_KEY: "k" } }).output();
  assert(given.success, new TextDecoder().decode(given.stderr));
});

// An effect's answered bytes go to the blob plane, which the appliance does not
// run: refused, like the gateway and the computations.
Deno.test("an appliance with effects and the blob plane is refused", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]') + "\napp: capabilities: blobs: true\n";
  const res = await exportJson('[for l in _build.project.targets["release-docker"].dockerfile.preamble if l =~ "blob plane" {l}]', code);
  assertEquals(res.success, true, res.stderr);
  assertStringIncludes(res.value[0], "exit 1");
});

// The appliance's daprd bound its internal gRPC on every interface, at a random
// port, and was not restarted: a crash left the airlock failing every call.
Deno.test("the appliance's daprd listens as compose's does and restarts", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  const mesh = overlayOf(rd).processes["airlock-mesh"];
  for (const s of ["'--dapr-internal-grpc-listen-address' '127.0.0.1'", "'--metrics-port' '0'", "'--profile-port' '0'", "'--dapr-internal-grpc-port' '50002'"]) assertStringIncludes(mesh.command, s);
  assertEquals(mesh.availability?.restart, "on_failure");
});

// The change feed's ports are the ones bayt assigns the app: a bridge on one
// passed every check and fought that process for it.
Deno.test("the appliance's build refuses a bridge on a port an appliance process takes", async () => {
  const rd = await releaseDocker(bridged('{container: "transport", targets: ["docker"], appliance: {srcs: ["/usr/local/bin/fetch"], command: ["/usr/local/bin/fetch"], port: 8091}}'));
  const guard = rd.dockerfile.epilogue.find((l) => l.includes("is one an appliance process takes"));
  assert(guard, "no build-time port guard");
  assertStringIncludes(guard, 'ports="8091"');
  assertStringIncludes(guard, "/.bayt/process-compose.yaml");
});

// The extensions image mecha has not published yet stood in compose as a
// `${MONOREPO_COMPOSE_MODE:?…}` context: every compose command loading the file
// failed outside the monorepo (golaberto's archive tools), not only the build.
Deno.test("an unpublished mecha image refuses only the build that needs it", async () => {
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]')) as Target & { compose: { build: { additional_contexts: Record<string, string> } } };
  const ctx = rd.compose.build.additional_contexts["libraries_mecha-extensions-image"];
  assert(!ctx.includes(":?"), `compose refuses to load the file: ${ctx}`);
  assertStringIncludes(ctx, "${MONOREPO_COMPOSE_MODE:-docker-image://unpublished.invalid/mecha-publishes-no-extensions-image-yet}");
});

// One container serving several bridges (one per action) was two processes of
// one name, whose differing fields conflicted, and two "bridges" on one port.
Deno.test("bridges sharing a container run it once in the appliance", async () => {
  const machine = `pending: on: pay: "charging"
        charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
        settled: on: refund: "refunding"
        refunding: invoke: {src: "refund", onDone: "refunded", onError: "failed"}
        refunded: type: "final"
        failed: type: "final"`;
  const appliance = '{srcs: ["/usr/local/bin/fetch"], command: ["/usr/local/bin/fetch", "--listen", "127.0.0.1:8091"], port: 8091}';
  const code = paymentProgram({ machine }).replace("targets: []", 'targets: ["docker"]').replace(
    'sink: {origin: "https://api.acquirer.example", idempotent: true}',
    'sink: {bridge: "fetch", idempotent: false}\n      reentry: "repeat"',
  ) +
    `\napp: state: effects: refund: {input: {amount: "NEW.total"}, sink: {bridge: "fetch-refund", idempotent: false}, reentry: "repeat", note: "a repeated refund request is harmless"}\n` +
    `app: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\n` +
    `app: state: bridges: fetch: {container: "transport", targets: ["docker"], appliance: ${appliance}}\n` +
    `app: state: bridges: "fetch-refund": {container: "transport", targets: ["docker"], appliance: ${appliance}}\n` +
    `_cluster: surface: targets: transport: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}\n`;
  const rd = await releaseDocker(code);
  assertEquals(rd.deps.filter((d) => d === ":transport-appliance:outs").length, 1, `${rd.deps}`);
  assertEquals(rd.dockerfile.copy.filter((c) => c.from?.ref === ":transport-appliance").length, 1);
  const overlay = overlayOf(rd).processes;
  assertStringIncludes(overlay.transport.command, "'127.0.0.1:8091'");
  for (const b of ["FETCH", "FETCH_REFUND"]) assert(overlay["airlock-mesh"].environment!.includes(`BRIDGE_${b}_URL=http://transport:8091`), `${b}: ${overlay["airlock-mesh"].environment}`);
  assertStringIncludes(rd.dockerfile.epilogue.find((l) => l.includes("is one an appliance process takes"))!, 'ports="8091"');
  assertStringIncludes(rd.dockerfile.epilogue.join("\n"), "airlock-mesh airlock transport;");
});

// A program with the AI capability and no effects released before the
// gateway's refusal, which then fired on the capability alone.
Deno.test("a program with the AI capability and no effects releases the appliance", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["docker"]').replace("capabilities: {hatches: {}", 'capabilities: {ai: {text: ["browser"]}, hatches: {}')
    .replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "").replace(/charging: invoke: \{[\s\S]*?\n        \}/, 'charging: on: settle: "settled"');
  const rd = await releaseDocker(code);
  assert(!rd.dockerfile.preamble.some((l) => l.includes("does not yet run the AI gateway")), "refused without an effect through the gateway");
});

// The overlay spelled the daprd's, the airlock's and the ticker's ports apart
// from the list a bridge is checked against.
Deno.test("the overlay's ports are the ones a bridge is refused", async () => {
  const ports = await exportJson("ports", `package test\nimport mecha "bonisoft.org/plugins/pronto/clusters:mecha"\nports: mecha.#AppliancePort\n`);
  assertEquals(ports.success, true, ports.stderr);
  const rd = await releaseDocker(paymentProgram().replace("targets: []", 'targets: ["docker"]'));
  const overlay = overlayOf(rd).processes;
  assertStringIncludes(overlay["airlock-mesh"].command, `'--dapr-http-port' '${ports.value.meshHttp}'`);
  assertStringIncludes(overlay["airlock-mesh"].command, `'--dapr-grpc-port' '${ports.value.meshGrpc}'`);
  assert(overlay.airlock.environment!.includes(`PORT=${ports.value.airlock}`), `${overlay.airlock.environment}`);
});

// The clock logged a refused poke and kept looping: a wrong SERVICE_JWT swept
// nothing while the container looked healthy.
Deno.test("the appliance's clock ends on a refused poke, so it restarts", async () => {
  const code = paymentProgram({ machine: `pending: after: "1000": "expired"\n        expired: type: "final"` })
    .replace("targets: []", 'targets: ["docker"]').replace("clocks: []", 'clocks: ["docker"]').replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "");
  const rd = await releaseDocker(code);
  const line = rd.dockerfile.preamble.find((l) => l.startsWith("RUN ") && l.includes("> /usr/local/bin/appliance-clock.sh"))!;
  assertStringIncludes(line, "exit 1");
  assert(!line.includes('|| echo "clock: poke failed"'), "the clock swallows a refused poke");
  assertEquals(overlayOf(rd).processes.clock.availability?.restart, "on_failure");
});
