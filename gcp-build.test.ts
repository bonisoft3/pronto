import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";

Deno.test("Cloud Build archives monorepo app files and reuses only matching sources", async () => {
  const root = await Deno.makeTempDir({ prefix: "pronto-gcp-build-" });
  const app = `${root}/repo/apps/example`;
  const bin = `${root}/bin`;
  const state = `${root}/state`;
  const digest = `sha256:${"a".repeat(64)}`;
  const run = async (cmd: string, args: string[], cwd = app) => {
    const result = await new Deno.Command(cmd, {
      args, cwd, env: { PATH: `${bin}:${Deno.env.get("PATH")}`, MOCK_STATE: state, MOCK_DIGEST: digest },
      stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  try {
    await Deno.mkdir(app, { recursive: true });
    await Deno.mkdir(bin);
    await Deno.mkdir(state);
    await Deno.writeTextFile(`${app}/compose.yaml`, "services: {}\n");
    await Deno.writeTextFile(`${app}/input.txt`, "first\n");
    await Deno.writeTextFile(`${bin}/gcloud`, `#!/bin/sh
set -eu
[ "$1" = --quiet ] && shift
case "$1 $2 $3" in
  'artifacts docker images')
    ref=$5
    case "$ref" in
      *:src-*) [ -f "$MOCK_STATE/\${ref##*:}" ] || { echo NOT_FOUND >&2; exit 1; } ;;
    esac
    printf '%s\\n' "$MOCK_DIGEST" ;;
  'artifacts docker tags')
    ref=$6
    touch "$MOCK_STATE/\${ref##*:}" ;;
  'projects describe '*) printf '123456\\n' ;;
  'builds submit '*)
    cp "$3" "$MOCK_STATE/source.tgz"
    cp "$5" "$MOCK_STATE/cloudbuild.yaml"
    echo build >> "$MOCK_STATE/builds"
    echo build-id ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
    await run("git", ["init", "-q", `${root}/repo`]);
    await run("git", ["add", "."]);
    const build = new URL("./gcp/build.nu", import.meta.url).pathname;
    const command = `use ${JSON.stringify(build)} [push-images]; push-images ${JSON.stringify(app)} {project: "fixture", registry: "us-central1-docker.pkg.dev/fixture/pronto"} example [database migrate schema] | to json`;
    assertStringIncludes(await run("nu", ["-c", command]), digest);
    const archive = await run("tar", ["-tzf", `${state}/source.tgz`]);
    assertStringIncludes(archive, "input.txt");
    assertStringIncludes(archive, ".pronto-schema.bake.json");
    assertEquals(await Deno.readTextFile(`${state}/builds`), "build\n");
    assertStringIncludes(await run("nu", ["-c", command]), "reusing them");
    assertEquals(await Deno.readTextFile(`${state}/builds`), "build\n");
    await Deno.writeTextFile(`${app}/input.txt`, "changed without a commit\n");
    await run("nu", ["-c", command]);
    assertEquals(await Deno.readTextFile(`${state}/builds`), "build\nbuild\n");
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${app}/input.txt`, 0o755);
      await run("nu", ["-c", command]);
      assertEquals(await Deno.readTextFile(`${state}/builds`), "build\nbuild\nbuild\n");
    }
    const verify = new URL("./gcp/verify.nu", import.meta.url).pathname;
    await run("nu", ["-c", `use ${JSON.stringify(verify)} [start-drivers]; start-drivers ${JSON.stringify(app)} {project: "fixture", region: "us-central1", service: "example-rc", registry: "us-central1-docker.pkg.dev/fixture/pronto"}`]);
    const config = `${state}/cloudbuild.yaml`;
    const script = await run("nu", ["-c", `open ${JSON.stringify(config)} | get steps.0.args.1 | str replace -a '$$' '$'`]);
    assertStringIncludes(await Deno.readTextFile(config), "https://example-rc-123456.us-central1.run.app");
    assertStringIncludes(script, "waiting for the service");
    await Deno.writeTextFile(`${state}/drivers.sh`, script);
    await run("sh", ["-n", `${state}/drivers.sh`]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deleting a preview invalidates its infrastructure setup cache", async () => {
  const root = await Deno.makeTempDir({ prefix: "pronto-gcp-delete-" });
  try {
    await Deno.writeTextFile(`${root}/gcloud`, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_CALLS"
`, { mode: 0o755 });
    const release = new URL("./gcp/release.nu", import.meta.url).pathname;
    const result = await new Deno.Command("nu", {
      args: ["-c", `source ${JSON.stringify(release)}; delete-preview {project: "fixture", region: "us-central1", service: "app-rc", preview: "rc", names: {job: "app-rc-initdb", migrateJob: "app-rc-migrate", instance: "app-rc-db", clock: "app-rc-clock", secrets: {PASSWORD: "app-rc-password"}}}`],
      env: { PATH: `${root}:${Deno.env.get("PATH")}`, MOCK_CALLS: `${root}/calls` },
      stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    const calls = await Deno.readTextFile(`${root}/calls`);
    assertStringIncludes(calls, "secrets delete app-rc-password --project fixture");
    assertStringIncludes(calls, "secrets delete app-rc-setup --project fixture");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
