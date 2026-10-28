import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

async function mockGcloud(bin: string) {
  const script = `${bin}/gcloud-mock.ts`;
  await Deno.writeTextFile(script, `
const args = Deno.args[0] === "--quiet" ? Deno.args.slice(1) : Deno.args;
const state = Deno.env.get("MOCK_STATE");
if (Deno.env.get("MOCK_CALLS")) {
  await Deno.writeTextFile(Deno.env.get("MOCK_CALLS")!, args.join(" ") + "\\n", { append: true });
} else if (args.slice(0, 3).join(" ") === "artifacts docker images") {
  const tag = args[4].split(":").at(-1)!;
  if (tag.startsWith("src-")) {
    try { await Deno.stat(state + "/" + tag); }
    catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      console.error("NOT_FOUND");
      Deno.exit(1);
    }
  }
  console.log(Deno.env.get("MOCK_DIGEST"));
} else if (args.slice(0, 3).join(" ") === "artifacts docker tags") {
  await Deno.writeTextFile(state + "/" + args[5].split(":").at(-1), "");
} else if (args.slice(0, 2).join(" ") === "projects describe") {
  console.log("123456");
} else if (args.slice(0, 2).join(" ") === "builds submit") {
  await Deno.copyFile(args[2], state + "/source.tgz");
  await Deno.copyFile(args[4], state + "/cloudbuild.yaml");
  await Deno.writeTextFile(state + "/builds", "build\\n", { append: true });
  console.log("build-id");
} else {
  console.error("unexpected gcloud call: " + args.join(" "));
  Deno.exit(1);
}
`);
  const deno = Deno.execPath();
  if (Deno.build.os === "windows") {
    await Deno.writeTextFile(`${bin}/gcloud.cmd`, `@"${deno}" run --no-config -A "${script}" %*\r\n`);
  } else {
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    await Deno.writeTextFile(`${bin}/gcloud`, `#!/bin/sh\nexec ${quote(deno)} run --no-config -A ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
}

Deno.test("Cloud Build archives monorepo app files and reuses only matching sources", async () => {
  const root = await Deno.makeTempDir({ prefix: "pronto-gcp-build-" });
  const app = `${root}/repo/apps/example`;
  const bin = `${root}/bin`;
  const state = `${root}/state`;
  const digest = `sha256:${"a".repeat(64)}`;
  const run = async (cmd: string, args: string[], cwd = app) => {
    const result = await new Deno.Command(cmd, {
      args, cwd, env: { PATH: `${bin}${delimiter}${Deno.env.get("PATH")}`, MOCK_STATE: state, MOCK_DIGEST: digest },
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
    await mockGcloud(bin);
    await run("git", ["init", "-q", `${root}/repo`]);
    await run("git", ["add", "."]);
    const build = fileURLToPath(new URL("./gcp/build.nu", import.meta.url));
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
    const verify = fileURLToPath(new URL("./gcp/verify.nu", import.meta.url));
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
    await mockGcloud(root);
    const release = fileURLToPath(new URL("./gcp/release.nu", import.meta.url));
    const result = await new Deno.Command("nu", {
      args: ["-c", `source ${JSON.stringify(release)}; delete-preview {project: "fixture", region: "us-central1", service: "app-rc", preview: "rc", names: {job: "app-rc-initdb", migrateJob: "app-rc-migrate", instance: "app-rc-db", clock: "app-rc-clock", secrets: {PASSWORD: "app-rc-password"}}}`],
      env: { PATH: `${root}${delimiter}${Deno.env.get("PATH")}`, MOCK_CALLS: `${root}/calls` },
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
