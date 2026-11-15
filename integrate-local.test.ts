// integrate@local's secrets check (gcp/secrets.nu) and INTEGRATE_LOCAL_SECRETS, against a `nu` on
// PATH that logs what it was asked and fails: the run stops before any stack starts.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11"

const script = new URL("./integrate-local.ts", import.meta.url).pathname

const run = async (secrets?: string) => {
  const dir = await Deno.makeTempDir()
  const app = `${dir}/app`
  const bin = `${dir}/bin`
  await Deno.mkdir(app)
  await Deno.mkdir(bin)
  await Deno.mkdir(`${dir}/omnishell`)
  await Deno.writeTextFile(`${bin}/nu`, `#!/bin/sh\necho "$*" >> "${dir}/nu.log"\nexit 1\n`, { mode: 0o755 })
  const env: Record<string, string> = { PATH: `${bin}:${Deno.env.get("PATH")}` }
  if (secrets !== undefined) env.INTEGRATE_LOCAL_SECRETS = secrets
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script, app, "--omnishell", `${dir}/omnishell`, "--settle", "1"],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const log = await Deno.readTextFile(`${dir}/nu.log`).catch(() => "")
  return { success: out.success, stderr: new TextDecoder().decode(out.stderr), log }
}

Deno.test("integrate@local checks the release's secrets unless INTEGRATE_LOCAL_SECRETS is skip", async () => {
  const checked = await run()
  assert(!checked.success)
  assertStringIncludes(checked.log, "secrets.nu check")
  assertStringIncludes(checked.stderr, "check-secrets failed")

  const skipped = await run("skip")
  assertEquals(skipped.log.includes("secrets.nu"), false)
  assertStringIncludes(skipped.stderr, "check-secrets skipped (INTEGRATE_LOCAL_SECRETS=skip)")
})

Deno.test("integrate@local refuses an INTEGRATE_LOCAL_SECRETS other than skip", async () => {
  const r = await run("off")
  assert(!r.success)
  assertStringIncludes(r.stderr, `INTEGRATE_LOCAL_SECRETS is "off": it is unset or "skip"`)
  assertEquals(r.log, "")
})
