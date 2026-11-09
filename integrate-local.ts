// integrate@local: the cluster as host processes (.bayt/process-compose.yaml),
// and the terminal's visual lint against its door, as `integrate` runs it
// against the containers. The stack comes up, every process that serves is
// ready and every one-shot has finished, the lint runs, and the stack goes
// down whatever the lint answered; its exit code is the verdict.
//
//   deno run -A integrate-local.ts <app dir> --omnishell <omnishell dir> --settle <ms>
//
// Run inside the app's toolchain, which has process-compose and every tool
// the cluster's processes name on PATH. The browser is Playwright's
// Chromium at the version the lint imports, installed once per host, with its
// system libraries where the host is Linux (a CI runner).
//
// The database is the last release's (the app's release record names the commit), the tree's schema
// job applied to it as release@gcp applies it, and a migration error fails the run: a change a fresh
// initdb takes and a live database refuses shows up here, not in a release.
//
// With INTEGRATE_LOCAL_DRIVERS=all (release@gcp's local pre-gate) the app's
// other drivers run after the lint, each to its end, the run failing if any
// failed: the ones its gate runs against the `rc` preview (local-drivers.ts).
// A pass stamps the app's tree (gcp/local-gate-key.nu), which the release skips its gate for.

import { localDrivers } from "./local-drivers.ts"
import { hostPrepare } from "./host-prepare.ts"
import { prepare } from "./upgrade-from-released.ts"

const args: Record<string, string> = {}
const rest: string[] = []
for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i]
  if (a.startsWith("--")) args[a.slice(2)] = Deno.args[++i] ?? ""
  else rest.push(a)
}
const fail = (msg: string): never => {
  console.error(`integrate@local: ${msg}`)
  Deno.exit(1)
}
const [app] = rest
if (!app || !args.omnishell || !(Number(args.settle) > 0)) {
  fail("usage: integrate-local.ts <app dir> --omnishell <omnishell dir> --settle <ms>")
}
const appDir = await Deno.realPath(app)
const mode = Deno.env.get("INTEGRATE_LOCAL_DRIVERS") ?? ""
if (mode !== "" && mode !== "all") fail(`INTEGRATE_LOCAL_DRIVERS is "${mode}": it is unset or "all"`)
const lint = `${args.omnishell}/check-visual.ts`

// An app with a GCP release plan reads secrets by name in the projects it releases to: a missing one
// fails here, before a pull request merges, not in release@gcp's rc preview (gcp/secrets.nu).
const secrets = await new Deno.Command("nu", { args: [new URL("./gcp/secrets.nu", import.meta.url).pathname, "check", appDir, "--if-gcp"], stdout: "inherit", stderr: "inherit" }).output()
if (!secrets.success) fail("check-secrets failed: the secrets the app's release reads are not all in place")

// The release's pass ledger (gcp/local-gate-key.nu): the tree's key, taken before the stack starts.
// A stack on a slot runs from a copy of the app that is no git tree (tests/slot.ts), which names
// the checkout it copies in PRONTO_GATE_DIR: that tree is the one keyed and stamped.
const gateDir = Deno.env.get("PRONTO_GATE_DIR") ? await Deno.realPath(Deno.env.get("PRONTO_GATE_DIR")!) : appDir
const gateKey = async (verb: string, key?: string) => {
  const script = new URL("./gcp/local-gate-key.nu", import.meta.url).pathname
  const out = await new Deno.Command("nu", { args: [script, verb, gateDir, ...(key ? [key] : [])], stdout: "piped", stderr: "inherit" }).output()
  return { success: out.success, text: new TextDecoder().decode(out.stdout).trim() }
}
const treeKey = async () => {
  const r = await gateKey("key")
  return r.success ? r.text : ""
}

const run = async (cmd: string, cmdArgs: string[], opts: Deno.CommandOptions = {}) => {
  const { code } = await new Deno.Command(cmd, { args: cmdArgs, stdout: "inherit", stderr: "inherit", ...opts }).output()
  return code
}

// The browser the lint launches, from the Playwright it imports.
const playwright = (await Deno.readTextFile(lint)).match(/npm:playwright@([0-9.]+)/)?.[1] ??
  fail(`${lint} names no npm:playwright version`)
const install = ["run", "-A", `npm:playwright@${playwright}`, "install", ...(Deno.build.os === "linux" ? ["--with-deps"] : []), "chromium"]
if (await run(Deno.execPath(), install) !== 0) fail(`playwright ${playwright} could not install chromium`)

const before = mode === "all" ? await treeKey() : ""

// Every port the stack binds, moved to one free now: a launch@local of the
// same app holds the project's own defaults, and a check reaching that
// stack's database instead of its own would grade the wrong thing. Each is a
// variable bayt wrote as `${<VAR>:-<default>}`.
const compose = await Deno.readTextFile(`${appDir}/.bayt/process-compose.yaml`)
const portVars = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+_PORT):-[0-9]+\}/g)].map((m) => m[1]))]
const ports: Record<string, string> = {}
for (const v of portVars) {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 })
  ports[v] = String((l.addr as Deno.NetAddr).port)
  l.close()
}
// The door: mecha's host launch before 0.22 named it DOOR_PORT; from 0.22 the
// app's own URL names it (APP_URL=https://localhost:${CADDY_TLS_HOST_PORT:-n}),
// and Caddy binds CADDY_DOOR_PORT (its Caddyfile's {$CADDY_DOOR_PORT:8443}),
// which the compose leaves to its default: it is set here to the same port.
const [, doorVar] = compose.match(/DOOR_PORT=\$\{([A-Z0-9_]+):-[0-9]+\}/) ??
  compose.match(/APP_URL=https:\/\/localhost:\$\{([A-Z0-9_]+):-[0-9]+\}/) ??
  fail("the door's port is not in .bayt/process-compose.yaml; regenerate the app")
const door = ports[doorVar]
ports.CADDY_DOOR_PORT ??= door

// The host launch's own preparation (host-prepare.ts), as mecha 0.22's `integrate@host` makes it:
// the stack's tools are the app's `.mise.host.toml` (MISE_ENV=host), installed as its lock says.
const t0 = Date.now()
// sayt names its mise (SAYT_MISE_BIN) and puts none on PATH; the compose's processes call `mise`,
// so its directory goes on the stack's PATH.
const miseBin = Deno.env.get("SAYT_MISE_BIN") ?? "mise"
// This process runs under a `mise exec`, whose __MISE_* bookkeeping makes the next mise it meets
// take back the tools' directories from PATH (a postinstall hook then cannot find `nu`): the stack's
// environment is this one without it, as under the host launch's own nu.
const base = Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([k]) => !k.startsWith("__MISE")))
const hostInstall = await run(miseBin, ["install"], { cwd: appDir, clearEnv: true, env: { ...base, MISE_ENV: "host", MISE_LOCKED: "1" } })
if (hostInstall !== 0) fail("mise install of the host tools (.mise.host.toml, mise.host.lock) failed")
const miseDir = miseBin.includes("/") ? miseBin.slice(0, miseBin.lastIndexOf("/")) : ""
const host = await hostPrepare(appDir, miseDir, base).catch((e) => fail(e.message))
const pathKey = Object.keys(host.env).find((k) => k.toLowerCase() === "path")!
const hostEnv = { ...base, ...host.env, ...(miseDir ? { [pathKey]: `${host.env[pathKey]}:${miseDir}` } : {}), MISE_LOCKED: "0" }
const pcBin = new TextDecoder().decode((await new Deno.Command(miseBin, { args: ["which", "process-compose"], cwd: appDir, clearEnv: true, env: hostEnv, stdout: "piped" }).output()).stdout).trim() ||
  fail("the host tools carry no process-compose")
// The stack's scratch (its database, Caddy's state), under the preparation's own work directory
// and logging its processes to a file, as the host launch does.
const stackWork = `${host.work}/stack`
await Deno.mkdir(stackWork, { recursive: true })
await Deno.writeTextFile(`${host.work}/pc-logs.yaml`, `log_location: ${stackWork}/proc.log\n`)
// process-compose with its API on a socket of its own, which `list` reads.
const dir = await Deno.makeTempDir({ prefix: "integrate-local." })
// The stack's database is the last release's, carried forward as the release carries it
// (upgrade-from-released.ts); an app with nothing released says so here and runs a fresh one.
const upgrade = await prepare(appDir, gateDir, dir)
if ("skip" in upgrade) console.error(`integrate@local: NOT TESTING THE UPGRADE FROM THE LAST RELEASE: ${upgrade.skip}; the database is built fresh`)
else console.error(`integrate@local: upgrade from the last release: ${upgrade.note}`)
const composeFile = "file" in upgrade ? upgrade.file : ".bayt/process-compose.yaml"
const socket = `${dir}/pc.sock`
// Its own account of the processes, which their output does not carry (one
// it could not start says so only here).
const log = `${dir}/process-compose.log`
const pc = (more: string[]) => ["-U", "-u", socket, "-L", log, ...more]
// Every process of this run carries this, whatever group process-compose
// gives it, so one it starts while it stops, which outlives it and would hold
// the run's output open, is found and stopped (survivors()).
const tag = `INTEGRATE_LOCAL_RUN=${crypto.randomUUID()}`
const stack = new Deno.Command(pcBin, {
  args: pc(["-f", composeFile, "-f", `${host.work}/pc-logs.yaml`, "up", "--tui=false"]),
  cwd: appDir,
  clearEnv: true,
  env: { ...hostEnv, BAYT_LOCAL_WORK_DIR: stackWork, ...ports, [tag.split("=")[0]]: tag.split("=")[1] },
  stdout: "inherit",
  stderr: "inherit",
}).spawn()
let exited = false
stack.status.then(() => exited = true)

type Proc = { name: string; status: string; is_ready: string; exit_code: number; has_ready_probe: boolean }
const list = async (): Promise<Proc[] | undefined> => {
  const out = await new Deno.Command(pcBin, { args: pc(["list", "-o", "json"]), cwd: appDir, clearEnv: true, env: hostEnv, stdout: "piped", stderr: "null", signal: AbortSignal.timeout(10_000) }).output().catch(() => undefined)
  if (!out?.success) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(out.stdout))
  } catch {
    return undefined
  }
}
// The processes of this run that outlive process-compose. On Linux, those still carrying the run's
// tag in /proc. Elsewhere (macOS shows no environment), those seen below the stack's process while it
// ran (`watch`, polled with the stack's readiness and once more as it goes down), which are still
// there, running the same command: one reparented to init is found by what it was.
const known = new Map<number, string>()
const snapshot = async (): Promise<Map<number, { ppid: number; command: string }>> => {
  // From "/": a stack's own directory can go while it stops (a slot taken over once its holder died),
  // and a command spawned from a vanished cwd fails before it runs, leaving the survivors running.
  const ps = await new Deno.Command("ps", { args: ["-axo", "pid=,ppid=,command="], cwd: "/", stdout: "piped", stderr: "null" }).output()
  const all = new Map<number, { ppid: number; command: string }>()
  for (const line of new TextDecoder().decode(ps.stdout).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (m) all.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] })
  }
  return all
}
const watch = async () => {
  const all = await snapshot()
  const below = new Set([stack.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, p] of all) if (!below.has(pid) && below.has(p.ppid)) { below.add(pid); grew = true }
  }
  for (const pid of below) if (pid !== stack.pid && pid !== Deno.pid) known.set(pid, all.get(pid)!.command)
}
const survivors = async (): Promise<number[]> => {
  const found: number[] = []
  try {
    for await (const e of Deno.readDir("/proc")) {
      const pid = Number(e.name)
      if (!Number.isInteger(pid) || pid === Deno.pid) continue
      const env = await Deno.readFile(`/proc/${pid}/environ`).catch(() => undefined)
      if (env && new TextDecoder().decode(env).split("\0").includes(tag)) found.push(pid)
    }
    return found
  } catch { /* no /proc */ }
  const all = await snapshot()
  for (const [pid, command] of known) if (all.get(pid)?.command === command) found.push(pid)
  return found
}
const settled = (ms: number) => Promise.race([stack.status.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(exited), ms))])
// Whatever process-compose says or fails to say, this returns within about a minute with nothing
// of the run left: its `down` is given 20 s, then it is terminated, then killed, then whatever
// still carries the run's tag.
const down = async (failed: boolean) => {
  if (failed) {
    const text = await Deno.readTextFile(log).catch(() => "")
    console.error(`integrate@local: process-compose's log, last lines:\n${text.split("\n").slice(-60).join("\n")}`)
  }
  await watch().catch(() => {})
  // `down` itself can hang on a stack whose process failed (seen on reclaim-clone, 25 minutes):
  // given 20 s, then the stack is stopped, so a failed run fails rather than waits.
  await new Deno.Command(pcBin, { args: pc(["down"]), cwd: appDir, clearEnv: true, env: hostEnv, stdout: "null", stderr: "null", signal: AbortSignal.timeout(20_000) }).output()
    .catch(() => console.error("integrate@local: process-compose's down did not answer in 20 s"))
  if (!await settled(20_000)) {
    console.error("integrate@local: process-compose did not stop; terminating it")
    stack.kill("SIGTERM")
    if (!await settled(10_000)) stack.kill("SIGKILL")
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const left = await survivors()
    if (left.length === 0) break
    console.error(`integrate@local: ${left.length} of its processes outlived process-compose; sending ${signal}`)
    for (const pid of left) {
      try {
        Deno.kill(pid, signal)
      } catch { /* gone already */ }
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  const left = await survivors()
  if (left.length > 0) console.error(`integrate@local: ${left.length} processes survive the run: ${left.join(", ")}`)
  await Deno.remove(dir, { recursive: true }).catch(() => {})
}

// Stopped from outside, the stack goes down with it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => down(false).then(() => Deno.exit(130)))
}

// Ready: every one-shot completed, every process with a probe passing it. A
// process that failed fails the run here, as compose's --abort-on-container-failure.
const deadline = Date.now() + 15 * 60_000
let verdict: number | undefined
for (;;) {
  if (exited) {
    console.error("integrate@local: process-compose exited before the stack was ready")
    verdict = 1
    break
  }
  await watch().catch(() => {})
  const procs = await list()
  if (procs) {
    const failed = procs.find((p) => (p.status === "Completed" && p.exit_code !== 0) || p.status === "Error" || p.status === "Skipped")
    if (failed) {
      console.error(`integrate@local: ${failed.name} ${failed.status} (exit ${failed.exit_code})`)
      verdict = 1
      break
    }
    if (procs.length > 0 && procs.every((p) => p.status === "Completed" || (p.status === "Running" && (p.is_ready === "Ready" || !p.has_ready_probe)))) break
  }
  if (Date.now() > deadline) {
    console.error("integrate@local: the stack was not ready within 15 minutes")
    verdict = 1
    break
  }
  await new Promise((r) => setTimeout(r, 2000))
}

// Whatever the lint or a driver throws, the stack goes down: a verdict of 1 and the teardown below.
try {
if (verdict === undefined) {
  const url = `https://localhost:${door}`
  console.error(`integrate@local: the stack is ready at ${url} after ${Math.round((Date.now() - t0) / 1000)} s; running the visual lint`)
  // node_modules lands where the lint runs, so not in the app. The lint measures every page slowed
  // as the release gate's are (SLOW=1: omnishell's check-visual.ts, the same meaning the apps'
  // scenario runners give it), since a page that fills in after a late answer (a banner a flag
  // shows) shifts its layout on the rc preview and never on this stack's fast line. SLOW=0, or
  // another value, in the environment says otherwise; only the lint is slowed, not the drivers.
  verdict = await run(Deno.execPath(), [
    "run", "--node-modules-dir=auto", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys",
    "--unsafely-ignore-certificate-errors=localhost", lint, appDir,
  ], { cwd: dir, env: { APP_URL: url, SETTLE_TIMEOUT_MS: args.settle, SLOW: Deno.env.get("SLOW") ?? "1" } })
  if (mode === "all") {
    // The compose project's config, read as verify.nu reads it: no daemon.
    const out = await new Deno.Command("docker", { args: ["compose", "--profile", "*", "config", "--format", "json"], cwd: appDir, stdout: "piped" }).output()
    if (!out.success) fail("docker compose config failed: the drivers are not known")
    const failed: string[] = []
    for (const d of localDrivers(JSON.parse(new TextDecoder().decode(out.stdout)), url, args.omnishell)) {
      console.error(`integrate@local: ${d.name} against ${url}`)
      const code = await run(d.cmd[0], d.cmd.slice(1), { cwd: appDir, env: { MISE_LOCKED: "0", ...(miseDir ? { PATH: `${Deno.env.get("PATH")}:${miseDir}` } : {}), ...ports, ...d.env } })
      console.error(`integrate@local: ${d.name} ${code === 0 ? "passed" : `FAILED (exit ${code})`}`)
      if (code !== 0) failed.push(d.name)
    }
    if (verdict !== 0) failed.unshift("the visual lint")
    if (failed.length > 0) {
      console.error(`integrate@local: failed: ${failed.join(", ")}`)
      verdict = 1
    } else if (verdict === 0) {
      // A pass stamps the tree as it was before the run, if it still is (gcp/local-gate-key.nu).
      const after = await treeKey()
      if (!before || before !== after) {
        console.error(`integrate@local: ${before ? "the tree changed during the run" : "the tree's key cannot be read"}: the pass is not recorded`)
      } else if (!(await gateKey("stamp", before)).success) {
        console.error("integrate@local: the pass could not be stamped")
        verdict = 1
      }
    }
  }
}
} catch (e) {
  console.error(`integrate@local: ${e instanceof Error ? e.stack ?? e.message : e}`)
  verdict = 1
}
await down(verdict !== 0)
Deno.exit(verdict)
