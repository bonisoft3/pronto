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
  // The app's compose project, as `docker compose config` prints it: no services, so every image is
  // keyed by the whole app. Never the real docker.
  if (Deno.build.os !== "windows") await Deno.writeTextFile(`${bin}/docker`, `#!/bin/sh\necho '{"services": {}}'\n`, { mode: 0o755 });
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

// A gcloud that fails `fails` times with `error`, then answers: the calls it saw are counted.
async function flakyGcloud(dir: string, error: string, fails: number) {
  await Deno.writeTextFile(`${dir}/gcloud`, `#!/bin/sh
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "${dir}/count"
if [ "$n" -lt ${fails} ]; then echo "${error}" >&2; exit 1; fi
echo answered
`, { mode: 0o755 });
}

async function nuWith(dir: string, script: string, fails: number, error: string) {
  await Deno.remove(`${dir}/count`).catch(() => {});
  await flakyGcloud(dir, error, fails);
  const result = await new Deno.Command("nu", {
    args: ["-c", script],
    env: { PATH: `${dir}${delimiter}${Deno.env.get("PATH")}` },
    stdout: "piped", stderr: "piped",
  }).output();
  const calls = Number(await Deno.readTextFile(`${dir}/count`));
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr), calls };
}

Deno.test("a gcloud read that did not reach Google is asked again; a write never is", { ignore: Deno.build.os === "windows" }, async () => {
  const dir = await Deno.makeTempDir({ prefix: "pronto-gcp-again-" });
  const build = JSON.stringify(fileURLToPath(new URL("./gcp/build.nu", import.meta.url)));
  const dns = "NameResolutionError: Failed to resolve 'cloudbuild.googleapis.com'";
  try {
    const read = await nuWith(dir, `use ${build} [gc]; gc builds describe abc`, 1, dns);
    assertEquals(read.ok, true, read.err);
    assertEquals(read.out, "answered");
    assertEquals(read.calls, 2);
    const write = await nuWith(dir, `use ${build} [gc]; gc secrets create s`, 1, dns);
    assertEquals(write.ok, false);
    assertEquals(write.calls, 1);
    const other = await nuWith(dir, `use ${build} [gc]; gc builds describe abc`, 1, "PERMISSION_DENIED");
    assertEquals(other.ok, false);
    assertEquals(other.calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a grant to an account made a moment before is asked again until IAM knows it", { ignore: Deno.build.os === "windows" }, async () => {
  const dir = await Deno.makeTempDir({ prefix: "pronto-gcp-fresh-" });
  const release = JSON.stringify(fileURLToPath(new URL("./gcp/release.nu", import.meta.url)));
  try {
    const late = await nuWith(dir, `source ${release}; gc-fresh projects add-iam-policy-binding p`, 1, "Service account x does not exist");
    assertEquals(late.ok, true, late.err);
    assertEquals(late.calls, 2);
    const refused = await nuWith(dir, `source ${release}; gc-fresh projects add-iam-policy-binding p`, 1, "PERMISSION_DENIED");
    assertEquals(refused.ok, false);
    assertEquals(refused.calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A bucket of objects on disk behind a gcloud that does what the release lock asks of storage: an
// object made only where none is (a 412 where one is), described, read and removed.
async function storageGcloud(dir: string) {
  await Deno.writeTextFile(`${dir}/gcloud`, `#!/bin/sh
[ "$1" = "--quiet" ] && shift
obj() { echo "${dir}/objects/$(echo "$1" | tr '/:' '__')"; }
case "$1 $2 $3" in
  "storage buckets describe") exit 0 ;;
  "storage cp "*) if [ -e "$(obj "$4")" ]; then echo "HTTPError 412: At least one of the pre-conditions you specified did not hold." >&2; exit 1; fi
    mkdir -p "${dir}/objects"; cp "$3" "$(obj "$4")" ;;
  "storage objects describe") echo 7 ;;
  "storage cat "*) cat "$(obj "$3")" ;;
  "storage rm "*) rm -f "$(obj "$3")" ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
}

Deno.test("an app's release holds a lock: another is refused until it ends or expires", { ignore: Deno.build.os === "windows" }, async () => {
  const dir = await Deno.makeTempDir({ prefix: "pronto-gcp-lock-" });
  const release = JSON.stringify(fileURLToPath(new URL("./gcp/release.nu", import.meta.url)));
  const lock = `{bucket: "gs://p-release-locks", object: "gs://p-release-locks/app", key: "app", project: "p", region: "us-central1"}`;
  const nu = async (script: string, env: Record<string, string> = {}) => {
    const r = await new Deno.Command("nu", {
      args: ["-c", `source ${release}; ${script}`],
      env: { PATH: `${dir}${delimiter}${Deno.env.get("PATH")}`, ...env }, stdout: "piped", stderr: "piped",
    }).output();
    return { ok: r.success, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
  };
  try {
    await storageGcloud(dir);
    const first = await nu(`take-lock ${lock} | ignore`);
    assertEquals(first.ok, true, first.err);
    assertStringIncludes(first.out, "release lock taken");
    const held = await nu(`take-lock ${lock} | ignore`);
    assertEquals(held.ok, false);
    assertStringIncludes(held.err, "another release of app is running");
    const broken = await nu(`take-lock ${lock} | ignore`, { PRONTO_RELEASE_BREAK_LOCK: "1" });
    assertEquals(broken.ok, true, broken.err);
    assertStringIncludes(broken.out, "taken over");
    const dropped = await nu(`drop-lock (${lock} | insert generation "7")`);
    assertStringIncludes(dropped.out, "release lock let go");
    // The lock lasts PRONTO_RELEASE_LOCK_MINUTES: made to last none, the next release takes it.
    const brief = await nu(`take-lock ${lock} | ignore`, { PRONTO_RELEASE_LOCK_MINUTES: "0" });
    assertEquals(brief.ok, true, brief.err);
    const expired = await nu(`take-lock ${lock} | ignore`);
    assertEquals(expired.ok, true, expired.err);
    assertStringIncludes(expired.out, "it expired at");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a live Cloud SQL instance is patched to the plan's tier and flags in one call", async () => {
  const release = JSON.stringify(fileURLToPath(new URL("./gcp/release.nu", import.meta.url)));
  const script = `source ${release}
    let plan = {sqlTier: "db-custom-1-3840", sqlFlags: "cloudsql.logical_decoding=on,max_connections=130"}
    let live = {settings: {tier: "db-f1-micro", databaseFlags: [{name: "max_connections", value: "130"}, {name: "cloudsql.logical_decoding", value: "on"}]}}
    [
      (sql-drift $live $plan)
      (sql-drift ($live | upsert settings.tier "db-custom-1-3840") $plan)
      (sql-drift ($live | upsert settings.databaseFlags [{name: "max_connections", value: "50"}]) $plan)
      (sql-drift {settings: {tier: "db-custom-1-3840"}} $plan)
    ] | to json --raw`;
  const result = await new Deno.Command("nu", { args: ["-c", script], stdout: "piped", stderr: "piped" }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
  const flags = "--database-flags cloudsql.logical_decoding=on,max_connections=130".split(" ");
  assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), [
    ["--tier", "db-custom-1-3840"],
    [],
    // Both in one patch: two would restart the database twice.
    ["--tier", "db-custom-1-3840", ...flags],
    flags,
  ]);
});

Deno.test("a heredoc opens at a RUN, COPY or ADD only, not at a shell's shift", async () => {
  const build = fileURLToPath(new URL("./gcp/build.nu", import.meta.url));
  const dockerfile = "FROM x\nENV A=$((1<<2))\nCOPY a /a\nRUN <<EOF\nCOPY inside /x\nEOF\nCOPY b /b\n";
  const out = await new Deno.Command("nu", { args: ["-c", `source ${build}; dockerfile-reads ${JSON.stringify(dockerfile)} | to json --raw`], stdout: "piped", stderr: "piped" }).output();
  assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
  assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), ["a", "b"]);
});

Deno.test("an image's key follows the files its Dockerfile copies: an edit to one image's file moves that image's alone", async () => {
  const app = await Deno.makeTempDir({ prefix: "pronto-gcp-keys-" });
  const real = await Deno.realPath(app);
  const build = fileURLToPath(new URL("./gcp/build.nu", import.meta.url));
  const write = async (f: string, text: string) => { await Deno.mkdir(`${real}/${f}`.replace(/\/[^/]*$/, ""), { recursive: true }); await Deno.writeTextFile(`${real}/${f}`, text); };
  const run = async (cmd: string, args: string[]) => {
    const out = await new Deno.Command(cmd, { args, cwd: real, stdout: "piped", stderr: "piped" }).output();
    assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout);
  };
  try {
    const compose: Record<string, unknown> = {};
    for (const s of ["one", "two"]) {
      await write(`${s}/file.txt`, s);
      await write(`docker/${s}.Dockerfile`, `FROM scratch\nCOPY ${s}/ /app\n`);
      compose[s] = { build: { context: real, dockerfile: `docker/${s}.Dockerfile` } };
    }
    await write("unrelated.txt", "1");
    await write("compose.json", JSON.stringify({ services: compose }));
    await run("git", ["init", "-q"]);
    const list = `${real}-files`;
    const keys = async () => {
      const files = await run("git", ["ls-files", "-co", "--exclude-standard"]);
      await Deno.writeTextFile(list, files.split("\n").filter((f) => f && f !== "compose.json").join("\n"));
      const script = `source ${build}; let h = (file-hashes ${real} ${list}); image-keys ${real} (open ${real}/compose.json) $h "t" [one two] | to json --raw`;
      return JSON.parse(await run("nu", ["-c", script])) as Record<string, string>;
    };
    const before = await keys();
    await write("unrelated.txt", "2");
    assertEquals(await keys(), before, "a file no image copies moves no key");
    await write("one/file.txt", "changed");
    const after = await keys();
    assertEquals(after.one !== before.one, true, "the image that copies the file");
    assertEquals(after.two, before.two, "the other image is reused");
  } finally {
    await Deno.remove(app, { recursive: true });
    await Deno.remove(`${real}-files`).catch(() => {});
  }
});
