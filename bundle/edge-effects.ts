// Renders an edge release's src/effects.js: the app's external effects from
// services/airlock/effects.json, each bound to its handler module and target
// (bifrost or declared HTTPS origin) for mecha-edge's airlock.ts.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface EffectTarget {
  kind: 'bifrost' | 'origin'
  url?: string
}

async function resolveEffectTarget(appDir: string, name: string): Promise<EffectTarget> {
  try {
    const yaml = await Deno.readTextFile(path.join(appDir, 'services/airlock/dapr', `${name}.yaml`))
    const match = yaml.match(/-\s*name:\s*url\s*\r?\n\s*value:\s*['"]?([^'"\r\n]+)['"]?/)
    const url = match?.[1]?.trim()
    if (!url || /^https?:\/\/(bifrost|127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
      return { kind: 'bifrost' }
    }
    return { kind: 'origin', url }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { kind: 'bifrost' }
    throw e
  }
}

export async function renderEffects(app: string, appDir: string, mecha: string, outDir: string): Promise<string> {
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
    }>
  }
  const manifestText = await Deno.readTextFile(path.join(appDir, 'services/airlock/effects.json'))
  const effects = parseManifest(manifestText)
  const names = Object.keys(effects).sort()
  const imports: string[] = []
  const entries: string[] = []
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
    const target = await resolveEffectTarget(appDir, name)
    const ident = `handler_${i}`
    imports.push(`import * as ${ident} from ${JSON.stringify(fromSrc(handlerPath))}`)
    entries.push(
      `  ${JSON.stringify(name)}: effect(${JSON.stringify(decl)}, ${JSON.stringify(target)}, ${ident}),`,
    )
  }

  return `// Written by pronto's edge.ts for ${app}: the airlock effects, for the object's host import (mecha-edge's airlock.ts).
${imports.join('\n')}

const harden = (value, seen = new WeakSet()) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) for (const v of [d.value, d.get, d.set]) harden(v, seen)
  return value
}

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
}
