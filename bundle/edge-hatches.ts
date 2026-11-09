import * as path from 'node:path'
export interface EdgeHatchSpec {
  name: string
  edge: {
    src: string
    route: string
    environment?: string[]
    secrets?: string[]
    publicAttributes: Record<string, string>
    email?: { name: string; recipients: string[] }
  }
}
export function validateHatches(hatches: EdgeHatchSpec[]) {
  const routes = new Set<string>()
  const bindings = new Set<string>()
  const attributes = new Map<string, string>()
  const reserved = new Set(['CLUSTER', 'ASSETS', 'CF_VERSION_METADATA', 'IMPORT_TOKEN', 'JWT_SECRET', 'CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_KEY_TOKEN'])
  const environment = new Set(hatches.flatMap(h => h.edge.environment ?? []))
  const secrets = new Set(hatches.flatMap(h => h.edge.secrets ?? []))
  for (const name of [...environment, ...secrets]) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || reserved.has(name)) throw new Error(`Invalid hatch environment binding: ${name}`)
    if (environment.has(name) && secrets.has(name)) throw new Error(`Hatch binding is both a setting and a secret: ${name}`)
  }
  for (const { edge } of hatches) {
    if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(edge.route) || /^\/(auth|crud|electric|import|poke|blobs|img|rtc-ice)$/.test(edge.route)) throw new Error('Invalid hatch route')
    if (routes.has(edge.route)) throw new Error(`Duplicate hatch route: ${edge.route}`)
    routes.add(edge.route)
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.js$/.test(edge.src) || edge.src.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid hatch source')
    if (edge.email) {
      if (reserved.has(edge.email.name) || environment.has(edge.email.name) || secrets.has(edge.email.name)) throw new Error(`Conflicting email binding: ${edge.email.name}`)
      if (bindings.has(edge.email.name)) throw new Error(`Duplicate email binding: ${edge.email.name}`)
      if (!/^[A-Z][A-Z0-9_]*$/.test(edge.email.name) || !edge.email.recipients.length || edge.email.recipients.some(r => !/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(r))) throw new Error('Invalid email binding')
      bindings.add(edge.email.name)
    }
    for (const [key, value] of Object.entries(edge.publicAttributes)) {
      if (!/^data-[a-z][a-z0-9-]*$/.test(key) || /[<>&"']/.test(value)) throw new Error('Invalid public hatch attribute')
      if (attributes.has(key) && attributes.get(key) !== value) throw new Error(`Conflicting hatch attribute: ${key}`)
      attributes.set(key, value)
    }
  }
}
export async function readEdgeHatches(app: string): Promise<EdgeHatchSpec[]> {
  let hatches: EdgeHatchSpec[]
  try { hatches = JSON.parse(await Deno.readTextFile(path.join(app, '.pronto/edge-hatches.json'))) }
  catch (e) { if (e instanceof Deno.errors.NotFound) return []; throw e }
  validateHatches(hatches)
  for (const { edge } of hatches) {
    const source = path.resolve(app, edge.src)
    const real = await Deno.realPath(source)
    if (!real.startsWith(`${await Deno.realPath(app)}${path.sep}`)) throw new Error('Hatch source escapes app')
  }
  return hatches
}
export async function applyHatchAttributes(directory: string, hatches: EdgeHatchSpec[]) {
  const attrs = new Map(hatches.flatMap(h => Object.entries(h.edge.publicAttributes)))
  if (!attrs.size) return
  const found = new Set<string>()
  async function visit(directory: string) {
    for await (const entry of Deno.readDir(directory)) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory) await visit(file)
      else if (entry.isFile && entry.name.endsWith('.html')) {
        let html = await Deno.readTextFile(file)
        for (const [key, value] of attrs) {
          html = html.replaceAll(new RegExp(`(?<=\\s)${key}="[^"]*"`, 'g'), () => {
            found.add(key)
            return `${key}="${value}"`
          })
        }
        await Deno.writeTextFile(file, html)
      }
    }
  }
  await visit(directory)
  for (const key of attrs.keys()) if (!found.has(key)) throw new Error(`Missing public hatch attribute: ${key}`)
}

export async function hatchEnvironment(directory: string, get: (name: string) => string | undefined): Promise<Record<string, string>> {
  let names: string[]
  try { names = JSON.parse(await Deno.readTextFile(path.join(directory, 'edge-environment.json'))) }
  catch (e) { if (e instanceof Deno.errors.NotFound) return {}; throw e }
  const values: Record<string, string> = {}
  for (const name of names) {
    const value = get(name)
    if (!value?.trim()) throw new Error(`Missing required edge hatch setting: ${name}`)
    values[name] = value
  }
  return values
}

// A declared secret is the Worker's own, never the publisher's: refuse a release
// that would serve without one. A first deploy and a temporary account have
// nothing to list, and there the hatch's own refusal at its route is the failure.
export async function refuseMissingHatchSecrets(
  { directory, configs, temporary, deployedBefore, wrangler }: {
    directory: string
    configs: string[]
    temporary: boolean
    deployedBefore: (config: string) => Promise<boolean>
    wrangler: (args: string[]) => Promise<string>
  },
): Promise<void> {
  if (temporary) return
  let names: string[]
  try { names = JSON.parse(await Deno.readTextFile(path.join(directory, 'edge-secrets.json'))) }
  catch (e) { if (e instanceof Deno.errors.NotFound) return; throw e }
  if (!names.length) return
  for (const config of configs) {
    if (!await deployedBefore(config)) continue
    const bindings = JSON.parse(await wrangler(['secret', 'list', '--config', config, '--format', 'json'])) as { name: string }[]
    const missing = names.filter(name => !bindings.some(binding => binding.name === name))
    if (missing.length) throw new Error(`Worker secrets missing for ${config}: ${missing.join(', ')}. Set them in the dashboard (Settings > Variables and Secrets) or with wrangler secret put; a release never carries them.`)
  }
}
