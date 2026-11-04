// release.nu's flow, run offline: `nu gcp/release.nu` against a small app in a temp repo, with
// gcloud, docker and curl replaced by testdata/fake-cloud.sh (every call logged, nothing
// reached). It asserts the order and the scope of the calls the release makes: the rc preview
// before production, production staged while the tests run and made live after, an image
// built only when its files changed, and the release lock held from before anything reaches
// the project to the end.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11"

const root_dir = new URL(".", import.meta.url).pathname.replace(/\/$/, "")
const decoder = new TextDecoder()
// A call against production's project. The release lock lives in that project's bucket, but it is
// no part of the app: taking it before anything else is what keeps two releases apart.
const PROD_ANY = /--project pronto-test( |$)/
const PROD = { test: (l: string) => PROD_ANY.test(l) && !/release-locks/.test(l) } as RegExp
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
  // The CUE module, reduced to what the plan imports.
  await write(`${root}/cue.mod/module.cue`, `module: "github.com/bonisoft3/pronto@v1"\nlanguage: version: "v0.16.1"\n`)
  await new Deno.Command("cp", { args: ["-R", `${root_dir}/gcp/schema`, `${root}/gcp/schema`] }).output()
  await new Deno.Command("cp", { args: ["-R", `${root_dir}/resilience`, `${root}/resilience`] }).output()
  await write(`${app}/release.cue`, `package app
import "github.com/bonisoft3/pronto/gcp/schema"
GCP: schema.#Release & {name: "guestbook", project: "pronto-test", previewProject: "pronto-test-previews", region: "us-central1", sidecars: {billing: {port: 8688, apart: {}}, worker: {port: 8689, apart: {}}, front: {port: 8690, env: {LIVENESS_AMR: "off"}}}}
gcpRelease: schema.#Build & {release: GCP}
`)
  await write(`${app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service"] }))
  const compose: Record<string, unknown> = {}
  for (const s of services) {
    await Deno.mkdir(`${app}/${s}`)
    await write(`${app}/${s}/file.txt`, s)
    await write(`${app}/docker/${s}.Dockerfile`, `FROM scratch\nCOPY ${s}/ /app\n`)
    compose[s] = { build: { context: app, dockerfile: `docker/${s}.Dockerfile` }, environment: {} }
  }
  await write(`${root}-compose.json`, JSON.stringify({ name: "guestbook", services: compose }))
  for (const t of ["gcloud", "docker", "curl"]) await Deno.symlink(`${root_dir}/testdata/fake-cloud.sh`, `${fakes}/${t}`)
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

// A release through its rc preview and tests; `--no-gate` goes straight to production.
const release = (w: World, extra: Record<string, string> = {}, ...flags: string[]) => nu(w, [`${root_dir}/gcp/release.nu`, "--app", w.app, ...flags], extra)
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

Deno.test("a gated release: the rc preview and its tests first, production staged beside them, then live", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "testing a preview")
    assertStringIncludes(r.stdout, "what the tests printed")
    const lines = await log(w)
    const rcLive = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook-rc$/)
    const tests = at(lines, /builds submit .*--async/)
    const prodLive = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    const schema = at(lines, /run jobs execute guestbook-initdb --region .* --project pronto-test( |$)/)
    assert(tests >= 0 && rcLive >= 0 && prodLive >= 0, `the tests ${tests}, the preview ${rcLive}, production ${prodLive}`)
    assert(rcLive < prodLive, "the preview is up before production goes live")
    assert(schema > rcLive && schema < prodLive, `production's schema job ran after the preview and before its service: ${rcLive} ${schema} ${prodLive}`)
    // The tested images are copied in, not built again for production, and tagged the release's once the tests passed.
    const copy = at(lines, /builds submit --no-source/)
    const tagged = at(lines, /artifacts docker tags add .*:release$/)
    assert(copy >= 0 && tagged > copy && tagged < schema, `copied ${copy}, tagged ${tagged}, schema job ${schema}`)
  } finally { await clean(w) }
})

Deno.test("a release that is live does not wait for the rc preview's cleanup: its clock goes, the rest stays for the next release", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w)
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "tests-log.txt")
    const lines = await log(w)
    const live = at(lines, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    assert(live >= 0)
    assertEquals(lines.slice(live).filter((l) => /run (services|jobs) delete/.test(l)), [], "no preview service or job is deleted after production is live")
    assert(at(lines, /scheduler jobs delete/, live) > live, "the preview's clock is deleted")
    // A failed release stops the preview whole.
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/crud/file.txt`, "again")
    const bad = await release(w, { FAKE_FAIL: "run services replace dist/gcp/service.held.yaml --region us-central1 --project pronto-test( |$)" })
    assert(!bad.success)
    assert(at(await log(w), /run services update guestbook-rc --scaling 0/) >= 0, "a failure stops the preview")
    assertEquals((await log(w)).filter((l) => /run services delete guestbook-rc/.test(l)), [], "a stopped preview keeps its services, and so their allUsers grant")
  } finally { await clean(w) }
})

Deno.test("a second release builds only the image whose files changed", async () => {
  const w = await world()
  try {
    await ready(w)
    const first = await release(w, {}, "--no-gate")
    assert(first.success, first.stderr + first.stdout)
    const built = async () => (await log(w)).filter((l) => l.startsWith("  build ")).map((l) => l.slice(8))
    const scripts = async (files: string[]) => (await Promise.all(files.map((f) => Deno.readTextFile(f)))).join("\n")
    const all = await scripts(await built())
    for (const s of services) assertStringIncludes(all, `${s}.tags=`)
    await Deno.writeTextFile(w.log, "")
    await Deno.writeTextFile(`${w.app}/crud/file.txt`, "changed")
    const second = await release(w, {}, "--no-gate")
    assert(second.success, second.stderr + second.stdout)
    const again = await scripts(await built())
    assertStringIncludes(again, "crud.tags=")
    for (const s of services.filter((s) => s !== "crud")) assert(!again.includes(`${s}.tags=`), `${s} was built again`)
    assertStringIncludes(second.stdout, "reusing")
  } finally { await clean(w) }
})

Deno.test("a go-live task that fails lets the others finish, then fails the release", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_FAIL: "services replace dist/gcp/sidecar-billing.yaml" }, "--no-gate")
    assert(!r.success)
    assertStringIncludes(r.stderr, "sidecar-billing.yaml")
    const lines = await log(w)
    assert(at(lines, /replace .*sidecar-worker.yaml is /) >= 0, "the other sidecar was still made")
    assert(at(lines, /get-iam-policy guestbook /) >= 0, "the door's grant was still made")
    assertEquals(lines.filter((l) => l.startsWith("curl") && l.includes("/health") && l.includes("next---")), [], "not declared live")
  } finally { await clean(w) }
})

Deno.test("each sidecar apart is rolled once the new revision serves, and a roll that fails leaves the release live", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, {}, "--no-gate")
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
    const kept = await release(v, { FAKE_FAIL: "services update guestbook-billing --update-labels" }, "--no-gate")
    assert(kept.success, kept.stderr + kept.stdout)
    assertStringIncludes(kept.stdout, "billing apart kept its instance")
    await clean(v)
  } finally { await clean(w) }
})

Deno.test("an IAM binding refused once for a concurrent policy change is asked again, and the release goes live", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_RACE: "run services add-iam-policy-binding guestbook .*allUsers" }, "--no-gate")
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
    const first = await release(w, {}, "--no-gate")
    assert(first.success, first.stderr + first.stdout)
    assert(at(await log(w), /run jobs execute guestbook-initdb/) >= 0, "the first release builds the schema")
    await Deno.writeTextFile(w.log, "")
    const second = await release(w, {}, "--no-gate")
    assert(second.success, second.stderr + second.stdout)
    assertStringIncludes(second.stdout, "the schema job skipped")
    assertEquals((await log(w)).filter((l) => /run jobs execute/.test(l)), [], "nothing ran the job")
    // A role added to what the job grants: the job runs, before the service.
    await Deno.writeTextFile(`${w.app}/.pronto/cluster.json`, JSON.stringify({ server: true, tokenRoles: ["anon", "app_user", "service", "auditor"] }))
    await Deno.writeTextFile(w.log, "")
    const changed = await release(w, {}, "--no-gate")
    assert(changed.success, changed.stderr + changed.stdout)
    const l2 = await log(w)
    const job = at(l2, /run jobs execute guestbook-initdb/)
    const live = at(l2, /replace .*dist\/gcp\/service.held.yaml is guestbook$/)
    assert(job >= 0 && job < live, `the job ran before the service: ${job} ${live}`)
    // Forced, the unchanged job runs too.
    await Deno.writeTextFile(w.log, "")
    const forced = await release(w, { PRONTO_RELEASE_FORCE_SCHEMA: "1" }, "--no-gate")
    assert(forced.success, forced.stderr + forced.stdout)
    assert(at(await log(w), /run jobs execute guestbook-initdb/) >= 0)
  } finally { await clean(w) }
})

// The release lock, as the fake's Cloud Storage keeps it: gs://<project>-release-locks/<app>.
const LOCK = "gs://pronto-test-release-locks/guestbook"
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
    const r = await release(w, {}, "--no-gate")
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
    await holdLock(w, new Date(Date.now() + 20 * 60_000))
    const r = await release(w, {}, "--no-gate")
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
    await holdLock(w, new Date(Date.now() - 60_000))
    const r = await release(w, {}, "--no-gate")
    assert(r.success, r.stderr + r.stdout)
    assertStringIncludes(r.stdout, "taken over from other@machine")
    assertEquals(await lockHeld(w), false)
  } finally { await clean(w) }
})

Deno.test("a release that fails lets its lock go all the same", async () => {
  const w = await world()
  try {
    await ready(w)
    const r = await release(w, { FAKE_FAIL: "run services replace dist/gcp/service.held.yaml" }, "--no-gate")
    assert(!r.success, "the release fails")
    assertEquals(await lockHeld(w), false, "and its lock is let go")
  } finally { await clean(w) }
})
