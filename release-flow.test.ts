// release.nu's flow, run offline: `nu gcp/release.nu` against a small app in a temp repo, with
// gcloud, docker and curl replaced by testdata/fake-cloud.sh (every call logged, nothing
// reached) and an `integrate@local` stub. It asserts the order and the scope of the calls the
// release makes: the gate skipped by its ledger, the rc preview beside the local gate,
// production untouched by a failing gate, and an image built only when its files changed.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11"

const fork = new URL(".", import.meta.url).pathname.replace(/\/$/, "")
const decoder = new TextDecoder()
// A call against production's project. The release lock lives in that project's bucket, but it is
// no part of the app: taking it before the gates is what keeps two releases apart.
const PROD_ANY = /--project brawl-chess( |$)/
const PROD = { test: (l: string) => PROD_ANY.test(l) && !/release-locks/.test(l) } as RegExp
const RC = /--project brawl-chess-previews( |$)/
const services = ["database", "crud", "electric", "auth", "caddy", "billing", "worker", "front"]

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
GCP: schema.#Release & {name: "guestbook", project: "brawl-chess", previewProject: "brawl-chess-previews", region: "us-central1", sidecars: {billing: {port: 8688, apart: {}}, worker: {port: 8689, apart: {}}, front: {port: 8690, env: {LIVENESS_AMR: "off"}}}}
gcpRelease: schema.#Build & {release: GCP}
`)
  await write(`${app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service"] }))
  await write(`${app}/.say.yaml`, "say:\n  integrate:\n    rulemap:\n      local:\n        platform: local\n")
  await write(`${app}/saytw`, `#!/bin/sh
echo "saytw $* drivers=$INTEGRATE_LOCAL_DRIVERS start" >> "$FAKE_LOG"
sleep "\${FAKE_GATE_SLEEP:-0}"
# A gate held open until a call shows in the log (FAKE_GATE_UNTIL, a pattern), a minute at most:
# the ordering a test asserts, whatever the machine's load.
if [ -n "$FAKE_GATE_UNTIL" ]; then n=0; until grep -Eq "$FAKE_GATE_UNTIL" "$FAKE_LOG" || [ $n -ge 600 ]; do sleep 0.1; n=$((n+1)); done; fi
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
    const deploy = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    assert(staged >= 0 && staged < schema && schema < deploy, `stage, the schema job, the service: ${staged} ${schema} ${deploy}`)
  } finally { await clean(w) }
})

Deno.test("no rc stamp: the rc preview deploys beside the local gate, and production waits for both", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_GATE_UNTIL: "service.held.yaml is guestbook-rc$" })
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "the rc preview runs")
    const lines = await log(w)
    const start = at(lines, /^saytw .*start$/)
    const end = at(lines, /^saytw end$/)
    assert(start >= 0 && end > start, "the gate ran")
    assertStringIncludes(lines[start], "drivers=all")
    const rcDeploy = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook-rc$/, start)
    assert(rcDeploy > start && rcDeploy < end, `the preview deployed while the gate ran: ${start} ${rcDeploy} ${end}`)
    const prod = at(lines, PROD)
    assert(prod > end, `production first touched at ${prod}, after the gate ended at ${end}`)
    const live = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
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

Deno.test("an image's key follows the files its Dockerfile copies: a pin bump moves none, an edit to one image's file moves that image's alone", async () => {
  const app = await Deno.makeTempDir()
  const real = await Deno.realPath(app)
  const write = async (f: string, text: string) => { await Deno.mkdir(`${app}/${f}`.replace(/\/[^/]*$/, ""), { recursive: true }); await Deno.writeTextFile(`${app}/${f}`, text) }
  const compose: Record<string, unknown> = {}
  for (const s of ["one", "two"]) {
    await write(`${s}/file.txt`, s)
    await write(`docker/${s}.Dockerfile`, `FROM scratch\nCOPY ${s}/ /app\n`)
    compose[s] = { build: { context: real, dockerfile: `docker/${s}.Dockerfile` } }
  }
  await write(".mise.toml", "[tools]\n'github:bonisoft3/pronto' = '1'\n")
  await write("mise.lock", "version = '1'\n")
  await write("cue.mod/module.cue", "v: 1\n")
  await write("compose.json", JSON.stringify({ services: compose }))
  await sh(app, "git", "init", "-q")
  const list = `${await Deno.makeTempDir()}/files`
  const keys = async () => {
    const files = await new Deno.Command("git", { args: ["ls-files", "-co", "--exclude-standard"], cwd: real, stdout: "piped" }).output()
    await Deno.writeTextFile(list, decoder.decode(files.stdout).split("\n").filter((f) => f && f !== "compose.json").join("\n"))
    const script = `source ${fork}/gcp/build.nu; let h = (file-hashes ${real} ${list}); image-keys ${real} (open ${real}/compose.json) $h "t" [one two] | to json --raw`
    const out = await new Deno.Command("nu", { args: ["-c", script], cwd: real, stdout: "piped", stderr: "piped" }).output()
    assert(out.success, decoder.decode(out.stderr))
    return JSON.parse(decoder.decode(out.stdout)) as Record<string, string>
  }
  const before = await keys()
  await write(".mise.toml", "[tools]\n'github:bonisoft3/pronto' = '2'\n")
  await write("mise.lock", "version = '2'\n")
  await write("cue.mod/module.cue", "v: 2\n")
  assertEquals(await keys(), before, "a pin bump no image copies moves no key")
  await write("one/file.txt", "changed")
  const after = await keys()
  assert(after.one !== before.one, "the image that copies the file")
  assertEquals(after.two, before.two, "the other image is reused")
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

Deno.test("each sidecar apart is rolled once the new revision serves, and a roll that fails leaves the release live", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    const lines = await log(w)
    const moved = at(lines, /update-traffic guestbook --to-revisions r1=100/)
    for (const s of ["billing", "worker"]) {
      const made = at(lines, new RegExp(`replace .*sidecar-${s}.yaml is `))
      const rolled = at(lines, new RegExp(`services update guestbook-${s} --update-labels pronto-door=r1`))
      assert(made >= 0 && made < moved && moved < rolled, `${s}: made ${made}, traffic ${moved}, rolled ${rolled}`)
    }
    await clean(w)
    const v = await world()
    await ready(v)
    await ledger(v, "stamp")
    await ledger(v, "rc-stamp")
    const kept = await release(v, { FAKE_FAIL: "services update guestbook-billing --update-labels" })
    assert(kept.success, kept.stderr + kept.stdout)
    assertStringIncludes(kept.stdout, "billing apart kept its instance")
    await clean(v)
  } finally { await clean(w) }
})

Deno.test("an IAM binding refused once for a concurrent policy change is asked again, and the release goes live", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w, { FAKE_RACE: "run services add-iam-policy-binding guestbook .*allUsers" })
    assert(r.success, r.stderr + r.stdout)
    const lines = await log(w)
    const raced = at(lines, /raced .*add-iam-policy-binding guestbook /)
    assert(raced >= 0, "the binding was refused once")
    assert(at(lines, /add-iam-policy-binding guestbook .*allUsers/, raced + 1) > raced, "and asked again")
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
    assert(at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/) >= 0, "the service is still replaced")
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
    assert(j1 >= 0 && j1 < at(l1, /replace .*dist\/gcp\/service.held.yaml is guestbook$/), "an edited schema runs the job before the service")
    // A role added to what the job grants: the job runs, before the service.
    await Deno.writeTextFile(`${w.app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service", "auditor"] }))
    await Deno.writeTextFile(w.log, "")
    const changed = await release(w)
    assert(changed.success, changed.stderr + changed.stdout)
    const l2 = await log(w)
    const job = at(l2, /run jobs execute guestbook-initdb/)
    const live = at(l2, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    assert(job >= 0 && job < live, `the job ran before the service: ${job} ${live}`)
    // Forced, the unchanged job runs too.
    await Deno.writeTextFile(w.log, "")
    const forced = await release(w, { PRONTO_RELEASE_FORCE_SCHEMA: "1" })
    assert(forced.success, forced.stderr + forced.stdout)
    assert(at(await log(w), /run jobs execute guestbook-initdb/) >= 0)
  } finally { await clean(w) }
})

// The release lock, as the fake's Cloud Storage keeps it: gs://<project>-release-locks/<app>.
const LOCK = "gs://brawl-chess-release-locks/guestbook"
const lockFile = async (w: World) => {
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(LOCK)))].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${w.state}/gcs-${hex}`
}
const holdLock = async (w: World, until: Date) => {
  const f = await lockFile(w)
  await write(`${f}.body`, JSON.stringify({ by: "other@machine", dir: "/elsewhere", pid: 7, since: new Date().toISOString(), until: until.toISOString() }))
  await write(`${f}.gen`, "41\n")
}
const lockHeld = async (w: World) => Deno.stat(`${await lockFile(w)}.gen`).then(() => true, () => false)

Deno.test("a release holds its app's lock from before anything reaches the project to its end", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    const lines = await log(w)
    const took = at(lines, new RegExp(`wrote ${LOCK}$`))
    const first = at(lines, PROD_ANY)
    const replaced = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    const gone = at(lines, new RegExp(`removed ${LOCK}$`))
    assert(took >= 0 && took < replaced && replaced < gone, `taken ${took}, the service ${replaced}, let go ${gone}`)
    assert(at(lines, /storage cp .*--if-generation-match=0/) >= 0, "made only where none is")
    assert(first >= 0)
    assertEquals(await lockHeld(w), false, "nothing is left held")
  } finally { await clean(w) }
})

Deno.test("another release holding the app's lock: this one stops before production, and leaves the lock", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    await holdLock(w, new Date(Date.now() + 20 * 60_000))
    const r = await release(w)
    assert(!r.success, "refused")
    assertStringIncludes(r.stderr, "another release of guestbook is running: other@machine")
    const lines = await log(w)
    assertEquals(lines.filter((l) => /run services replace|run jobs execute|builds submit/.test(l)), [], "nothing deployed")
    assertEquals(await lockHeld(w), true, "the other release's lock stays")
  } finally { await clean(w) }
})

Deno.test("an expired lock, as a release that died leaves, is taken over", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    await holdLock(w, new Date(Date.now() - 60_000))
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "taken over from other@machine")
    assertEquals(await lockHeld(w), false)
  } finally { await clean(w) }
})

Deno.test("a release that fails lets its lock go all the same", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w, { FAKE_FAIL: "run services replace dist/gcp/service.held.yaml" })
    assert(!r.success, "the release fails")
    assertEquals(await lockHeld(w), false, "and its lock is let go")
  } finally { await clean(w) }
})

Deno.test("a release that is live does not wait for the rc preview's cleanup: its clock goes, the rest stays for the next release", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "what the tests printed")
    assertStringIncludes(r.stdout, "tests-log.txt")
    const lines = await log(w)
    const live = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    assert(live >= 0)
    assertEquals(lines.slice(live).filter((l) => /run (services|jobs) delete/.test(l)), [], "no preview service or job is deleted after production is live")
    assert(at(lines, /scheduler jobs delete/, live) > live, "the preview's clock is deleted")
    assertEquals((await ledger(w, "rc-passed")).stdout.trim(), "true")
    // A failed release stops the preview whole.
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/crud/file.txt`, "again")
    const bad = await nu(w, [`${fork}/gcp/release.nu`, "--app", w.app, "--rc"], { FAKE_FAIL: "run services replace .*--project brawl-chess( |$)" })
    assert(!bad.success)
    assert(at(await log(w), /run services update guestbook-rc --scaling 0/) >= 0, "a failure stops the preview")
    assertEquals((await log(w)).filter((l) => /run services delete guestbook-rc/.test(l)), [], "a stopped preview keeps its services, and so their allUsers grant")
  } finally { await clean(w) }
})

Deno.test("a project set up the same way is not set up again; a changed input sets it up", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const first = await release(w)
    assert(first.success, first.stderr + first.stdout)
    assert(at(await log(w), /sql instances describe/) >= 0, "the first release sets the project up")
    await Deno.writeTextFile(w.log, "")
    const same = await release(w)
    assert(same.success, same.stderr + same.stdout)
    assertStringIncludes(same.stdout, "as the last release set it up")
    assertEquals((await log(w)).filter((l) => /sql instances describe|iam service-accounts describe|artifacts repositories describe/.test(l)), [], "no setup call")
    // An input of the setup changed: it runs.
    await Deno.writeTextFile(w.log, "")
    const cue = await Deno.readTextFile(`${w.app}/release.cue`)
    await Deno.writeTextFile(`${w.app}/release.cue`, cue.replace('region: "us-central1"', 'region: "us-central1", sqlTier: "db-g1-small"'))
    const changed = await release(w)
    assert(changed.success, changed.stderr + changed.stdout)
    assert(!changed.stdout.includes("as the last release set it up"))
    assert(at(await log(w), /sql instances describe/) >= 0, "a changed tier sets the project up")
  } finally { await clean(w) }
})

// The record of each run (gcp/release-record.nu), which a local DORA dashboard reads.
const records = async (w: World) =>
  (await Deno.readTextFile(`${w.home}/.cache/pronto/releases/guestbook.jsonl`).catch(() => "")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l))

Deno.test("a release gone live through the rc gate records its commit, revision and phases", async () => {
  const w = await world()
  try {
    await ready(w)
    const git = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    const commit = await new Deno.Command("sh", { args: ["-c", "git add -A && git commit -qm release && git rev-parse HEAD"], cwd: w.root, env: git, stdout: "piped", stderr: "piped" }).output()
    assert(commit.success, decoder.decode(commit.stderr))
    const r = await release(w, { FAKE_GATE_UNTIL: "service.held.yaml is guestbook-rc$" })
    assert(r.success, r.stderr + r.stdout)
    const [rec, ...more] = await records(w)
    assertEquals(more, [], "one line a run")
    const version = (await Deno.readTextFile(`${fork}/distribution/config.cue`)).match(/#Version:\s+"([^"]+)"/)![1]
    assertEquals({ ...rec, started: undefined, ended: undefined, phases: undefined }, {
      app: "guestbook", service: "guestbook", project: "brawl-chess", preview: "",
      commit: decoder.decode(commit.stdout).trim(), dirty: false, pronto: version,
      started: undefined, ended: undefined, outcome: "live", failure: null,
      rc: "ran", localGate: "ran", revision: "r1", phases: undefined,
    })
    assert(Date.parse(rec.started) <= Date.parse(rec.ended))
    for (const p of ["lock", "gate", "rc", "stage", "schema", "deploy", "total"]) assertEquals(typeof rec.phases[p], "number", p)
    assert(rec.phases.total >= rec.phases.stage)
    // A tree the gates passed: the gate reused, the rc gate skipped and why; released again
    // unchanged, the schema job skipped.
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    for (const _ of [1, 2]) {
      const again = await release(w)
      assert(again.success, again.stderr + again.stdout)
    }
    const [, second, third] = await records(w)
    assertEquals([second.localGate, second.phases.gate, second.phases.rc], ["reused", null, null])
    assertStringIncludes(second.rc, "skipped: ")
    assertEquals(third.phases.schema, "skipped")
  } finally { await clean(w) }
})

Deno.test("a failed release records its first line of failure, after its lock is let go", async () => {
  const w = await world()
  try {
    await ready(w)
    await ledger(w, "stamp")
    await ledger(w, "rc-stamp")
    const r = await release(w, { FAKE_FAIL: "run services replace dist/gcp/service.held.yaml" })
    assert(!r.success)
    const [rec] = await records(w)
    assertEquals([rec.outcome, rec.revision, rec.localGate], ["failed", null, "reused"])
    assertStringIncludes(rec.failure, "fake failure: --quiet run services replace dist/gcp/service.held.yaml")
    assert(!rec.failure.includes("\n"))
    assertEquals(typeof rec.phases.deploy, "number", "a phase never ended is timed to the run's end")
    assertEquals(await lockHeld(w), false)
  } finally { await clean(w) }
})

Deno.test("a release refused by another's lock records refused; a dry run records nothing", async () => {
  const w = await world()
  try {
    await ready(w)
    await holdLock(w, new Date(Date.now() + 20 * 60_000))
    const r = await release(w)
    assert(!r.success)
    const [rec, ...more] = await records(w)
    assertEquals(more, [])
    assertEquals([rec.outcome, rec.rc, rec.localGate, rec.commit, rec.phases.stage], ["refused", "skipped: the run ended before the rc gate was decided", "skipped", null, null])
    assertStringIncludes(rec.failure, "another release of guestbook is running")
    assertEquals(typeof rec.phases.lock, "number")
    const dry = await nu(w, [`${fork}/gcp/release.nu`, "--app", w.app, "--dry-run"])
    assert(dry.success, dry.stderr + dry.stdout)
    assertEquals((await records(w)).length, 1, "a dry run writes nothing")
  } finally { await clean(w) }
})
