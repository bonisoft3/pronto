import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";

Deno.test("non-watch launch invokes the sayt nu tool-stub with MISE_LOCKED=0", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/bin`, { recursive: true });
    for (const file of ["launch-watch.ts", "missing.ts", "live-tree.ts"]) {
      await Deno.copyFile(
        fileURLToPath(new URL(file, import.meta.url)),
        `${root}/${file}`,
      );
    }
    await Deno.writeTextFile(`${root}/deno.json`, "{}");
    await Deno.writeTextFile(
      `${root}/bin/mise`,
      `#!/bin/sh
if [ "$1" = where ]; then printf '%s/sayt' "${root}"; exit 0; fi
printf '%s\\n' "locked=$MISE_LOCKED" "stub=$2" "args=$PRONTO_LAUNCH_ARGS" > "${root}/observed"
`,
    );
    await Deno.chmod(`${root}/bin/mise`, 0o755);
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        `${root}/deno.json`,
        `${root}/launch-watch.ts`,
        "--port",
        "8080",
      ],
      cwd: root,
      env: { PATH: `${root}/bin:${Deno.env.get("PATH")}`, MISE_LOCKED: "1" },
    }).output();
    assertEquals(out.code, 0);
    assertEquals(
      await Deno.readTextFile(`${root}/observed`),
      `locked=0\nstub=${root}/sayt/nu.toml\nargs=["--port","8080"]\n`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (const mode of ["cancel", "recover", "fail"]) Deno.test({
  cancel: "stopping launch cancels an in-flight Compose readiness probe",
  recover: "launch retries a timed-out readiness probe and then synchronizes",
  fail: "launch preserves the original failure when cleanup also fails",
}[mode]!, async () => {
  const recovery = mode === "recover";
  const failure = mode === "fail";
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  let child: Deno.ChildProcess | undefined;
  let finished = false;
  try {
    for (const dir of ["bin", ".bayt", ".pronto/live"]) {
      await Deno.mkdir(`${root}/${dir}`, { recursive: true });
    }
    for (const file of ["launch-watch.ts", "missing.ts", "live-tree.ts"]) {
      await Deno.copyFile(
        fileURLToPath(new URL(file, import.meta.url)),
        `${root}/${file}`,
      );
    }
    await Deno.writeTextFile(`${root}/deno.json`, "{}");
    await Deno.writeTextFile(
      `${root}/.bayt/bayt.caddy.json`,
      '{"project":"app"}',
    );
    await Deno.writeTextFile(
      `${root}/.bayt/presentation.json`,
      JSON.stringify({
        dockerfile: "FROM scratch AS caddy",
        caddyfile: "Caddyfile",
        caddy: { watch: [] },
        render: { watch: [] },
      }),
    );
    await Deno.writeTextFile(`${root}/.pronto/live/sources.json`, "[]");
    await Deno.writeTextFile(
      `${root}/bin/mise`,
      `#!/bin/sh
if [ "$1" = where ]; then printf '%s' "$PWD"; exit 0; fi
shift 2
if [ "$1" = config ]; then printf '%s' '{"services":{"app-caddy":{"image":"test"}}}'; exit 0; fi
shift 2
case "$1" in
  down) exit 0 ;;
  stop) touch stopped; exit ${failure ? 9 : 0} ;;
  up) ${failure ? "exit 7" : "exec sleep 30"} ;;
  exec)
    if [ ! -f probe.pid ]; then echo $$ > probe.pid; exec sleep 30; fi
    if [ "${recovery}" = true ]; then
      if [ -f responded ]; then touch synchronized; else touch responded; fi
      cat .pronto/live/readiness/token
    else exit 2; fi
    ;;
  *) exit 2 ;;
esac
`,
    );
    await Deno.chmod(`${root}/bin/mise`, 0o755);
    child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        `${root}/deno.json`,
        `${root}/launch-watch.ts`,
        "--watch",
      ],
      cwd: root,
      env: { PATH: `${root}/bin:${Deno.env.get("PATH")}` },
      stdout: "null",
      stderr: failure ? "piped" : "null",
    }).spawn();
    const status = child.status.then((s) => {
      finished = true;
      return s;
    });
    if (failure) {
      const stderr = await new Response(child.stderr).text();
      assertEquals((await status).success, false);
      assertStringIncludes(stderr, "development launch exited 7");
      assertStringIncludes(stderr, "development compose stop failed");
      await Deno.stat(`${root}/stopped`);
      return;
    }
    const deadline = performance.now() + 15000;
    while (true) {
      try {
        await Deno.stat(`${root}/${recovery ? "synchronized" : "probe.pid"}`);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (finished || performance.now() > deadline) {
        throw new Error("readiness probe did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(finished, false, "launch exited before the readiness deadline");
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        status,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("launch did not cancel its probe")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await Deno.stat(`${root}/stopped`);
    const pid = (await Deno.readTextFile(`${root}/probe.pid`)).trim();
    const probe = await new Deno.Command("ps", {
      args: ["-p", pid, "-o", "pid="],
      stdout: "piped",
    }).output();
    assertEquals(probe.stdout.length, 0, "probe survived launch shutdown");
  } finally {
    if (child && !finished) {
      child.kill("SIGKILL");
      await child.status;
    }
    await Deno.remove(root, { recursive: true });
  }
});
