import { basename, dirname, resolve } from "node:path";
import { exists, ifMissing } from "./missing.ts";
import { type LiveStatic, prepareLiveTree } from "./live-tree.ts";

type Service = Record<string, unknown> & {
  environment?: Record<string, string>;
  volumes?: { target: string; [key: string]: unknown }[];
};
type Compose = { services: Record<string, Service>; [key: string]: unknown };

export type PresentationConfig = {
  dockerfile: string;
  caddyfile: string;
  caddy: { watch: { path: string; action: string; target?: string }[] };
  render: { watch: { path: string; action: string; target?: string }[] };
};

export function sourceSyncRules(sources: LiveStatic[]) {
  const groups = new Map<
    string,
    { path: string; target: string; files: Set<string> }
  >();
  const files: {
    action: string;
    path: string;
    target: string;
    initial_sync: boolean;
  }[] = [];
  for (const { source, target } of sources) {
    const name = basename(source);
    if (name !== basename(target) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      files.push({
        action: "sync",
        path: source,
        target: `/pronto/.pronto/live${target}`,
        initial_sync: true,
      });
      continue;
    }
    const path = dirname(source);
    const destination = `/pronto/.pronto/live${dirname(target)}`;
    const key = JSON.stringify([path, destination]);
    let group = groups.get(key);
    if (!group) {
      group = { path, target: destination, files: new Set() };
      groups.set(key, group);
    }
    group.files.add(name);
  }
  const directories = [...groups.values()].map(({ path, target, files }) => {
    const include = [...files].sort();
    return {
      action: "sync",
      path,
      target,
      initial_sync: true,
      include,
      // Compose's initial directory sync applies ignore but not include.
      ignore: ["**", ...include.map((name) => `!${name}`)],
    };
  });
  return [...directories, ...files];
}

export function developmentCompose(
  config: Compose,
  app: string,
  root: string,
  presentation: PresentationConfig,
  certificates: boolean,
  sources: LiveStatic[] = [],
): Compose {
  const out = structuredClone(config);
  const door = out.services[`${app}-caddy`];
  if (door === undefined) {
    throw new Error(`compose has no ${app}-caddy service`);
  }
  const develop = (part: "caddy" | "render") => ({
    watch: presentation[part].watch.map((rule) => ({
      ...rule,
      path: resolve(root, ".bayt", rule.path),
    })),
  });
  door.build = {
    context: root,
    dockerfile_inline: presentation.dockerfile,
    target: "caddy",
  };
  door.image = `${door.image}-presentation`;
  door.entrypoint = [
    "caddy",
    "run",
    "--config",
    `/pronto/${presentation.caddyfile}`,
    "--adapter",
    "caddyfile",
  ];
  door.command = [];
  const caddy = develop("caddy");
  caddy.watch.push(...sourceSyncRules(sources));
  door.develop = caddy;
  door.environment = {
    ...door.environment,
    PRONTO_SRV_ROOT: "/pronto/.pronto/live/srv",
    PRONTO_OMNISHELL_ROOT: "/pronto/.pronto/live/omnishell",
    CADDY_TLS: certificates
      ? "/pronto/.certs/localhost.pem /pronto/.certs/localhost-key.pem"
      : "internal",
    PRONTO_RELEASE_SCRIPTS: "",
    PRONTO_FILE_MODE: "development",
    CADDY_TLS_HOST_PORT:
      new URL(door.environment?.ORIGIN ?? "https://localhost:8443").port ||
      "443",
  };
  door.healthcheck = {
    test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/health"],
    interval: "1s",
    timeout: "5s",
    retries: 30,
  };
  const render = out.services[`${app}-render`];
  if (render !== undefined) {
    render.environment = {
      ...render.environment,
      ENTRY: "/render/shell/index.html",
      PRONTO_PRESENTATION_WATCH: "1",
    };
    render.develop = develop("render");
  }
  return out;
}

async function launch(args: string[]): Promise<void> {
  const where = await new Deno.Command("mise", {
    args: ["where", "github:bonisoft3/sayt"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!where.success) throw new Error("cannot resolve sayt");
  const sayt = new TextDecoder().decode(where.stdout).trim();
  if (!args.includes("--watch")) {
    const run = await new Deno.Command("mise", {
      args: [
        "tool-stub",
        `${sayt}/nu.toml`,
        "-I",
        sayt,
        "-c",
        "use launch.nu; launch ...($env.PRONTO_LAUNCH_ARGS | from json)",
      ],
      env: { MISE_LOCKED: "0", PRONTO_LAUNCH_ARGS: JSON.stringify(args) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    Deno.exit(run.code);
  }
  const compose = (more: string[], piped = false, signal?: AbortSignal) =>
    new Deno.Command("mise", {
      args: ["tool-stub", `${sayt}/compose.toml`, ...more],
      signal,
      env: {
        MISE_LOCKED: "0",
        COMPOSE_BAKE: "true",
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
      },
      stdin: "inherit",
      stdout: piped ? "piped" : "inherit",
      stderr: piped ? "piped" : "inherit",
    });
  const resolved = await compose(["config", "--format", "json"], true).output();
  if (!resolved.success) {
    throw new Error(
      `cannot resolve development compose: ${
        new TextDecoder().decode(resolved.stderr)
      }`,
    );
  }
  const manifest = JSON.parse(await Deno.readTextFile(".bayt/bayt.caddy.json"));
  const certificates = await exists(".certs/localhost.pem") &&
    await exists(".certs/localhost-key.pem");
  await Deno.mkdir(".certs", { recursive: true });
  const sources: LiveStatic[] = JSON.parse(
    await Deno.readTextFile(".pronto/live/sources.json"),
  );
  await prepareLiveTree(resolve(".pronto/live"), sources);
  const config = developmentCompose(
    JSON.parse(new TextDecoder().decode(resolved.stdout)),
    manifest.project,
    Deno.cwd(),
    JSON.parse(await Deno.readTextFile(".bayt/presentation.json")),
    certificates,
    sources,
  );
  const path = resolve(".pronto/live/compose.json");
  await Deno.writeTextFile(path, JSON.stringify(config));
  const down = await compose([
    "-f",
    path,
    "down",
    "-v",
    "--timeout",
    "0",
    "--remove-orphans",
  ]).output();
  if (!down.success) throw new Error("development compose down failed");
  const tokenFile = resolve(".pronto/live/readiness/token");
  await Deno.mkdir(dirname(tokenFile), { recursive: true });
  await ifMissing(Deno.remove(tokenFile), undefined);
  await Deno.writeTextFile(tokenFile, crypto.randomUUID());
  const server = compose([
    "-f",
    path,
    "up",
    `${manifest.project}-launch`,
    "--build",
    "--force-recreate",
    "--remove-orphans",
    "--attach-dependencies",
    "--watch",
    ...args.filter((a) => a !== "--watch"),
  ]).spawn();
  const children = [server].map((child) => {
    let done = false;
    const status = child.status.then((s) => {
      done = true;
      return s;
    });
    return {
      status,
      stop: () => {
        if (!done) child.kill("SIGTERM");
      },
    };
  });
  const probeStop = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    probeStop.abort();
    for (const child of children) child.stop();
  };
  Deno.addSignalListener("SIGINT", stop);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);
  const synchronized = (async () => {
    const deadline = performance.now() + 300_000;
    let initial = true;
    while (!stopping) {
      const token = await ifMissing(Deno.readTextFile(tokenFile), null);
      if (token !== null) {
        const timeout = AbortSignal.timeout(5000);
        const result = await compose(
          [
            "-f",
            path,
            "exec",
            "-T",
            `${manifest.project}-caddy`,
            "cat",
            "/pronto/.pronto/live/readiness/token",
          ],
          true,
          AbortSignal.any([probeStop.signal, timeout]),
        ).output().catch((error) => {
          if (timeout.aborted && !probeStop.signal.aborted) return null;
          throw error;
        });
        if (
          result?.success && new TextDecoder().decode(result.stdout) === token
        ) {
          // Initial synchronization does not exercise the live event path.
          if (initial) {
            initial = false;
            await Deno.writeTextFile(tokenFile, crypto.randomUUID());
            continue;
          }
          console.error("pronto launch: presentation sync ready");
          return null;
        }
      }
      if (performance.now() >= deadline) {
        throw new Error(
          "presentation synchronization did not become ready within five minutes",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  })().catch((error) => {
    if (probeStop.signal.aborted) return null;
    throw error;
  });
  let failure: unknown;
  try {
    let first = await Promise.race([
      ...children.map((c) => c.status),
      synchronized,
    ]);
    if (first === null) {
      first = await Promise.race(children.map((c) => c.status));
    }
    const interrupted = stopping;
    stop();
    await Promise.all(children.map((c) => c.status));
    if (!first.success && !interrupted) {
      throw new Error(`development launch exited ${first.code}`);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.removeSignalListener("SIGTERM", stop);
    stop();
    await Promise.all(children.map((c) => c.status));
    try {
      await synchronized;
    } finally {
      try {
        const stopped = await compose(["-f", path, "stop", "--timeout", "5"]).output();
        if (!stopped.success) throw new Error("development compose stop failed");
      } catch (error) {
        if (failure !== undefined) {
          throw new AggregateError([failure, error], "development launch and cleanup failed");
        }
        throw error;
      }
    }
  }
}

if (import.meta.main) {
  const args = Deno.args.length > 0
    ? Deno.args
    : Deno.env.get("SAYT_TASK_VERB") === "launch"
    ? JSON.parse(Deno.env.get("SAYT_TASK_ARGS") ?? "[]")
    : [];
  await launch(args);
}
