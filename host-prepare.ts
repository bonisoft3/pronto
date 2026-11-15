// What a host launch of an app needs around process-compose, taken from the app's own generated
// `.bayt/Taskfile.integrate.yaml` rather than written again here: mecha 0.22's host launch
// (`integrate@host`) puts a no-op `task` first on PATH (the compose's `launch:build` is the
// container build, which a host has no use for), a CA bundle for DENO_CERT, the served tree the
// door serves from (BAYT_LOCAL_SERVED_DIR), and a few variables (MISE_ENV=host among them), all in
// the nu script that Taskfile runs before it starts any process. This runs that script up to the
// line where it takes process-compose in hand, and returns the environment it built, so
// integrate@local starts the same stack the same way with its own ports, database and drivers.
import { parse } from "jsr:@std/yaml@1.0.5"

export type HostPrepared = { work: string; env: Record<string, string> }

// A `nu -c "…"` command as the task runner reads it: inside double quotes a backslash only
// escapes $, ", ` and itself.
const unquote = (cmd: string): string => {
  const body = cmd.trim().replace(/^nu -c "/, "").replace(/"$/, "")
  return body.replace(/\\([$"`\\])/g, "$1")
}

export async function hostPrepare(appDir: string, miseDir: string, base: Record<string, string>): Promise<HostPrepared> {
  const file = `${appDir}/.bayt/Taskfile.integrate.yaml`
  const task = parse(await Deno.readTextFile(file)) as { tasks?: { default?: { cmds?: unknown[] } } }
  const cmd = (task.tasks?.default?.cmds ?? []).find((c) => typeof c === "string" && c.trimStart().startsWith("nu -c \"")) as string | undefined
  if (!cmd) throw new Error(`${file} has no nu command: regenerate the app`)
  const script = unquote(cmd)
  const cut = script.indexOf("let pc_bin")
  if (cut < 0) throw new Error(`${file}: its nu command never takes process-compose in hand ("let pc_bin"): the host launch changed shape`)
  const emit = `
let p = ($env | get $path_key)
let path = (if (($p | describe) == "string") { $p } else { $p | str join (char esep) })
print $"HOSTENV=({ work: $work, path: $path, path_key: $path_key, MISE_ENV: $env.MISE_ENV, BAYT_LOCAL_SERVED_DIR: $env.BAYT_LOCAL_SERVED_DIR, BAYT_LOCAL_MOCK_AI: $env.BAYT_LOCAL_MOCK_AI, SAYT_PLATFORM: $env.SAYT_PLATFORM, DENO_NO_PROMPT: $env.DENO_NO_PROMPT, DENO_CERT: $env.DENO_CERT } | to json -r)"
`
  const out = await new Deno.Command("nu", { args: ["-c", script.slice(0, cut) + emit], cwd: appDir, clearEnv: true, env: { ...base, MISE_ENV: "host", ...(miseDir ? { PATH: `${base.PATH ?? ""}:${miseDir}` } : {}) }, stdout: "piped", stderr: "inherit" }).output()
  if (!out.success) throw new Error("the host launch's preparation (its nu script, .bayt/Taskfile.integrate.yaml) failed")
  const line = new TextDecoder().decode(out.stdout).split("\n").reverse().find((l) => l.startsWith("HOSTENV="))
  if (!line) throw new Error("the host launch's preparation printed no environment")
  const { work, path, path_key, ...env } = JSON.parse(line.slice("HOSTENV=".length))
  return { work, env: { ...env, [path_key]: path } }
}
