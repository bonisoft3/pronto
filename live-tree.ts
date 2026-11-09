import { dirname, resolve } from "node:path";
import { ifMissing } from "./missing.ts";

export type LiveStatic = { source: string; target: string };

function destination(root: string, target: string): string {
  if (
    !/^\/(srv|omnishell)\//.test(target) || target.split("/").includes("..")
  ) throw new Error(`unsafe live static target: ${target}`);
  return resolve(root, `.${target}`);
}

export async function prepareLiveTree(
  root: string,
  files: LiveStatic[],
): Promise<void> {
  const manifest = `${root}/manifest.json`;
  const previous: string[] = JSON.parse(
    await ifMissing(Deno.readTextFile(manifest), "[]"),
  );
  for (const target of new Set([...previous, ...files.map((f) => f.target)])) {
    const output = destination(root, target);
    await ifMissing(Deno.remove(output), undefined);
    await ifMissing(Deno.remove(`${output}.etag`), undefined);
  }
  for (const { source, target } of files) {
    const output = destination(root, target);
    await Deno.mkdir(dirname(output), { recursive: true });
    await Deno.copyFile(source, output);
  }
  await Deno.writeTextFile(
    manifest,
    JSON.stringify([...new Set(files.map((f) => f.target))].sort()),
  );
  await Deno.mkdir(`${root}/caddy`, { recursive: true });
  await Deno.writeTextFile(`${root}/caddy/release-scripts`, "");
}
