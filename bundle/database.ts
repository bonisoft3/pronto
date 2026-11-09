import { pg_ivm } from '@electric-sql/pglite-pg_ivm'
import { createDatabase } from 'mecha-browser/src/database.ts'

/** Where PGlite's files sit beside the page: same-origin addresses, named by their content. */
export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
  ivm: string
}

const load = async (href: string): Promise<ArrayBuffer> => {
  const res = await fetch(href)
  if (!res.ok) throw new Error(`${href}: ${res.status}`)
  return res.arrayBuffer()
}

export async function createPageDatabase(assets: DatabaseAssets) {
  const [wasm, data, initdb, icu, ivm] = await Promise.all([load(assets.wasm), load(assets.data), load(assets.initdb), load(assets.icu), load(assets.ivm)])
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    extensions: { pg_ivm: { name: pg_ivm.name, setup: async (_db, options) => ({
      emscriptenOpts: { ...options, preRun: [...options.preRun, (module: { pg_extensions: Record<string, Promise<Blob>> }) => {
        module.pg_extensions.pg_ivm = Promise.resolve(new Blob([ivm]))
      }] },
    }) } },
    icuDataDir: new Blob([icu]),
  })
}
