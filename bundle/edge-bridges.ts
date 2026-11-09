// A bridge on cloudflare ([[../docs/container-bridges#Targets]]): the
// dispatcher Worker owns its container as a Durable Object class, one
// instance per bridge, reached by a binding and never by a public origin.
// The names, the bridges the emitter lists in .pronto/cluster.json, and what
// `wrangler deploy` builds the image from, read off the files bayt renders
// for the cluster target, are all decided here.
import * as path from 'node:path'
import { parse } from '@std/yaml'

/** A bridge as .pronto/cluster.json lists it (emit.cue): `build` is the
 * cluster target building the real container, whose Dockerfile and compose
 * file bayt renders at .bayt/Dockerfile.<build> and .bayt/compose.<build>.yaml. */
export interface ClusterBridge {
  name: string
  container: string
  port: number
  targets: string[]
  build: string
}

export const CLOUDFLARE = 'cloudflare'

/** The Durable Object binding and class of a bridge's container in the
 * dispatcher: `fetch-pages` is bound as BRIDGE_FETCH_PAGES, class BridgeFetchPages. */
export function bridgeNames(bridge: string): { binding: string; className: string } {
  const words = bridge.split('-')
  if (words.includes('')) throw new Error(`bridge ${bridge}: an empty segment between hyphens names no class or binding`)
  return {
    binding: `BRIDGE_${words.join('_').toUpperCase()}`,
    className: `Bridge${words.map(w => w[0].toUpperCase() + w.slice(1)).join('')}`,
  }
}

/** The app's bridges; none in a cluster.json an earlier pronto generated or
 * a program without bridges. */
export async function clusterBridges(app: string): Promise<ClusterBridge[]> {
  const { bridges = [] } = JSON.parse(await Deno.readTextFile(path.join(app, '.pronto/cluster.json'))) as { bridges?: ClusterBridge[] }
  return bridges
}

/** The bridges on cloudflare, each a class and a binding of the dispatcher
 * that no other bridge takes: `a-1b` and `a1b` are both BridgeA1b. */
export function onCloudflare(bridges: ClusterBridge[]): ClusterBridge[] {
  const chosen = bridges.filter(b => b.targets.includes(CLOUDFLARE))
  const taken = new Map<string, string>()
  for (const b of chosen) {
    for (const name of Object.values(bridgeNames(b.name))) {
      const other = taken.get(name)
      if (other !== undefined) throw new Error(`bridges ${other} and ${b.name} are both ${name} in the dispatcher: rename one`)
      taken.set(name, b.name)
    }
  }
  return chosen
}

/** What `wrangler deploy` builds and runs the container with, as bayt
 * resolved it into .bayt/compose.<build>.yaml: the frontend pin, the build
 * args beside it, and the environment, which the dispatcher's class carries. */
export interface BridgeBuild {
  syntax: string
  args: Record<string, string>
  environment: Record<string, string>
}

interface ComposeService {
  build?: { target?: string; args?: Record<string, unknown>; additional_contexts?: Record<string, unknown> }
  environment?: unknown
}

// A Cloudflare Container runs with the environment its class states, and
// `wrangler deploy` builds with the args its config states: neither has the
// shell compose expands `${…}` in at `up`.
function literal(values: Record<string, unknown>, what: string, where: string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => {
    const value = String(v)
    if (value.includes('${')) throw new Error(`${where}: the ${what} ${k} interpolates ${value}, which nothing expands on cloudflare: state the value`)
    return [k, value]
  }))
}

export async function bridgeBuild(app: string, bridge: ClusterBridge): Promise<BridgeBuild> {
  const file = `.bayt/compose.${bridge.build}.yaml`
  const compose = parse(await Deno.readTextFile(path.join(app, file))) as { services?: Record<string, ComposeService> }
  const service = Object.values(compose.services ?? {}).find(s => s.build?.target === bridge.build)
  if (service?.build === undefined) throw new Error(`${file} builds no service targeting ${bridge.build}: regenerate the app with this pronto's bayt`)
  // `docker build` as wrangler runs it has no --build-context, so a stage
  // bayt wires to another service (deps, from.ref, copy.from.ref or image,
  // incremental) has nothing to resolve against.
  const contexts = Object.keys(service.build.additional_contexts ?? {})
  if (contexts.length) {
    throw new Error(`bridge ${bridge.name}: its container ${bridge.container} builds from other contexts (${contexts.join(', ')}), which wrangler's docker build cannot be given: a container on cloudflare builds from its own Dockerfile alone, with no deps, from.ref, copy.from, or incremental build`)
  }
  // BAYT_DIR is empty in the standalone build whose context, the app dir,
  // is the one wrangler builds from.
  const { BUILDKIT_SYNTAX: syntax, BAYT_DIR: _, ...args } = service.build.args ?? {}
  if (typeof syntax !== 'string') throw new Error(`${file} names no BUILDKIT_SYNTAX for the Dockerfile ${bridge.name} is built from`)
  const environment = service.environment ?? {}
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) throw new Error(`${file}: the environment of ${bridge.build} is not a map`)
  return {
    syntax,
    args: literal(args, 'build arg', `bridge ${bridge.name}`),
    environment: literal(environment as Record<string, unknown>, 'environment variable', `bridge ${bridge.name}`),
  }
}

/** The named stages of a Dockerfile, in order, outside its heredocs: a
 * heredoc body may hold a line starting with FROM. */
function stages(lines: string[], source: string): { index: number; name: string }[] {
  const named: { index: number; name: string }[] = []
  const open: string[] = []
  for (const [index, line] of lines.entries()) {
    if (open.length) {
      if (line.trim() === open[0]) open.shift()
      continue
    }
    const stage = /^FROM\s+(?:--platform=\S+\s+)?\S+\s+AS\s+(\S+)\s*$/i.exec(line)
    if (stage) named.push({ index, name: stage[1] })
    for (const m of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/g)) open.push(m[1] ?? m[2] ?? m[3])
  }
  if (open.length) throw new Error(`${source}: the heredoc ${open[0]} never ends`)
  return named
}

/** The Dockerfile `wrangler deploy` builds, from the one bayt renders for the
 * cluster target: the container's own stages, `<build>` and any helper before
 * it (a multi-arch `fetch_*`, a `<build>_build` a finalCopy flattens), up to
 * the first packaging view (`<build>_ctxs`, `<build>_outs_ctxs` or
 * `<build>_bayt_ctxs`), since a build of the whole file would ship a scratch
 * image. Kept whole under the frontend pin the compose file names, so the
 * image is the one the cluster builds; the build context is the app
 * directory, which bayt's COPY paths are relative to. */
export async function bridgeDockerfile(app: string, bridge: ClusterBridge, build: BridgeBuild): Promise<string> {
  const source = path.join(app, '.bayt', `Dockerfile.${bridge.build}`)
  const lines = (await Deno.readTextFile(source)).split('\n')
  const named = stages(lines, source)
  const view = named.find(s => new RegExp(`^${bridge.build}(_outs|_bayt)?_ctxs$`).test(s.name))
  if (view === undefined) throw new Error(`${source}: no packaging view (${bridge.build}_ctxs, _outs_ctxs or _bayt_ctxs) follows the container's stages: regenerate the app with this pronto's bayt`)
  if (!named.some(s => s.index < view.index && s.name === bridge.build)) {
    throw new Error(`${source}: no stage is named ${bridge.build} before its packaging views, so the bridge ${bridge.name} has no image to ship`)
  }
  const first = lines.findIndex(l => l.trim() !== '' && !l.startsWith('#'))
  return `# syntax=${build.syntax}\n${lines.slice(first, view.index).join('\n').trimEnd()}\n`
}
