// Renders an edge release's src/effects.js: the app's external effects from
// services/airlock/effects.json, each bound to its handler module and target
// (tsbifrost, declared HTTPS origin, or a bridge's container) for mecha-edge's
// airlock.ts.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bridgeNames, CLOUDFLARE, clusterBridges, onCloudflare } from './edge-bridges.ts'

export type EffectTarget =
  | { kind: 'tsbifrost' | 'origin'; url?: string }
  | { kind: 'bridge'; bridge: string }
  | { kind: 'container'; bridge: string; binding: string }

// A bridge on cloudflare is the dispatcher's own container, reached by its
// binding (edge-bridges.ts) on the port its class holds; any other is an
// internal address the edge never dials, and the object settles its effect
// failed (mecha-edge's airlock.ts).
function bridgeTarget(name: string, bridge: { name: string; targets: string[] }, containers: Set<string>): EffectTarget {
  const container = containers.has(bridge.name)
  if (bridge.targets.includes(CLOUDFLARE) !== container) {
    throw new Error(`effect ${name}: effects.json and .pronto/cluster.json disagree on whether the bridge ${bridge.name} is on cloudflare: regenerate the app`)
  }
  return container ? { kind: 'container', bridge: bridge.name, binding: bridgeNames(bridge.name).binding } : { kind: 'bridge', bridge: bridge.name }
}

/** The release's effects twice over: `effects`, each declaration and target
 * bound to its handler module, which only the dispatcher Worker imports, and
 * `declarations`, the declarations and targets alone, which the object reads
 * without loading a handler into its isolate. */
export async function renderEffects(app: string, appDir: string, mecha: string, outDir: string): Promise<{ effects: string; declarations: string }> {
  const { parseManifest } = await import(pathToFileURL(path.join(mecha, 'services/airlock/reentry.ts')).href) as {
    parseManifest: (text: string) => Record<string, {
      table: string
      field: string
      state: string
      onDone: string
      onError: string
      row: string[]
      idempotent: boolean
      reentry?: 'reconcile' | 'unknown' | 'repeat'
      attempts: number
      handler: string
      secrets?: string[]
      credential?: { header: string; scheme?: string; secret: string }
      endowments?: string[]
      edgeOrigin?: string
      bridge?: { name: string; targets: string[]; simulated: boolean }
    }>
  }
  const manifestText = await Deno.readTextFile(path.join(appDir, 'services/airlock/effects.json'))
  const effects = parseManifest(manifestText)
  const names = Object.keys(effects).sort()
  const imports: string[] = []
  const entries: string[] = []
  const declared: string[] = []
  const containers = new Set(onCloudflare(await clusterBridges(appDir)).map(b => b.name))
  const srcDir = path.join(outDir, 'src')
  const fromSrc = (p: string) => {
    const rel = path.relative(srcDir, p).replaceAll('\\', '/')
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  for (const [i, name] of names.entries()) {
    const decl = effects[name]
    if (path.isAbsolute(decl.handler) || decl.handler.split(/[\\/]/).includes('..')) {
      throw new Error(`effect ${name}: unsafe handler path ${decl.handler}`)
    }
    const handlerPath = path.join(appDir, decl.handler)
    await Deno.stat(handlerPath)
    const target: EffectTarget = decl.bridge !== undefined ? bridgeTarget(name, decl.bridge, containers) : decl.edgeOrigin ? { kind: 'origin', url: decl.edgeOrigin } : { kind: 'tsbifrost' }
    const ident = `handler_${i}`
    imports.push(`import * as ${ident} from ${JSON.stringify(fromSrc(handlerPath))}`)
    entries.push(
      `  ${JSON.stringify(name)}: effect(${JSON.stringify(decl)}, ${JSON.stringify(target)}, ${ident}),`,
    )
    declared.push(`  ${JSON.stringify(name)}: { declaration: ${JSON.stringify(decl)}, target: ${JSON.stringify(target)} },`)
  }
  // A handler here runs in the Worker's own realm, so the endowments it declares
  // past the platform's globals are defined for it: Pdf, mecha's one frozen call.
  if (names.some((n) => effects[n].endowments?.includes('Pdf'))) {
    imports.push(`import { Pdf } from ${JSON.stringify(fromSrc(path.join(mecha, 'services/airlock/pdf.ts')))}`)
    imports.push(`Object.defineProperty(globalThis, 'Pdf', { value: Object.freeze(Pdf) })`)
  }

  const harden = `const harden = (value, seen = new WeakSet()) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) for (const v of [d.value, d.get, d.set]) harden(v, seen)
  return value
}`

  const handlers = `// Written by pronto's edge.ts for ${app}: the airlock effects and their handlers, for the dispatcher Worker (mecha-edge's dispatch.ts).
${imports.join('\n')}

${harden}

const effect = (declaration, target, mod) => {
  if (typeof mod.issue !== 'function') throw new TypeError(\`effect \${declaration.handler} exports no issue function\`)
  if (mod.reconcile !== undefined && typeof mod.reconcile !== 'function') throw new TypeError(\`effect \${declaration.handler} reconcile export is not a function\`)
  harden(declaration)
  harden(target)
  return {
    declaration,
    target,
    issue: (input, sink, secrets) => mod.issue(harden(input), harden(sink), harden(secrets)),
    ...(typeof mod.reconcile === 'function'
      ? { reconcile: (input, sink, secrets) => mod.reconcile(harden(input), harden(sink), harden(secrets)) }
      : {}),
  }
}

export default {
${entries.join('\n')}
}
`
  const declarations = `// Written by pronto's edge.ts for ${app}: the airlock effects' declarations and targets, for the object (mecha-edge's airlock.ts).
${harden}

export default harden({
${declared.join('\n')}
})
`
  return { effects: handlers, declarations }
}
