import { startWorker } from "../../../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts";
const here = new URL(".", import.meta.url);
const state = await Deno.makeTempDir({ prefix: "duckstream-workerd-" });
const worker = await startWorker(
  new URL(".build/wrangler.json", here),
  `${state}/state`,
);
async function verify(name: string) {
  const path = new URL(`.build/${name}.json`, here);
  const check = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("verify.ts", here).pathname,
      worker.origin,
      path.pathname,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!check.success) throw Error(`Verification failed: ${name}`);
  return JSON.parse(await Deno.readTextFile(path));
}
try {
  const before = await verify("before-restart");
  await worker.restart();
  const after = await verify("after-restart");
  if (after.results[0].runs !== before.results.at(-1).runs + 1) {
    throw Error("Durable counter lost across restart");
  }
  await Deno.writeTextFile(
    new URL(".build/results.json", here),
    JSON.stringify(
      {
        before: before.results,
        after: after.results,
        restartPreservedCounter: true,
        exactRowsVerified: true,
        invalidFixtureRejected: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await worker.stop();
}
console.log(
  `PASS: local workerd, static modules, JSON/ICU, joins, aggregates, mutations, repeat, restart; logs: ${state}`,
);
