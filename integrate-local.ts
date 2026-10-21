// integrate@local: the cluster as host processes (.bayt/process-compose.yaml),
// and the terminal's visual lint against its door, as `integrate` runs it
// against the containers. The stack comes up, every process that serves is
// ready and every one-shot has finished, the lint runs, and the stack goes
// down whatever the lint answered; its exit code is the verdict.
//
//   deno run -A integrate-local.ts <app dir> --stub <process-compose tool stub> --omnishell <omnishell dir>
//
// The cluster's host preparation (its surface's hostPrepare) has run before
// this, in the launch@local rule's toolchain. The browser is Playwright's
// Chromium at the version the lint imports, installed once per host, with its
// system libraries where the host is Linux (a CI runner).

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
if (!app || !args.stub || !args.omnishell) {
  fail("usage: integrate-local.ts <app dir> --stub <process-compose tool stub> --omnishell <omnishell dir>")
}
const appDir = await Deno.realPath(app)
const lint = `${args.omnishell}/check-visual.ts`

const run = async (cmd: string, cmdArgs: string[], opts: Deno.CommandOptions = {}) => {
  const { code } = await new Deno.Command(cmd, { args: cmdArgs, stdout: "inherit", stderr: "inherit", ...opts }).output()
  return code
}

// The browser the lint launches, from the Playwright it imports.
const playwright = (await Deno.readTextFile(lint)).match(/npm:playwright@([0-9.]+)/)?.[1] ??
  fail(`${lint} names no npm:playwright version`)
const install = ["run", "-A", `npm:playwright@${playwright}`, "install", ...(Deno.build.os === "linux" ? ["--with-deps"] : []), "chromium"]
if (await run(Deno.execPath(), install) !== 0) fail(`playwright ${playwright} could not install chromium`)

// The door's port on the host: its variable when the caller moved it, else the
// project's own default, both as bayt wrote them for caddy.
const compose = await Deno.readTextFile(`${appDir}/.bayt/process-compose.yaml`)
const [, doorVar, doorDefault] = compose.match(/DOOR_PORT=\$\{([A-Z0-9_]+):-([0-9]+)\}/) ??
  fail("the door's port is not in .bayt/process-compose.yaml; regenerate the app")
const door = Deno.env.get(doorVar) ?? doorDefault

// process-compose with its API on a socket of its own, which `list` reads.
const dir = await Deno.makeTempDir({ prefix: "integrate-local." })
const socket = `${dir}/pc.sock`
const pc = (more: string[]) => ["tool-stub", args.stub, "-U", "-u", socket, ...more]
const stack = new Deno.Command("mise", {
  args: pc(["-f", ".bayt/process-compose.yaml", "up", "--tui=false"]),
  cwd: appDir,
  env: { MISE_LOCKED: "0" },
  stdout: "inherit",
  stderr: "inherit",
}).spawn()
let exited = false
stack.status.then(() => exited = true)

type Proc = { name: string; status: string; is_ready: string; exit_code: number; has_ready_probe: boolean }
const list = async (): Promise<Proc[] | undefined> => {
  const out = await new Deno.Command("mise", { args: pc(["list", "-o", "json"]), cwd: appDir, env: { MISE_LOCKED: "0" }, stdout: "piped", stderr: "null" }).output()
  if (!out.success) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(out.stdout))
  } catch {
    return undefined
  }
}
const down = async () => {
  await new Deno.Command("mise", { args: pc(["down"]), cwd: appDir, env: { MISE_LOCKED: "0" }, stdout: "null", stderr: "null" }).output()
  await stack.status
  await Deno.remove(dir, { recursive: true }).catch(() => {})
}

// Stopped from outside, the stack goes down with it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => down().then(() => Deno.exit(130)))
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

if (verdict === undefined) {
  const url = `https://localhost:${door}`
  console.error(`integrate@local: the stack is ready at ${url}; running the visual lint`)
  // node_modules lands where the lint runs, so not in the app.
  verdict = await run(Deno.execPath(), [
    "run", "--node-modules-dir=auto", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-sys",
    "--unsafely-ignore-certificate-errors=localhost", lint, appDir,
  ], { cwd: dir, env: { APP_URL: url } })
}
await down()
Deno.exit(verdict)
