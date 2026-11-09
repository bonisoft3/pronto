import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";
import { projectGates, projectSay } from "./project-config.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function exported(): Promise<unknown> {
  const result = await new Deno.Command("cue", {
    args: ["export", ".", "-e", "configSeats", "--out", "json"],
    cwd: fileURLToPath(new URL("./testdata/emit", import.meta.url)),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

// Every command finds its runtime with mise as it runs, so the files the
// monorepo commits serve the app's mirror unchanged; a checkout's
// mise.local.toml is what sends mise to the trees.
Deno.test("consumer configuration follows the emitted seats and preserves real rule conflicts", async () => {
  const seats = await exported() as {
    generate: string;
    build: string;
    terminal: string;
    generateDockerfile: string;
    buildDockerfile: string;
    checkDockerfile: string;
  };
  assertStringIncludes(
    seats.checkDockerfile,
    "COPY --from=plugins_omnishell-runtime-image / /omnishell",
  );
  const run = (dockerfile: string) => {
    const line = dockerfile.split("\n").find((candidate) =>
      candidate.startsWith("RUN [")
    );
    if (line === undefined) {
      throw new Error("rendered Dockerfile has no executable RUN");
    }
    return JSON.parse(line.slice(4));
  };
  assertEquals(run(seats.generateDockerfile), [
    "nu",
    "-c",
    "mise x -- ^deno run --config ((^mise where github:bonisoft3/pronto | str trim) | path join deno.json) --allow-read --allow-write=. --allow-run --allow-env ((^mise where github:bonisoft3/pronto | str trim) | path join write.ts) .",
  ]);
  assertEquals(run(seats.buildDockerfile), [
    "nu",
    "-c",
    "mise x -- ^nu -I (^mise where github:bonisoft3/sayt | str trim) -c 'use task-leaf.nu; task-leaf build'",
  ]);
  for (const dockerfile of [seats.generateDockerfile, seats.buildDockerfile, seats.checkDockerfile]) {
    if (dockerfile.includes("../../plugins")) throw new Error(`a command names the monorepo:\n${dockerfile}`);
  }
  const app = await Deno.makeTempDir({ dir: repo, prefix: ".project-config-" });
  try {
    await Deno.mkdir(`${app}/pronto`);
    await Deno.writeTextFile(
      `${app}/pronto/config.cue`,
      `package consumer
import (
  "bonisoft.org/plugins/pronto/distribution"
  terminal "bonisoft.org/plugins/pronto/terminals:omnishell"
  builder "bonisoft.org/plugins/pronto/builders:bayt"
)
pronto: distribution.#Project & terminal.#Project & builder.#Toolchain
pronto: say: say: generate: rulemap: custom: {priority: 3, cmds: [{do: "print custom"}]}
`,
    );
    const treeProgram = {
      say: {
        build: { do: seats.build },
        generate: {
          rulemap: {
            omnishell: { cmds: [{ do: seats.terminal }] },
            pronto: { cmds: [{ do: seats.generate }] },
          },
        },
      },
    };
    const merged = await projectSay(app, treeProgram) as {
      say: {
        build: { do: string };
        generate: { rulemap: Record<string, { cmds: { do: string }[] }> };
      };
    };
    assertEquals(merged.say.build.do, "null");
    assertEquals(
      merged.say.generate.rulemap.omnishell.cmds[0].do,
      seats.terminal,
    );
    assertEquals(merged.say.generate.rulemap.pronto.cmds[0].do, seats.generate);
    assertEquals(merged.say.generate.rulemap.custom.cmds[0].do, "print custom");
    assertStringIncludes(seats.generate, "run-mise where github:bonisoft3/pronto");
    assertStringIncludes(seats.terminal, "run-mise exec -- omnishell mode .");
    await assertRejects(
      () =>
        projectSay(
          app,
          { say: { build: { do: "print conflicting" } } },
        ),
      Error,
      "consumer configuration conflicts with the program's Sayt rules",
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("gates retain options and delegate every declared platform to the raw leaf", () => {
  const cmd = { use: "./bayt-task.nu", do: "bayt-task test --generate" };
  const raw = { test: { args: "default", keep_going: true, flags: "--platform browser", rulemap: {
    custom: { platform: "browser", cmds: [{ do: "custom-check" }] },
  } }, verify: { do: "original-verify" } };
  const projected = projectGates(raw, { lint: { rulemap: { builtin: { stop: true, cmds: [cmd] } } }, test: { rulemap: { builtin: { stop: true, cmds: [cmd] } } } });
  assertEquals(projected.say.test, { keep_going: true, flags: "--platform browser", rulemap: {
    builtin: { stop: true, cmds: [cmd] },
    "platform-0": { stop: true, cmds: [cmd], platform: "browser", priority: -1 },
  } });
  assertEquals(projected.say.verify, raw.verify);
  assertEquals(projected.say.lint, { rulemap: { builtin: { stop: true, cmds: [cmd] } } });
  assertEquals(raw.test.args, "default");
  assertEquals(Object.keys(projected.gates), ["lint", "test"]);
});

Deno.test("gates without builtin merge platform rules alongside the check's own rulemap", () => {
  const mkcert = { do: "mkcert" };
  const launchLocal = { platform: "local", stop: true, cmds: [{ use: "./bayt-task.nu", do: "bayt-task launch --generate" }] };
  const raw = { launch: { rulemap: { builtin: { cmds: [mkcert] } } } };
  const projected = projectGates(raw, { launch: { rulemap: { local: launchLocal } } });
  assertEquals(projected.say.launch, {
    rulemap: {
      builtin: { cmds: [mkcert] },
      local: launchLocal,
    },
  });
  assertEquals(projected.gates.launch, {
    rulemap: {
      local: launchLocal,
    },
  });
});
