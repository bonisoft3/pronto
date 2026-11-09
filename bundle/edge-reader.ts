import * as path from 'node:path'

export async function writeEdgeReader(out: string, mecha: string, definitions: readonly unknown[], name: string) {
  const directory = path.join(out, 'compute/reader')
  const inputs: [string, string][] = []
  const fromReader = (file: string) => {
    const relative = path.relative(directory, file).replaceAll('\\', '/')
    return relative.startsWith('.') ? relative : `./${relative}`
  }
  const hash = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  async function collect(source: string, relative: string, copy: boolean) {
    for await (const entry of Deno.readDir(source)) {
      const file = path.join(source, entry.name), target = path.join(relative, entry.name)
      if (entry.isDirectory) await collect(file, target, copy)
      else if (entry.isFile) {
        const bytes = await Deno.readFile(file)
        inputs.push([target.replaceAll('\\', '/'), await hash(bytes)])
        if (copy) { await Deno.mkdir(path.dirname(path.join(directory, target)), { recursive: true }); await Deno.writeFile(path.join(directory, target), bytes) }
      }
    }
  }
  for (const pkg of ['pglite-workerd', 'compute-snapshot']) await collect(path.join(mecha, 'packages', pkg, 'src'), `runtime/packages/${pkg}/src`, true)
  const reader = 'runtime/packages/mecha-edge/src/compute-reader.ts'
  await Deno.mkdir(path.dirname(path.join(directory, reader)), { recursive: true })
  await Deno.copyFile(path.join(mecha, 'packages/mecha-edge/src/compute-reader.ts'), path.join(directory, reader))
  inputs.push([reader, await hash(await Deno.readFile(path.join(directory, reader)))])
  await collect(path.join(out, 'pglite'), '../../pglite', false)
  inputs.push(['../../src/compute-machine.js', await hash(await Deno.readFile(path.join(out, 'src/compute-machine.js')))])
  const entry = `import { computeReader } from './${reader}';
import machines from ${JSON.stringify(fromReader(path.join(out, 'src/compute-machine.js')))};
import pgliteWasm from ${JSON.stringify(fromReader(path.join(out, 'pglite/pglite.wasm')))};
import initdbWasm from ${JSON.stringify(fromReader(path.join(out, 'pglite/initdb.wasm')))};
import pgliteData from ${JSON.stringify(fromReader(path.join(out, 'pglite/pglite.data')))};
import icu from ${JSON.stringify(fromReader(path.join(out, 'pglite/icu-root.tgz')))};
export const ComputeReader = computeReader({pgliteWasm,initdbWasm,pgliteData,icu},${JSON.stringify(definitions)},machines.compute_batch);
export default { fetch() { return new Response(null,{status:404}) } };
`
  const configuration = {
    main: 'worker.ts', compatibility_date: '2026-09-01', workers_dev: false, limits: { cpu_ms: 300000 },
    durable_objects: { bindings: [{ name: 'READER', class_name: 'ComputeReader' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ComputeReader'] }],
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }, { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false }],
    alias: { '@electric-sql/pglite': '../../pglite/index.js', '@electric-sql/pglite/basefs': '../../pglite/fs/base.js' },
  }
  inputs.sort(([a], [b]) => a.localeCompare(b))
  const digest = await hash(new TextEncoder().encode(JSON.stringify([entry, configuration, inputs])))
  const worker = `${name.slice(0, 40)}-reader-${digest.slice(0, 12)}`
  await Deno.writeTextFile(path.join(directory, 'worker.ts'), entry)
  await Deno.writeTextFile(path.join(directory, 'wrangler.jsonc'), JSON.stringify({ ...configuration, name: worker }, null, 2))
  return { name: 'COMPUTE_READER', class_name: 'ComputeReader', script_name: worker }
}
