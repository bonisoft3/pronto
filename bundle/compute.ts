import * as path from 'node:path'
import { encodeBase64 } from '@std/encoding/base64'
import { renderMachines } from './edge-machines.ts'
import { batchMachine } from '../compute/machine.ts'

type Spec = { name: string; file: string; wasm: string[]; feldera?: string; steps?: string; to: string[]; sinkWrites?: Record<string, 'replace' | 'upsert'>; onComplete?: string; [key: string]: unknown }
export type PackagedComputation = { spec: Spec; compiled: object; reads: string[]; queries: Record<string, string>; queryStages?: Record<string, {sql: string; stages: {name: string; sql: string}[]}>; version: string }
const workerTrust = `if (globalThis.trustedTypes) trustedTypes.createPolicy('default', { createScript(source, _type, sink) { if (sink !== 'eval' && sink !== 'Function') throw new TypeError('untrusted worker script sink: ' + sink); return source; } });\n`
const inside = (root: string, file: string) => {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`unsafe computation file: ${file}`)
  return path.join(root, file)
}
export async function computationPackages(app: string, mecha: string): Promise<PackagedComputation[]> {
  const cluster = JSON.parse(await Deno.readTextFile(path.join(app, '.pronto/cluster.json')))
  if (!Array.isArray(cluster.computations)) throw new Error('generate this app before packaging its computations')
  if (!cluster.computations.length) return []
  const specs = cluster.computations.map((s: Spec) => ({ ...s, file: inside(app, s.file), wasm: s.wasm.map((f) => inside(app, f)), ...(s.feldera ? { feldera: inside(app, s.feldera) } : {}), ...(s.steps ? { steps: inside(app, s.steps) } : {}) }))
  const result = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', '--unstable-worker-options', '--config', path.join(mecha, 'services/compute/deno.json'), path.join(mecha, 'services/compute/snapshot-service.ts'), '--package'],
    env: { COMPUTATIONS: JSON.stringify(specs) }, stdout: 'piped', stderr: 'inherit',
  }).output()
  if (!result.success) throw new Error('computation admission failed')
  return JSON.parse(new TextDecoder().decode(result.stdout))
}
export const computationDefinitions = (programs: PackagedComputation[]) => programs.map(({ spec, reads, version }) => ({
  name: spec.name, version, reads, to: spec.to, ...(spec.onComplete ? { onComplete: spec.onComplete } : {}),
  ...(spec.sinkWrites ? { sinkWrites: spec.sinkWrites } : {}),
}))
export async function computationMachine(omnishell: string): Promise<string> {
  const work = await Deno.makeTempDir({ prefix: 'compute-machine-' })
  try {
    await Deno.copyFile(new URL('../compute/rules.js', import.meta.url), path.join(work, 'rules.js'))
    return await renderMachines('duckstream', work, omnishell, { compute_batch: { reducer: batchMachine.machine as any, rules: 'rules.js' } })
  } finally { await Deno.remove(work, { recursive: true }) }
}
export async function browserComputations(programs: PackagedComputation[], mecha: string) {
  if (!programs.length) return undefined
  const gzip = async (bytes: Uint8Array<ArrayBuffer>) => encodeBase64(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).bytes())
  const work = await Deno.makeTempDir({ prefix: 'compute-browser-' })
  const bundle = async (file: string) => {
    const dest = path.join(work, `${path.basename(file)}.js`)
    const result = await new Deno.Command(Deno.execPath(), { args: ['bundle', '--platform', 'browser', '--format', 'esm', '--config', path.join(mecha, 'services/compute/deno.json'), '--frozen', '--output', dest, file], stdout: 'inherit', stderr: 'inherit' }).output()
    if (!result.success) throw new Error(`browser computation worker failed: ${file}`)
    return await gzip(new TextEncoder().encode(workerTrust + await Deno.readTextFile(dest)))
  }
  try {
    // Resolving via Deno uses its lock/cache; these are the lake's pinned engine assets.
    const info = await new Deno.Command(Deno.execPath(), { args: ['info', '--no-config', '--node-modules-dir=none', '--json', 'npm:@duckdb/duckdb-wasm@1.33.1-dev57.0'], stdout: 'piped', stderr: 'inherit' }).output()
    if (!info.success) throw new Error('cannot resolve the pinned browser DuckDB')
    const cache = await new Deno.Command(Deno.execPath(), { args: ['info', '--json'], stdout: 'piped', stderr: 'inherit' }).output()
    if (!cache.success) throw new Error('cannot locate the Deno cache')
    const dist = path.join(JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir, 'npm/registry.npmjs.org/@duckdb/duckdb-wasm/1.33.1-dev57.0/dist')
    const extension = async (name: string, expected: string) => {
      const response = await fetch(`https://extensions.duckdb.org/v1.5.4/wasm_eh/${name}.duckdb_extension.wasm`)
      if (!response.ok) throw new Error(`${name} extension download failed: ${response.status}`)
      const data = new Uint8Array(await response.arrayBuffer())
      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
      if (checksum !== expected) throw new Error(`DuckDB ${name} extension checksum mismatch`)
      return gzip(data)
    }
    return {
      programs: await Promise.all(programs.map(async (p) => ({ ...p, wasm: Object.fromEntries(await Promise.all(p.spec.wasm.map(async (file) => [path.basename(file, '.wasm'), encodeBase64(await Deno.readFile(file))]))) }))),
      assets: {
        json: await extension('json', '993b19f7929cc305b2529c548f2842e8e7a5b112d1c88f31c84798b51901ca16'),
        icu: await extension('icu', 'ecdbbb29331f72103b8eb227db5792f186b191a4f7a359db8dda9919b0a736de'),
        duckdb: await gzip(new TextEncoder().encode(workerTrust + await Deno.readTextFile(path.join(dist, 'duckdb-browser-eh.worker.js')))),
        wasm: await gzip(await Deno.readFile(path.join(dist, 'duckdb-eh.wasm'))),
        cage: await bundle(path.join(mecha, 'services/compute/cage.ts')),
        job: await bundle(path.join(mecha, 'services/compute/job.ts')),
      },
    }
  } finally { await Deno.remove(work, { recursive: true }) }
}
