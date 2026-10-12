import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";
import { projectSay, type Sources } from "./project-config.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function exported(): Promise<unknown> {
  const result = await new Deno.Command("cue", {
    args: ["export", ".", "-e", "configSeats", "--out", "json"],
    cwd: fileURLToPath(new URL("./testdata/emit", import.meta.url)), stdout: "piped", stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

Deno.test("consumer configuration follows the emitted source seats and preserves real rule conflicts", async () => {
  const seats = await exported() as {sources: Sources; build: string; terminal: string; installed: Record<string, unknown>};
  const app = await Deno.makeTempDir({dir: repo, prefix: ".project-config-"});
  try {
    await Deno.mkdir(`${app}/pronto`);
    await Deno.writeTextFile(`${app}/pronto/config.cue`, `package consumer
import (
  "bonisoft.org/plugins/pronto/distribution"
  terminal "bonisoft.org/plugins/pronto/terminals:omnishell"
  builder "bonisoft.org/plugins/pronto/builders:bayt"
)
pronto: distribution.#Project & terminal.#Project & builder.#Toolchain
pronto: say: say: generate: rulemap: custom: {priority: 3, cmds: [{do: "print custom"}]}
`);
    const treeProgram = {say: {build: {do: seats.build}, generate: {rulemap: {omnishell: {cmds: [{do: seats.terminal}]}}}}};
    const tree = await projectSay(app, treeProgram, seats.sources) as {
      say: {build: {do: string}; generate: {rulemap: Record<string, {cmds: {do: string}[]}>}};
    };
    assertEquals(tree.say.build.do, seats.build);
    assertEquals(tree.say.generate.rulemap.omnishell.cmds[0].do, seats.terminal);
    assertEquals(tree.say.generate.rulemap.pronto.cmds[0].do, seats.build);
    assertEquals(tree.say.generate.rulemap.custom.cmds[0].do, "print custom");
    assertStringIncludes(tree.say.build.do, "../../plugins/pronto");
    const installed = await projectSay(app, seats.installed) as typeof tree;
    assertStringIncludes(installed.say.generate.rulemap.omnishell.cmds[0].do, "run-mise exec -- omnishell mode .");
    assertStringIncludes(installed.say.generate.rulemap.pronto.cmds[0].do, 'sources: pronto: ""');
    await assertRejects(() => projectSay(app, {say: {build: {do: "print conflicting"}}}, seats.sources), Error,
      "consumer configuration conflicts with the program's Sayt rules");
  } finally {
    await Deno.remove(app, {recursive: true});
  }
});
