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

// A pronto install apart: the script and a few runtime files, as mise lays them under its version dir.
const pronto = async (version: string, files: Record<string, string>) => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(`${dir}/gcp`)
  await Deno.copyFile(script, `${dir}/gcp/local-gate-key.nu`)
  const all: Record<string, string> = {
    "plugin.json": "{}", "write.ts": "write", "distribution/config.cue": `#Version: "${version}"\n#Other: "x"\n`,
    "gcp/release.nu": "release", "release-flow.test.ts": "flow", "testdata/fake-cloud.sh": "fake", "docs/a.md": "doc", ...files,
  }
  for (const [f, text] of Object.entries(all)) {
    await Deno.mkdir(`${dir}/${f}`.replace(/\/[^/]*$/, ""), { recursive: true })
    await Deno.writeTextFile(`${dir}/${f}`, text)
  }
  return dir
}

const deployKey = async (dir: string, app: string) => {
  const out = await new Deno.Command("nu", { args: [`${dir}/gcp/local-gate-key.nu`, "deploy-key", app], env: { HOME: dir }, stdout: "piped", stderr: "piped" }).output()
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr))
  return new TextDecoder().decode(out.stdout).trim()
}

const mise = (v: string) => ({
  ".mise.toml": `[tools]\n'github:bonisoft3/mecha' = '1'\n'github:bonisoft3/pronto' = '${v}'\n`,
  "mise.lock": `[[tools."github:bonisoft3/mecha"]]\nversion = "1"\n\n[[tools."github:bonisoft3/pronto"]]\nversion = "${v}"\nbackend = "x"\n\n[tools."github:bonisoft3/pronto"."platforms.linux-x64"]\nchecksum = "sha256:${v}"\n\n[[tools."github:bonisoft3/sayt"]]\nversion = "2"\n`,
  "cue.mod/module.cue": `deps: {\n\t"github.com/bonisoft3/pronto@v0": {\n\t\tv: "v${v}"\n\t}\n\t"github.com/bonisoft3/mecha@v0": {\n\t\tv: "v1"\n\t}\n}\n`,
})

Deno.test("a pronto version whose content differs only in the release engine keeps the deploy key; a changed runtime file or other pin moves it", async () => {
  const repo = await Deno.makeTempDir()
  const app = `${repo}/app`
  await Deno.mkdir(`${app}/cue.mod`, { recursive: true })
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output()
  const put = async (v: string) => { for (const [f, t] of Object.entries(mise(v))) await Deno.writeTextFile(`${app}/${f}`, t) }
  await put("1.0.0")
  const old = await pronto("1.0.0", {})
  const base = await deployKey(old, app)
  // The same content under a new version, with the engine's files changed: the pins and
  // distribution/config.cue's version line are the only differences besides the engine's.
  await put("1.0.1")
  const engine = await pronto("1.0.1", { "gcp/release.nu": "release 2", "release-flow.test.ts": "flow 2", "testdata/fake-cloud.sh": "fake 2", "docs/a.md": "doc 2", "gcp/new.nu": "x" })
  assertEquals(await deployKey(engine, app), base)
  // A runtime file that is not the engine's, or another tool's pin, moves it.
  const changed = await pronto("1.0.1", { "write.ts": "write 2" })
  assert((await deployKey(changed, app)) !== base, "write.ts moved it")
  const dist = await pronto("1.0.1", { "distribution/config.cue": `#Version: "1.0.1"\n#Other: "y"\n` })
  assert((await deployKey(dist, app)) !== base, "another line of distribution/ moved it")
  const mecha = mise("1.0.1")
  await Deno.writeTextFile(`${app}/.mise.toml`, mecha[".mise.toml"].replace("mecha' = '1'", "mecha' = '2'"))
  assert((await deployKey(engine, app)) !== base, "mecha's pin moved it")
})
