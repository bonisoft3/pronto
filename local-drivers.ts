// The drivers release@gcp's gate runs against its `rc` preview (gcp/verify.nu),
// as host commands against a stack on this machine: integrate-local.ts runs
// them when INTEGRATE_LOCAL_DRIVERS=all, which release@gcp sets for its local
// pre-gate, so a scenario that would fail on the preview fails here first,
// before anything is built, pushed or deployed (docs/release-targets.md#gcp).
//
// A driver is what verify.nu names one: a service of the app's compose project
// whose environment reads APP_URL and whose scale is not 0. Each runs its own
// command from the app's directory, as its container runs it from its working
// directory there, with APP_URL (and ORIGIN, where it reads one) at the local
// door; omnishell's files, at /omnishell in its image, are the toolchain's.
// omnishell's visual lint is the one integrate-local.ts already runs, so it is
// left out here rather than run twice.

export type Driver = { name: string; cmd: string[]; env: Record<string, string> }

type Service = {
  environment?: Record<string, unknown> | null
  scale?: number
  entrypoint?: string[] | null
  command?: string[] | null
}

const lint = "/omnishell/check-visual.ts"

export function localDrivers(config: { services?: Record<string, Service> }, url: string, omnishell: string): Driver[] {
  const services = config.services ?? {}
  const names = Object.keys(services)
    .filter((n) => services[n].environment?.APP_URL != null && (services[n].scale ?? 1) !== 0)
    .sort()
  if (names.length === 0) throw new Error("no service of the app reads APP_URL")
  return names.flatMap((name) => {
    const s = services[name]
    const cmd = [...(s.entrypoint ?? []), ...(s.command ?? [])]
    if (cmd.length === 0) throw new Error(`${name} reads APP_URL but names no command`)
    if (cmd.includes(lint)) return []
    // The host the container reached the app at (compose's door, such as
    // caddy), wherever a command names it, is localhost here.
    const host = new URL(String(s.environment!.APP_URL)).hostname
    const local = cmd.map((a) =>
      a.startsWith("/omnishell/") ? `${omnishell}/${a.slice("/omnishell/".length)}` : a.replace(`=${host}`, "=localhost")
    )
    const env = Object.fromEntries(Object.entries(s.environment!).map(([k, v]) => [k, String(v ?? "")]))
    env.APP_URL = url
    if ("ORIGIN" in env) env.ORIGIN = url
    return [{ name, cmd: local, env }]
  })
}
