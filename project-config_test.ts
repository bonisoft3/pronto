import { assertEquals } from "jsr:@std/assert@1.0.11";
import { projectGates } from "./project-config.ts";

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
