// The endowment contract also imports mecha, which is checked at the repo tier.
const excluded = new Set(["endowments_test.ts"]);
const files = [...Deno.readDirSync(".")]
  .filter((entry) => entry.isFile && entry.name.endsWith(".ts") && !excluded.has(entry.name))
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) throw new Error("no Pronto TypeScript files to check");

const result = await new Deno.Command(Deno.execPath(), {
  args: ["check", "--config", "deno.json", ...files],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
if (!result.success) Deno.exit(result.code);
