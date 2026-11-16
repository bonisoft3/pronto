// A bridge on cloudflare ([[../docs/container-bridges#Targets]]): the
// dispatcher Worker owns its container as a Durable Object class, one
// instance per bridge, reached by a binding and never by a public origin.
// The names, the bridges the emitter lists in .pronto/cluster.json, and what
// `wrangler deploy` builds the image from, read off the files bayt renders
// for the cluster target, are all decided here.
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from '@std/yaml'
import { PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE } from './cloudflare-runtime.ts'

export type BridgeInstanceType = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'

/** A bridge as .pronto/cluster.json lists it (emit.cue): `build` is the
 * cluster target building the real container, whose Dockerfile and compose
 * file bayt renders at .bayt/Dockerfile.<build> and .bayt/compose.<build>.yaml. */
export interface ClusterBridge {
  name: string
  container: string
  port: number
  targets: string[]
  instance_type?: BridgeInstanceType
  build: string
  /** An isolate hatch's bridge ([[../docs/isolate-hatches]]): on cloudflare a
   * Worker of its own, not a Container. */
  isolate?: { entrypoint: string; files: string[]; memory: number; build: string }
}

export const CLOUDFLARE = 'cloudflare'

/** A bridge's binding in the dispatcher, a container's or an isolate's:
 * `fetch-pages` is bound as BRIDGE_FETCH_PAGES. */
export function bridgeBinding(bridge: string): string {
  return `BRIDGE_${bridge.replaceAll('-', '_').toUpperCase()}`
}

/** The Durable Object binding and class of a bridge's container in the
 * dispatcher: `fetch-pages` is bound as BRIDGE_FETCH_PAGES, class BridgeFetchPages. */
export function bridgeNames(bridge: string): { binding: string; className: string } {
  const words = bridge.split('-')
  if (words.includes('')) throw new Error(`bridge ${bridge}: an empty segment between hyphens names no class`)
  return {
    binding: bridgeBinding(bridge),
    className: `Bridge${words.map(w => w[0].toUpperCase() + w.slice(1)).join('')}`,
  }
}

/** The app's bridges; none in a cluster.json an earlier pronto generated or
 * a program without bridges. */
export async function clusterBridges(app: string): Promise<ClusterBridge[]> {
  const { bridges = [] } = JSON.parse(await Deno.readTextFile(path.join(app, '.pronto/cluster.json'))) as { bridges?: ClusterBridge[] }
  return bridges
}

/** The bridges on cloudflare, each a binding of the dispatcher, and a
 * container's a class of it too, that no other bridge takes: containers
 * `a-1b` and `a1b` are both BridgeA1b. An isolate is a Worker of its own,
 * no class. */
export function onCloudflare(bridges: ClusterBridge[]): ClusterBridge[] {
  const chosen = bridges.filter(b => b.targets.includes(CLOUDFLARE))
  const taken = new Map<string, string>()
  for (const b of chosen) {
    for (const name of b.isolate === undefined ? Object.values(bridgeNames(b.name)) : [bridgeBinding(b.name)]) {
      const other = taken.get(name)
      if (other !== undefined) throw new Error(`bridges ${other} and ${b.name} are both ${name} in the dispatcher: rename one`)
      taken.set(name, b.name)
    }
  }
  return chosen
}

/** An isolate's Worker, named after the dispatcher that binds it. A name past
 * Cloudflare's 63 characters keeps its head and ends in a hash of the whole,
 * so any bridge name the schema accepts names a Worker, and no two differ
 * only past the cut. */
export function isolateWorkerName(dispatcher: string, bridge: string): string {
  const name = `${dispatcher}-${bridge}`
  if (name.length <= 63) return name
  return `${name.slice(0, 54).replace(/-+$/, '')}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

/** An isolate bridge's Worker, written under airlock/isolates/<bridge>: the
 * module built as every release builds it (libraries/mecha's #IsolateBuild,
 * carried in .pronto/cluster.json), its entry the Worker's main and the rest,
 * WebAssembly among it, uploaded as modules beside it, with wrangler's own
 * bundling off, so what deploys is that build. Answers the config's path
 * under `out`, for the publish to deploy before the dispatcher binding it. */
export async function writeIsolateWorker(out: string, app: string, bridge: ClusterBridge, name: string): Promise<string> {
  const isolate = bridge.isolate
  if (isolate === undefined) throw new Error(`bridge ${bridge.name} is no isolate's`)
  const dir = path.join(out, 'airlock/isolates', bridge.name)
  const built = await new Deno.Command(Deno.execPath(), {
    args: ['eval', '--no-config', isolate.build],
    env: { ISOLATE_ROOT: app, ISOLATE_OUT: dir, ISOLATE_ENTRYPOINT: isolate.entrypoint, ISOLATE_FILES: JSON.stringify(isolate.files) },
    stdout: 'inherit', stderr: 'inherit',
  }).output()
  if (!built.success) throw new Error(`isolate ${bridge.name}: building ${isolate.entrypoint} failed`)
  await Deno.writeTextFile(path.join(dir, 'wrangler.jsonc'), JSON.stringify({
    name,
    main: 'entry.js',
    compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js'] }, { type: 'CompiledWasm', globs: ['**/*.wasm'] }],
  }, null, 2) + '\n')
  return path.relative(out, path.join(dir, 'wrangler.jsonc')).replaceAll('\\', '/')
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
