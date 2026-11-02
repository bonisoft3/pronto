// The ledgers of release@gcp's gates (gcp/local-gate-key.nu): a stamp is found for the tree it
// was made for, and only a deploy-shaped file moves the rc key.

import { assert, assertEquals } from "jsr:@std/assert@1.0.11"

const script = new URL("./gcp/local-gate-key.nu", import.meta.url).pathname

const nu = async (home: string, ...args: string[]) => {
  const out = await new Deno.Command("nu", { args: [script, ...args], env: { HOME: home }, stdout: "piped", stderr: "piped" }).output()
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr))
  return new TextDecoder().decode(out.stdout).trim()
}

Deno.test("a stamp holds for its tree alone; the rc stamp moves only with a deploy-shaped file", async () => {
  const home = await Deno.makeTempDir()
  const repo = await Deno.makeTempDir()
  const app = `${repo}/app`
  await Deno.mkdir(app)
  await Deno.writeTextFile(`${app}/release.cue`, "a")
  await Deno.writeTextFile(`${app}/page.ts`, "b")
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output()
  assertEquals(await nu(home, "passed", app), "false")
  assertEquals(await nu(home, "rc-passed", app), "false")
  await nu(home, "stamp", app)
  await nu(home, "rc-stamp", app)
  assertEquals([await nu(home, "passed", app), await nu(home, "rc-passed", app)], ["true", "true"])
  await Deno.writeTextFile(`${app}/page.ts`, "c")
  assertEquals([await nu(home, "passed", app), await nu(home, "rc-passed", app)], ["false", "true"])
  await Deno.writeTextFile(`${app}/release.cue`, "d")
  assertEquals(await nu(home, "rc-passed", app), "false")
})

Deno.test("a non-ASCII file name is in the key, and a tree whose key cannot be read is not stamped", async () => {
  const home = await Deno.makeTempDir()
  const repo = await Deno.makeTempDir()
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output()
  await Deno.writeTextFile(`${repo}/release.cue`, "a")
  const before = await nu(home, "key", repo)
  await Deno.writeTextFile(`${repo}/ação.txt`, "b")
  assert((await nu(home, "key", repo)) !== before, "a file named ação.txt moves the key")
  await Deno.rename(`${repo}/ação.txt`, `${repo}/outro.txt`)
  assert((await nu(home, "key", repo)) !== before)
  const bare = await Deno.makeTempDir()
  let failed = false
  try { await nu(home, "stamp", bare) } catch { failed = true }
  assert(failed, "a directory git cannot read is not stamped")
})
