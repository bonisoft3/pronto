// release.nu's flow, run offline: `nu gcp/release.nu` against a small app in a temp repo, with
// gcloud, docker and curl replaced by testdata/fake-cloud.sh (every call logged, nothing
// reached) and an `integrate@local` stub. It asserts the order and the scope of the calls the
// release makes: the gate skipped by its ledger, the rc preview beside the local gate,
// production untouched by a failing gate, and an image built only when its files changed.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11"

const fork = new URL(".", import.meta.url).pathname.replace(/\/$/, "")
const decoder = new TextDecoder()
const PROD = /--project brawl-chess( |$)/
const RC = /--project brawl-chess-previews( |$)/
const services = ["database", "crud", "electric", "auth", "caddy", "billing", "worker"]

type World = { root: string; app: string; home: string; fakes: string; state: string; log: string }

const write = (path: string, text: string) => Deno.writeTextFile(path, text)

async function sh(cwd: string, cmd: string, ...args: string[]) {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output()
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}: ${decoder.decode(out.stderr)}`)
}

async function world(): Promise<World> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "release-flow." }))
  const app = `${root}/app`
  const fakes = `${root}-fakes`
  const state = `${root}-state`
  for (const d of [`${root}/cue.mod`, `${root}/gcp`, app, `${app}/.pronto`, `${app}/docker`, fakes, state]) await Deno.mkdir(d, { recursive: true })
  // The fork's own CUE module, reduced to what the plan imports.
  await write(`${root}/cue.mod/module.cue`, `module: "github.com/bonisoft3/pronto@v0"\nlanguage: version: "v0.16.1"\n`)
  await new Deno.Command("cp", { args: ["-R", `${fork}/gcp/schema`, `${root}/gcp/schema`] }).output()
  await new Deno.Command("cp", { args: ["-R", `${fork}/resilience`, `${root}/resilience`] }).output()
  await write(`${app}/release.cue`, `package app
import "github.com/bonisoft3/pronto/gcp/schema"
GCP: schema.#Release & {name: "guestbook", project: "brawl-chess", previewProject: "brawl-chess-previews", region: "us-central1", sidecars: {billing: {port: 8688, apart: {}}, worker: {port: 8689, apart: {}}}}
gcpRelease: schema.#Build & {release: GCP}
`)
  await write(`${app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service"] }))
  await write(`${app}/.say.yaml`, "say:\n  integrate:\n    rulemap:\n      local:\n        platform: local\n")
  await write(`${app}/saytw`, `#!/bin/sh
echo "saytw $* drivers=$INTEGRATE_LOCAL_DRIVERS start" >> "$FAKE_LOG"
sleep "\${FAKE_GATE_SLEEP:-0}"
[ -z "$FAKE_GATE_TOUCH" ] || echo changed >> "$FAKE_GATE_TOUCH"
if [ -n "$FAKE_GATE_FAIL" ]; then echo "saytw end FAILED" >> "$FAKE_LOG"; echo "scenario failed" >&2; exit 1; fi
echo "saytw end" >> "$FAKE_LOG"
`)
  await Deno.chmod(`${app}/saytw`, 0o755)
  const compose: Record<string, unknown> = {}
  for (const s of services) {
    await Deno.mkdir(`${app}/${s}`)
    await write(`${app}/${s}/file.txt`, s)
    await write(`${app}/docker/${s}.Dockerfile`, `FROM scratch\nCOPY ${s}/ /app\n`)
    compose[s] = { build: { context: app, dockerfile: `docker/${s}.Dockerfile` }, environment: {} }
  }
  await write(`${root}-compose.json`, JSON.stringify({ name: "guestbook", services: compose }))
  for (const t of ["gcloud", "docker", "curl"]) await Deno.symlink(`${fork}/testdata/fake-cloud.sh`, `${fakes}/${t}`)
  await sh(root, "git", "init", "-q")
  return { root, app, home: `${root}-home`, fakes, state, log: `${root}-log` }
}

const env = (w: World, extra: Record<string, string> = {}) => ({
  // The fakes before everything: no real gcloud, docker or curl is ever found first.
  PATH: `${w.fakes}:${Deno.env.get("PATH")}`,
  HOME: w.home,
  CLOUDSDK_CONFIG: `${w.root}-gcloud`,
  FAKE_LOG: w.log,
  FAKE_STATE: w.state,
  FAKE_COMPOSE: `${w.root}-compose.json`,
  ...extra,
})

async function nu(w: World, args: string[], extra: Record<string, string> = {}) {
  await Deno.mkdir(w.home, { recursive: true })
  const out = await new Deno.Command("nu", { args, cwd: w.app, env: env(w, extra), clearEnv: true, stdout: "piped", stderr: "piped" }).output()
  return { success: out.success, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) }
}

const release = (w: World, extra: Record<string, string> = {}) => nu(w, [`${fork}/gcp/release.nu`, "--app", w.app], extra)
const ledger = (w: World, verb: string) => nu(w, [`${fork}/gcp/local-gate-key.nu`, verb, w.app])
const log = async (w: World) => (await Deno.readTextFile(w.log).catch(() => "")).split("\n").filter((l) => l !== "")
const at = (lines: string[], re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l))

async function ready(w: World) {
  // The fakes are the ones found: a real gcloud would otherwise be reached.
  for (const t of ["gcloud", "docker", "curl"]) {
    const found = await new Deno.Command("sh", { args: ["-c", `command -v ${t}`], env: env(w), clearEnv: true, stdout: "piped" }).output()
    assertEquals(decoder.decode(found.stdout).trim(), `${w.fakes}/${t}`)
  }
  await Deno.writeTextFile(w.log, "")
}

const clean = (w: World) => Promise.all([w.root, w.fakes, w.state, w.home, `${w.root}-compose.json`, `${w.root}-gcloud`, w.log].map((p) => Deno.remove(p, { recursive: true }).catch(() => {})))

Deno.test("a tree the local gate and rc passed: no rc preview, no gate run, stage then go live", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    const lines = await log(w)
    assertEquals(lines.filter((l) => RC.test(l) || /guestbook-rc/.test(l)), [], "nothing of the rc preview")
    assertEquals(lines.filter((l) => l.startsWith("saytw")), [], "the gate is skipped by its ledger")
    assertStringIncludes(r.stdout, "no rc preview")
    assertStringIncludes(r.stdout, "skipped")
    const staged = at(lines, /secrets versions access/)
    const schema = at(lines, /run jobs execute guestbook-initdb/)
    const deploy = at(lines, /replace .*dist\/gcp\/service.yaml is guestbook$/)
    assert(staged >= 0 && staged < schema && schema < deploy, `stage, the schema job, the service: ${staged} ${schema} ${deploy}`)
  } finally { await clean(w) }
})

Deno.test("no rc stamp: the rc preview deploys beside the local gate, and production waits for both", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_GATE_SLEEP: "3" })
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "the rc preview runs")
    const lines = await log(w)
    const start = at(lines, /^saytw .*start$/)
    const end = at(lines, /^saytw end$/)
    assert(start >= 0 && end > start, "the gate ran")
    assertStringIncludes(lines[start], "drivers=all")
    const rcDeploy = at(lines, /replace .*dist\/gcp\/service.yaml is guestbook-rc$/, start)
    assert(rcDeploy > start && rcDeploy < end, `the preview deployed while the gate ran: ${start} ${rcDeploy} ${end}`)
    const prod = at(lines, PROD)
    assert(prod > end, `production first touched at ${prod}, after the gate ended at ${end}`)
    const live = at(lines, /replace .*dist\/gcp\/service.yaml is guestbook$/)
    assert(live > prod)
    assertEquals((await ledger(w, "rc-passed")).stdout.trim(), "true", "the release that passed rc is recorded")
  } finally { await clean(w) }
})

Deno.test("a failing local gate: nothing reaches production", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_GATE_SLEEP: "1", FAKE_GATE_FAIL: "1" })
    assert(!r.success, r.stdout + r.stderr)
    assertStringIncludes(r.stderr, "the local pre-gate failed")
    const lines = await log(w)
    assert(at(lines, /^saytw /) >= 0)
    assertEquals(lines.filter((l) => PROD.test(l)), [], "no call against production")
    assertEquals((await ledger(w, "passed")).stdout.trim(), "false")
  } finally { await clean(w) }
})

Deno.test("a second release builds only the image whose files changed", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const first = await release(w)
    assert(first.success, first.stderr + first.stdout)
    const built = async () => (await log(w)).filter((l) => l.startsWith("  build ")).map((l) => l.slice(8))
    const scripts = async (files: string[]) => (await Promise.all(files.map((f) => Deno.readTextFile(f)))).join("\n")
    const all = await scripts(await built())
    for (const s of services) assertStringIncludes(all, `${s}.tags=`)
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/crud/file.txt`, "changed")
    const second = await release(w)
    assert(second.success, second.stderr + second.stdout)
    assertEquals((await log(w)).filter((l) => /^saytw .*start$/.test(l)).length, 1, "the changed tree runs the gate again")
    const again = await scripts(await built())
    assertStringIncludes(again, "crud.tags=")
    for (const s of services.filter((s) => s !== "crud")) assert(!again.includes(`${s}.tags=`), `${s} was built again`)
    assertStringIncludes(second.stdout, "reusing")
  } finally { await clean(w) }
})

Deno.test("a deploy-shaped file of an image (a Dockerfile) runs the rc preview though the gate passed", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    await Deno.writeTextFile(`${w.app}/docker/crud.Dockerfile`, "FROM scratch\nCOPY crud/ /other\n")
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "the rc preview runs")
    assert(at(await log(w), RC) >= 0)
  } finally { await clean(w) }
})

Deno.test("a tree that changed while the gate ran is not recorded as passed", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "rc-stamp")
    const r = await release(w, { FAKE_GATE_TOUCH: "crud/file.txt" })
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "changed during the run")
    assertEquals((await ledger(w, "passed")).stdout.trim(), "false")
  } finally { await clean(w) }
})

Deno.test("a heredoc opens at a RUN, COPY or ADD only, not at a shell's shift", async () => {
  const dockerfile = "FROM x\nENV A=$((1<<2))\nCOPY a /a\nRUN <<EOF\nCOPY inside /x\nEOF\nCOPY b /b\n"
  const out = await new Deno.Command("nu", { args: ["-c", `source ${fork}/gcp/build.nu; dockerfile-reads ${JSON.stringify(dockerfile)} | to json --raw`], stdout: "piped", stderr: "piped" }).output()
  assert(out.success, decoder.decode(out.stderr))
  assertEquals(JSON.parse(decoder.decode(out.stdout)), ["a", "b"])
})

Deno.test("a go-live task that fails lets the others finish, then fails the release", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w, { FAKE_FAIL: "services replace dist/gcp/sidecar-billing.yaml" })
    assert(!r.success)
    assertStringIncludes(r.stderr, "sidecar-billing.yaml")
    const lines = await log(w)
    assert(at(lines, /replace .*sidecar-worker.yaml is /) >= 0, "the other sidecar was still made")
    assert(at(lines, /add-iam-policy-binding guestbook --region .* --member allUsers/) >= 0, "the door's grant was still made")
    assertEquals(lines.filter((l) => l.startsWith("curl") && l.includes("/health")), [], "not declared live")
  } finally { await clean(w) }
})

Deno.test("a release whose schema job is unchanged skips it; a changed job runs it before the service", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const first = await release(w)
    assert(first.success, first.stderr + first.stdout)
    const firstLines = await log(w)
    assert(at(firstLines, /run jobs execute guestbook-initdb/) >= 0, "no live service: the job runs")
    // The same job again, the live service carrying its hash: no job call at all.
    await Deno.writeTextFile(w.log, "")
    const same = await release(w)
    assert(same.success, same.stderr + same.stdout)
    assertStringIncludes(same.stdout, "the schema job skipped")
    const lines = await log(w)
    assertEquals(lines.filter((l) => /run jobs (replace|execute)/.test(l)), [], "no job call")
    assert(at(lines, /replace .*dist\/gcp\/service.yaml is guestbook$/) >= 0, "the service is still replaced")
    // A code-only edit (another service's files): that image is built, the schema's is not, the job skipped.
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/crud/file.txt`, "code only")
    const code = await release(w)
    assert(code.success, code.stderr + code.stdout)
    assertStringIncludes(code.stdout, "the schema job skipped")
    assertEquals((await log(w)).filter((l) => /run jobs (replace|execute)/.test(l)), [], "a code-only release makes no job call")
    // An edit to the schema image's files: it is built again, and the job runs before the service.
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/database/file.txt`, "a migration")
    const mig = await release(w)
    assert(mig.success, mig.stderr + mig.stdout)
    const l1 = await log(w)
    const j1 = at(l1, /run jobs execute guestbook-initdb/)
    assert(j1 >= 0 && j1 < at(l1, /replace .*dist\/gcp\/service.yaml is guestbook$/), "an edited schema runs the job before the service")
    // A role added to what the job grants: the job runs, before the service.
    await Deno.writeTextFile(`${w.app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service", "auditor"] }))
    await Deno.writeTextFile(w.log, "")
    const changed = await release(w)
    assert(changed.success, changed.stderr + changed.stdout)
    const l2 = await log(w)
    const job = at(l2, /run jobs execute guestbook-initdb/)
    const live = at(l2, /replace .*dist\/gcp\/service.yaml is guestbook$/)
    assert(job >= 0 && job < live, `the job ran before the service: ${job} ${live}`)
    // Forced, the unchanged job runs too.
    await Deno.writeTextFile(w.log, "")
    const forced = await release(w, { PRONTO_RELEASE_FORCE_SCHEMA: "1" })
    assert(forced.success, forced.stderr + forced.stdout)
    assert(at(await log(w), /run jobs execute guestbook-initdb/) >= 0)
  } finally { await clean(w) }
})
