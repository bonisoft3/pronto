// The docker appliance target (docs/release-targets.md#docker): single-container
// image running PostgreSQL 18, PostgREST, Caddy, Auth, and process-compose.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
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
